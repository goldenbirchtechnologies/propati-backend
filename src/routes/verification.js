// src/routes/verification.js — 5-Layer Property Verification + Admin Queue
'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { notifyVerificationUpdate, createNotification } = require('../services/notifications');
const { uploadDocument } = require('../middleware/upload');
const cloudinary = require('cloudinary').v2;
const logger = require('../services/logger');

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const fail = (res, msg, status = 400)  => res.status(status).json({ success: false, error: msg });

// ─────────────────────────────────────────────────────────
// LANDLORD — Submit verification layers
// ─────────────────────────────────────────────────────────

// GET /api/verification/:listing_id — get verification status
router.get('/:listing_id', authenticate, async (req, res) => {
  try {
    const { listing_id } = req.params;
    const listing = await query('SELECT owner_id FROM listings WHERE id = $1', [listing_id]);
    if (!listing.rows.length) return fail(res, 'Listing not found', 404);
    if (listing.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return fail(res, 'Access denied', 403);
    }

    const result = await query('SELECT * FROM verifications WHERE listing_id = $1', [listing_id]);
    if (!result.rows.length) {
      // Auto-create verification record
      const vId = 'ver_' + uuidv4().replace(/-/g, '').slice(0, 12);
      const newVer = await query(`
        INSERT INTO verifications (id, listing_id, owner_id) VALUES ($1, $2, $3) RETURNING *
      `, [vId, listing_id, req.user.id]);
      return ok(res, { verification: newVer.rows[0] });
    }
    ok(res, { verification: result.rows[0] });
  } catch (e) {
    fail(res, 'Failed to load verification', 500);
  }
});

// POST /api/verification/upload-doc — Layer 1: document upload
router.post('/upload-doc', authenticate, requireRole('landlord', 'estate_manager', 'admin'),
  uploadDocument.single('document'), async (req, res) => {
  try {
    const { listing_id, doc_type } = req.body;
    if (!listing_id || !req.file) return fail(res, 'listing_id and document required');

    const validDocTypes = ['coo', 'title', 'survey', 'deed', 'govcon'];
    if (!validDocTypes.includes(doc_type)) return fail(res, 'Invalid doc_type');

    // Upload to Cloudinary
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const uploadResult = await cloudinary.uploader.upload(b64, {
      folder: `propati/verification/${listing_id}`,
      resource_type: 'auto',
    });

    // Ensure verification record exists
    await query(`
      INSERT INTO verifications (id, listing_id, owner_id)
      VALUES ($1, $2, $3) ON CONFLICT (listing_id) DO NOTHING
    `, [uuidv4(), listing_id, req.user.id]);

    // Map doc_type to column name
    const colMap = { coo: 'l1_doc_coo', title: 'l1_doc_title', survey: 'l1_doc_survey', deed: 'l1_doc_deed', govcon: 'l1_doc_govcon' };
    const col = colMap[doc_type];

    await query(`UPDATE verifications SET ${col} = $1, updated_at = NOW() WHERE listing_id = $2`,
      [uploadResult.secure_url, listing_id]);

    ok(res, { url: uploadResult.secure_url, doc_type });
  } catch (e) {
    logger.error('Doc upload error', { error: e.message });
    fail(res, 'Upload failed', 500);
  }
});

// POST /api/verification/submit-layer1 — Submit layer 1 for review
router.post('/submit-layer1', authenticate, requireRole('landlord', 'estate_manager', 'admin'), [
  body('listing_id').notEmpty(),
], async (req, res) => {
  try {
    const { listing_id } = req.body;
    const ver = await query('SELECT * FROM verifications WHERE listing_id = $1', [listing_id]);
    if (!ver.rows.length) return fail(res, 'Verification not started');
    if (!ver.rows[0].l1_doc_coo && !ver.rows[0].l1_doc_title) {
      return fail(res, 'Upload at least one title document before submitting');
    }

    await query(`
      UPDATE verifications SET
        l1_status = 'submitted', l1_submitted_at = NOW(), updated_at = NOW()
      WHERE listing_id = $1
    `, [listing_id]);

    // Notify admin
    const admins = await query("SELECT id FROM users WHERE role = 'admin' LIMIT 3");
    for (const admin of admins.rows) {
      await createNotification(admin.id, 'verification_submit',
        'New Document Submission', `Listing ${listing_id} submitted Layer 1 docs for review`,
        { listing_id, layer: 1 });
    }

    ok(res, { submitted: true, layer: 1 });
  } catch (e) {
    fail(res, 'Submit failed', 500);
  }
});

// POST /api/verification/identity — Layer 2: identity verification
router.post('/identity', authenticate, requireRole('landlord', 'estate_manager', 'admin'), [
  body('listing_id').notEmpty(),
  body('id_type').isIn(['nin','passport','drivers_licence']),
  body('id_number').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const { listing_id, id_type, id_number, id_doc_url } = req.body;

    await query(`
      INSERT INTO verifications (id, listing_id, owner_id)
      VALUES ($1, $2, $3) ON CONFLICT (listing_id) DO NOTHING
    `, [uuidv4(), listing_id, req.user.id]);

    await query(`
      UPDATE verifications SET
        l2_id_type = $1, l2_id_number = $2, l2_id_doc_url = $3,
        l2_status = 'submitted', l2_submitted_at = NOW(), updated_at = NOW()
      WHERE listing_id = $4
    `, [id_type, id_number, id_doc_url || null, listing_id]);

    ok(res, { submitted: true, layer: 2 });
  } catch (e) {
    fail(res, 'Identity submission failed', 500);
  }
});

