// src/routes/messages.js — Real Messaging System
// Endpoints:
//   GET    /api/messages/conversations          — list user's conversations
//   POST   /api/messages/conversations          — start or get conversation
//   GET    /api/messages/conversations/:id      — get conversation + messages
//   GET    /api/messages/conversations/:id/messages  — messages (with since= polling)
//   POST   /api/messages/conversations/:id/messages  — send message
//   PATCH  /api/messages/conversations/:id/read     — mark all as read
//   DELETE /api/messages/conversations/:id          — archive conversation

'use strict';
const router     = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, query: qv, validationResult } = require('express-validator');
const { query }  = require('../db');
const { authenticate } = require('../middleware/auth');
const { ok, fail } = require('../utils');
const { createNotification, sendSMS } = require('../services/notifications');
const logger = require('../services/logger');

// ── GET /api/messages/conversations ────────────────────────
// Returns all conversations for the logged-in user, newest first
router.get('/conversations', authenticate, async (req, res) => {
  try {
    const uid = req.user.id;
    const { rows } = await query(`
      SELECT
        c.*,
        l.title  AS listing_title,
        l.area   AS listing_area,
        li.url   AS listing_image,
        -- other party details
        CASE WHEN c.tenant_id = $1 THEN ull.full_name   ELSE utt.full_name   END AS other_name,
        CASE WHEN c.tenant_id = $1 THEN ull.avatar_url  ELSE utt.avatar_url  END AS other_avatar,
        CASE WHEN c.tenant_id = $1 THEN ull.id          ELSE utt.id          END AS other_id,
        CASE WHEN c.tenant_id = $1 THEN c.unread_tenant ELSE c.unread_landlord END AS unread_count
      FROM conversations c
      JOIN users utt   ON c.tenant_id   = utt.id
      JOIN users ull   ON c.landlord_id = ull.id
      LEFT JOIN listings l ON c.listing_id = l.id
      LEFT JOIN listing_images li ON li.listing_id = l.id AND li.is_cover = true
      WHERE (c.tenant_id = $1 OR c.landlord_id = $1)
        AND c.status = 'active'
      ORDER BY c.last_message_at DESC
      LIMIT 50
    `, [uid]);

    return ok(res, { conversations: rows });
  } catch (e) {
    logger.error('GET /conversations error', { error: e.message });
    return fail(res, 'Failed to load conversations', 500);
  }
});