// POST /api/verification/inspection — Layer 4: schedule inspection
router.post('/inspection', authenticate, requireRole('landlord', 'estate_manager', 'admin'), [
  body('listing_id').notEmpty(),
  body('scheduled_at').isISO8601(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const { listing_id, scheduled_at, notes } = req.body;

    await query(`
      UPDATE verifications SET
        l4_status = 'scheduled', l4_scheduled_at = $1, l4_notes = $2, updated_at = NOW()
      WHERE listing_id = $3
    `, [scheduled_at, notes || null, listing_id]);

    const admins = await query("SELECT id FROM users WHERE role = 'admin' LIMIT 3");
    for (const admin of admins.rows) {
      await createNotification(admin.id, 'inspection_scheduled',
        'Inspection Scheduled', `Listing ${listing_id} scheduled inspection for ${new Date(scheduled_at).toLocaleDateString()}`,
        { listing_id, scheduled_at });
    }

    ok(res, { scheduled: true, scheduled_at });
  } catch (e) {
    fail(res, 'Inspection scheduling failed', 500);
  }
});

// ─────────────────────────────────────────────────────────
// ADMIN — Verification Queue
// ─────────────────────────────────────────────────────────

// GET /api/verification/admin/queue — all pending verifications
router.get('/admin/queue', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { status, layer } = req.query;

    const result = await query(`
      SELECT v.*,
        l.title AS listing_title, l.area, l.address, l.listing_type,
        u.full_name AS owner_name, u.email AS owner_email, u.phone AS owner_phone,
        u.nin_verified, u.id_verified
      FROM verifications v
      JOIN listings l ON v.listing_id = l.id
      JOIN users u ON v.owner_id = u.id
      WHERE v.overall_status != 'certified'
        AND (
          v.l1_status = 'submitted' OR
          v.l2_status = 'submitted' OR
          v.l4_status = 'scheduled' OR
          v.l5_status = 'pending'
        )
      ORDER BY v.updated_at ASC
    `);

    ok(res, { queue: result.rows, total: result.rows.length });
  } catch (e) {
    fail(res, 'Failed to load queue', 500);
  }
});

// POST /api/verification/admin/review — admin approves/rejects a layer
router.post('/admin/review', authenticate, requireRole('admin'), [
  body('listing_id').notEmpty(),
  body('layer').isInt({ min: 1, max: 5 }),
  body('decision').isIn(['approved', 'rejected']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const { listing_id, layer, decision, notes } = req.body;
    const adminId = req.user.id;

    const ver = await query(
      'SELECT v.*, l.owner_id FROM verifications v JOIN listings l ON v.listing_id = l.id WHERE v.listing_id = $1',
      [listing_id]
    );
    if (!ver.rows.length) return fail(res, 'Verification not found', 404);
    const v = ver.rows[0];

    // Build update for the specific layer
    const layerCols = {
      1: { status: 'l1_status', reviewer: 'l1_reviewer_id', reviewedAt: 'l1_reviewed_at', notes: 'l1_notes' },
      2: { status: 'l2_status', reviewer: null, reviewedAt: 'l2_reviewed_at', notes: 'l2_notes' },
      3: { status: 'l3_status', reviewer: 'l3_reviewer_id', reviewedAt: 'l3_reviewed_at', notes: 'l3_notes' },
      4: { status: 'l4_status', reviewer: null, reviewedAt: 'l4_completed_at', notes: 'l4_notes' },
      5: { status: 'l5_status', reviewer: 'l5_admin_id', reviewedAt: 'l5_certified_at', notes: 'l5_notes' },
    };
    const cols = layerCols[layer];

    // Update this layer
    let updateSQL = `
      UPDATE verifications SET
        ${cols.status} = $1,
        ${cols.reviewedAt} = NOW(),
        ${cols.notes} = COALESCE($2, ${cols.notes}),
        updated_at = NOW()
    `;
    const params = [decision, notes || null];
    if (cols.reviewer) {
      updateSQL += `, ${cols.reviewer} = $${params.length + 1}`;
      params.push(adminId);
    }

    // If layer 5 approved → certify listing
    let isCertified = false;
    if (layer === 5 && decision === 'approved') {
      updateSQL += `, overall_status = 'certified', current_layer = 5`;
      isCertified = true;
    } else if (decision === 'approved' && layer < 5) {
      updateSQL += `, current_layer = ${layer + 1}`;
    } else if (decision === 'rejected') {
      updateSQL += `, overall_status = 'rejected'`;
    }

    updateSQL += ` WHERE listing_id = $${params.length + 1}`;
    params.push(listing_id);

    await query(updateSQL, params);

    // Update listing verification_tier
    const tierMap = { 1: 'basic', 2: 'verified', 3: 'verified', 4: 'inspected', 5: 'certified' };
    if (decision === 'approved') {
      await query(
        'UPDATE listings SET verification_tier = $1, updated_at = NOW() WHERE id = $2',
        [tierMap[layer] || 'basic', listing_id]
      );
    }

    // Notify owner
    const ownerResult = await query(
      'SELECT u.id, u.email, u.phone FROM users u JOIN listings l ON l.owner_id = u.id WHERE l.id = $1',
      [listing_id]
    );
    const owner = ownerResult.rows[0];
    const listingResult = await query('SELECT title FROM listings WHERE id = $1', [listing_id]);
    const listingTitle = listingResult.rows[0]?.title || listing_id;

    if (owner) {
      const status = isCertified ? 'certified' : decision;
      await notifyVerificationUpdate(
        owner.id, status, listingTitle, notes, owner.email, owner.phone
      );
    }

    ok(res, {
      reviewed: true, layer, decision, certified: isCertified,
      message: isCertified ? '⭐ Property certified!' : `Layer ${layer} ${decision}`,
    });
  } catch (e) {
    logger.error('Admin review error', { error: e.message });
    fail(res, 'Review failed', 500);
  }
});

module.exports = router;