// ── POST /api/messages/conversations ───────────────────────
// Start a new conversation OR return existing one (idempotent)
router.post('/conversations', authenticate, [
  body('landlord_id').notEmpty().withMessage('landlord_id required'),
  body('listing_id').optional().isString(),
  body('subject').optional().trim().isLength({ max: 200 }),
  body('initial_message').optional().trim().isLength({ min: 1, max: 2000 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  const uid = req.user.id;
  const { landlord_id, listing_id, subject, initial_message } = req.body;

  // Tenant starts conversation — landlord can also initiate (reversed roles)
  let tenant_id = uid;
  let ll_id     = landlord_id;

  // If current user IS a landlord and recipient is a tenant, flip
  if (req.user.role === 'landlord') {
    tenant_id = landlord_id; // landlord_id param is actually the tenant in this case
    ll_id     = uid;
  }

  try {
    // Check if conversation already exists
    const existing = await query(
      `SELECT * FROM conversations WHERE tenant_id=$1 AND landlord_id=$2 AND listing_id IS NOT DISTINCT FROM $3`,
      [tenant_id, ll_id, listing_id || null]
    );

    let conv;
    if (existing.rows.length > 0) {
      conv = existing.rows[0];
    } else {
      // Verify landlord exists
      const llCheck = await query('SELECT id, full_name, phone, role FROM users WHERE id=$1', [ll_id]);
      if (!llCheck.rows.length) return fail(res, 'Recipient not found', 404);

      const convId = 'cnv_' + uuidv4().replace(/-/g, '').slice(0, 12);
      const ins = await query(`
        INSERT INTO conversations (id, tenant_id, landlord_id, listing_id, subject, last_message_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        RETURNING *
      `, [convId, tenant_id, ll_id, listing_id || null, subject || null]);
      conv = ins.rows[0];
    }

    // Send initial message if provided
    if (initial_message && initial_message.trim()) {
      const msgId = 'msg_' + uuidv4().replace(/-/g, '').slice(0, 12);
      await query(`
        INSERT INTO messages (id, conversation_id, sender_id, content, created_at)
        VALUES ($1,$2,$3,$4,NOW())
      `, [msgId, conv.id, uid, initial_message.trim()]);

      // Update conversation
      await query(`
        UPDATE conversations
        SET last_message=$1, last_message_at=NOW(),
            ${uid === tenant_id ? 'unread_landlord = unread_landlord + 1' : 'unread_tenant = unread_tenant + 1'}
        WHERE id=$2
      `, [initial_message.trim().slice(0, 100), conv.id]);

      // Notify the other party
      const otherId = uid === tenant_id ? ll_id : tenant_id;
      const senderName = req.user.full_name || 'Someone';
      await createNotification(
        otherId, 'new_message', `New message from ${senderName}`,
        initial_message.trim().slice(0, 100),
        { conversation_id: conv.id }
      );

      // SMS if phone is available (non-blocking)
      const otherUser = await query('SELECT phone FROM users WHERE id=$1', [otherId]);
      if (otherUser.rows[0]?.phone) {
        sendSMS(otherUser.rows[0].phone,
          `PROPATI: New message from ${senderName}: "${initial_message.slice(0,80)}" — Reply at propati.ng`
        ).catch(() => {});
      }
    }

    // Return full conversation with messages
    const msgs = await query(
      `SELECT m.*, u.full_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC LIMIT 50`,
      [conv.id]
    );

    return ok(res, { conversation: conv, messages: msgs.rows }, existing.rows.length > 0 ? 200 : 201);
  } catch (e) {
    logger.error('POST /conversations error', { error: e.message });
    return fail(res, 'Failed to start conversation', 500);
  }
});

// ── GET /api/messages/conversations/:id ────────────────────
// Full conversation object + first page of messages
router.get('/conversations/:id', authenticate, async (req, res) => {
  try {
    const uid = req.user.id;
    const { rows } = await query(
      `SELECT c.*,
         utt.full_name AS tenant_name, utt.avatar_url AS tenant_avatar, utt.phone AS tenant_phone,
         ull.full_name AS landlord_name, ull.avatar_url AS landlord_avatar,
         l.title AS listing_title, l.area AS listing_area, l.price AS listing_price
       FROM conversations c
       JOIN users utt ON c.tenant_id = utt.id
       JOIN users ull ON c.landlord_id = ull.id
       LEFT JOIN listings l ON c.listing_id = l.id
       WHERE c.id=$1`,
      [req.params.id]
    );

    if (!rows.length) return fail(res, 'Conversation not found', 404);
    const conv = rows[0];
    if (conv.tenant_id !== uid && conv.landlord_id !== uid && req.user.role !== 'admin') {
      return fail(res, 'Not authorised', 403);
    }

    const msgs = await query(
      `SELECT m.*, u.full_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC LIMIT 100`,
      [conv.id]
    );

    // Mark as read for current user
    const unreadField = uid === conv.tenant_id ? 'unread_tenant' : 'unread_landlord';
    await query(`UPDATE conversations SET ${unreadField}=0 WHERE id=$1`, [conv.id]);
    await query(`UPDATE messages SET is_read=1, read_at=NOW() WHERE conversation_id=$1 AND sender_id!=$2 AND is_read=0`, [conv.id, uid]);

    return ok(res, { conversation: conv, messages: msgs.rows });
  } catch (e) {
    logger.error('GET /conversations/:id error', { error: e.message });
    return fail(res, 'Failed to load conversation', 500);
  }
});

// ── GET /api/messages/conversations/:id/messages ───────────
// Poll for new messages since a timestamp (for frontend polling every 4s)
router.get('/conversations/:id/messages', authenticate, [
  qv('since').optional().isISO8601(),
  qv('limit').optional().isInt({ min: 1, max: 100 }),
], async (req, res) => {
  try {
    const uid   = req.user.id;
    const since = req.query.since || '1970-01-01';
    const limit = parseInt(req.query.limit) || 50;

    // Auth check
    const cv = await query('SELECT tenant_id, landlord_id FROM conversations WHERE id=$1', [req.params.id]);
    if (!cv.rows.length) return fail(res, 'Conversation not found', 404);
    const c = cv.rows[0];
    if (c.tenant_id !== uid && c.landlord_id !== uid && req.user.role !== 'admin') {
      return fail(res, 'Not authorised', 403);
    }

    const { rows } = await query(
      `SELECT m.*, u.full_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id=$1 AND m.created_at > $2
       ORDER BY m.created_at ASC LIMIT $3`,
      [req.params.id, since, limit]
    );

    // Mark incoming messages as read
    if (rows.length > 0) {
      const unreadField = uid === c.tenant_id ? 'unread_tenant' : 'unread_landlord';
      await query(`UPDATE conversations SET ${unreadField}=0 WHERE id=$1`, [req.params.id]);
      await query(`UPDATE messages SET is_read=1, read_at=NOW() WHERE conversation_id=$1 AND sender_id!=$2 AND is_read=0`, [req.params.id, uid]);
    }

    return ok(res, { messages: rows, count: rows.length });
  } catch (e) {
    logger.error('GET messages poll error', { error: e.message });
    return fail(res, 'Failed to poll messages', 500);
  }
});

// ── POST /api/messages/conversations/:id/messages ──────────
// Send a message in a conversation
router.post('/conversations/:id/messages', authenticate, [
  body('content').trim().isLength({ min: 1, max: 5000 }).withMessage('Message cannot be empty'),
  body('attachment_url').optional().isURL(),
  body('attachment_type').optional().isIn(['image','document','voice']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  try {
    const uid = req.user.id;
    const cv = await query('SELECT * FROM conversations WHERE id=$1', [req.params.id]);
    if (!cv.rows.length) return fail(res, 'Conversation not found', 404);
    const conv = cv.rows[0];

    if (conv.tenant_id !== uid && conv.landlord_id !== uid) {
      return fail(res, 'Not a participant in this conversation', 403);
    }
    if (conv.status === 'blocked') return fail(res, 'This conversation has been blocked', 403);

    const msgId = 'msg_' + uuidv4().replace(/-/g, '').slice(0, 12);
    const { content: msgContent, attachment_url, attachment_type } = req.body;

    await query(
      `INSERT INTO messages (id, conversation_id, sender_id, content, attachment_url, attachment_type, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
      [msgId, conv.id, uid, msgContent.trim(), attachment_url || null, attachment_type || null]
    );

    // Update conversation last message + increment unread for recipient
    const isFromTenant = uid === conv.tenant_id;
    await query(`
      UPDATE conversations
      SET last_message=$1, last_message_at=NOW(),
          ${isFromTenant ? 'unread_landlord=unread_landlord+1' : 'unread_tenant=unread_tenant+1'}
      WHERE id=$2
    `, [msgContent.trim().slice(0, 100), conv.id]);

    const otherId = isFromTenant ? conv.landlord_id : conv.tenant_id;
    const senderName = req.user.full_name || 'Someone';

    // In-app notification (non-blocking)
    createNotification(otherId, 'new_message', `New message from ${senderName}`,
      msgContent.trim().slice(0, 100), { conversation_id: conv.id }).catch(() => {});

    // SMS for urgent — only if unread count is low to avoid spamming
    const freshConv = await query('SELECT unread_tenant, unread_landlord FROM conversations WHERE id=$1', [conv.id]);
    const recipUnread = isFromTenant ? freshConv.rows[0]?.unread_landlord : freshConv.rows[0]?.unread_tenant;
    if (recipUnread === 1) {
      const otherUser = await query('SELECT phone FROM users WHERE id=$1', [otherId]);
      if (otherUser.rows[0]?.phone) {
        sendSMS(otherUser.rows[0].phone,
          `PROPATI: ${senderName} sent you a message: "${msgContent.slice(0,80)}" — Reply at propati.ng`
        ).catch(() => {});
      }
    }

    // Return the created message
    const { rows } = await query(
      `SELECT m.*, u.full_name AS sender_name, u.avatar_url AS sender_avatar
       FROM messages m JOIN users u ON m.sender_id = u.id
       WHERE m.id=$1`,
      [msgId]
    );

    return ok(res, { message: rows[0] }, 201);
  } catch (e) {
    logger.error('POST message error', { error: e.message });
    return fail(res, 'Failed to send message', 500);
  }
});

// ── PATCH /api/messages/conversations/:id/read ─────────────
// Mark all messages in conversation as read
router.patch('/conversations/:id/read', authenticate, async (req, res) => {
  try {
    const uid = req.user.id;
    const cv = await query('SELECT tenant_id, landlord_id FROM conversations WHERE id=$1', [req.params.id]);
    if (!cv.rows.length) return fail(res, 'Not found', 404);
    const c = cv.rows[0];
    if (c.tenant_id !== uid && c.landlord_id !== uid) return fail(res, 'Not authorised', 403);

    const unreadField = uid === c.tenant_id ? 'unread_tenant' : 'unread_landlord';
    await query(`UPDATE conversations SET ${unreadField}=0 WHERE id=$1`, [req.params.id]);
    await query(`UPDATE messages SET is_read=1, read_at=NOW() WHERE conversation_id=$1 AND sender_id!=$2`, [req.params.id, uid]);

    return ok(res, { message: 'Marked as read' });
  } catch (e) {
    return fail(res, 'Failed to mark as read', 500);
  }
});

// ── DELETE /api/messages/conversations/:id ─────────────────
// Archive (soft delete) a conversation
router.delete('/conversations/:id', authenticate, async (req, res) => {
  try {
    const uid = req.user.id;
    const cv = await query('SELECT tenant_id, landlord_id FROM conversations WHERE id=$1', [req.params.id]);
    if (!cv.rows.length) return fail(res, 'Not found', 404);
    const c = cv.rows[0];
    if (c.tenant_id !== uid && c.landlord_id !== uid) return fail(res, 'Not authorised', 403);

    await query(`UPDATE conversations SET status='archived' WHERE id=$1`, [req.params.id]);
    return ok(res, { message: 'Conversation archived' });
  } catch (e) {
    return fail(res, 'Failed to archive conversation', 500);
  }
});

// ── GET /api/messages/unread-count ─────────────────────────
// Total unread count across all conversations (for nav badge)
router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const uid = req.user.id;
    const { rows } = await query(`
      SELECT COALESCE(SUM(
        CASE WHEN tenant_id=$1 THEN unread_tenant ELSE unread_landlord END
      ), 0)::int AS total
      FROM conversations
      WHERE (tenant_id=$1 OR landlord_id=$1) AND status='active'
    `, [uid]);
    return ok(res, { unread: rows[0]?.total || 0 });
  } catch (e) {
    return fail(res, 'Failed to get unread count', 500);
  }
});

module.exports = router;
