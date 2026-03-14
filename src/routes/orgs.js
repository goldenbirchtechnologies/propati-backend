// src/routes/orgs.js — Estate Manager B2B Organisation Routes
// All routes require authentication. Org-specific routes verify membership.
// Endpoints:
//   POST   /api/orgs                         — create organisation (estate_manager role)
//   GET    /api/orgs/mine                    — get current user's org
//   PATCH  /api/orgs/:id                     — update org details (manager only)
//   GET    /api/orgs/:id/portfolio           — all properties under org
//   GET    /api/orgs/:id/team                — all org members
//   POST   /api/orgs/:id/invite              — invite team member
//   DELETE /api/orgs/:id/members/:uid        — remove team member
//   GET    /api/orgs/:id/tickets             — maintenance tickets
//   POST   /api/orgs/:id/tickets             — create ticket
//   PATCH  /api/orgs/:id/tickets/:tid        — update ticket
//   GET    /api/orgs/:id/ledger              — rent ledger across all org properties
//   GET    /api/orgs/:id/subscription        — subscription info
//   POST   /api/orgs/:id/subscribe           — initiate Paystack subscription
//   POST   /api/orgs/:id/bulk-upload         — bulk property import (CSV)
//   GET    /api/orgs/:id/reports/:month      — generate/return monthly owner report
//   GET    /api/orgs/bulk-template.csv       — CSV template download
'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');
const { query, transaction } = require('../db');
const { authenticate } = require('../middleware/auth');
const {
  notifyTeamInvite, notifyNewTicket, notifyTicketResolved, createNotification
} = require('../services/notifications');
const paystack = require('../services/paystack');
const multer = require('multer');
const logger = require('../services/logger');

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const fail = (res, msg, status = 400)  => res.status(status).json({ success: false, error: msg });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Middleware: verify org membership + optional role check ─
function requireOrgAccess(allowedRoles = []) {
  return async (req, res, next) => {
    const orgId = req.params.id;
    const userId = req.user.id;

    const memberResult = await query(
      `SELECT om.role FROM org_members om
       JOIN organisations o ON om.org_id = o.id
       WHERE om.org_id = $1 AND om.user_id = $2 AND om.status = 'active'`,
      [orgId, userId]
    );

    // Allow org owner even if not in org_members
    if (!memberResult.rows.length) {
      const ownerResult = await query(
        'SELECT id FROM organisations WHERE id = $1 AND owner_id = $2',
        [orgId, userId]
      );
      if (!ownerResult.rows.length) return fail(res, 'Not a member of this organisation', 403);
      req.orgRole = 'manager';
    } else {
      req.orgRole = memberResult.rows[0].role;
    }

    if (allowedRoles.length && !allowedRoles.includes(req.orgRole)) {
      return fail(res, `Requires role: ${allowedRoles.join(' or ')}`, 403);
    }
    next();
  };
}

// ── CSV template ────────────────────────────────────────────
router.get('/bulk-template.csv', (req, res) => {
  const csv = 'title,listing_type,property_type,address,location,price,bedrooms,bathrooms,size_sqm,description\n' +
    '"3-Bed Flat, Lekki Phase 1",rent,apartment,"12 Admiralty Way, Lekki Phase 1","Lekki Phase 1",800000,3,2,110,"Spacious 3-bedroom flat with sea view"';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="propati-bulk-template.csv"');
  res.send(csv);
});

// ── POST /api/orgs — create organisation ────────────────────
router.post('/', authenticate, [
  body('name').trim().notEmpty().withMessage('Organisation name required'),
  body('billing_email').isEmail().withMessage('Valid billing email required'),
  body('address').optional().trim(),
  body('cac_number').optional().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const userId = req.user.id;
    const { name, billing_email, address, cac_number } = req.body;

    // One org per user
    const existing = await query(
      `SELECT o.id FROM organisations o
       JOIN org_members om ON o.id = om.org_id
       WHERE om.user_id = $1 AND om.status = 'active' AND om.role = 'manager'
       LIMIT 1`,
      [userId]
    );
    if (existing.rows.length) {
      const existingOrg = await query('SELECT * FROM organisations WHERE id = $1', [existing.rows[0].id]);
      return ok(res, { org: existingOrg.rows[0], created: false });
    }

    const orgId = 'org_' + uuidv4().replace(/-/g, '').slice(0, 12);

    // Create org + add owner as manager member in a transaction
    await query('BEGIN');
    const orgResult = await query(`
      INSERT INTO organisations (id, name, owner_id, billing_email, address, cac_number)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [orgId, name.trim(), userId, billing_email.trim(), address || null, cac_number || null]);

    await query(`
      INSERT INTO org_members (id, org_id, user_id, email, role, status, joined_at)
      VALUES ($1, $2, $3, $4, 'manager', 'active', NOW())
    `, [uuidv4(), orgId, userId, req.user.email]);

    await query('COMMIT');

    // Update user role to estate_manager if not already
    await query(
      `UPDATE users SET role = 'estate_manager' WHERE id = $1 AND role NOT IN ('admin')`,
      [userId]
    );

    ok(res, { org: orgResult.rows[0], created: true }, 201);
  } catch (e) {
    await query('ROLLBACK').catch(() => {});
    logger.error('Create org error', { error: e.message });
    fail(res, 'Failed to create organisation', 500);
  }
});

// ── GET /api/orgs/mine ───────────────────────────────────────
router.get('/mine', authenticate, async (req, res) => {
  try {
    const result = await query(`
      SELECT o.*, om.role AS member_role
      FROM organisations o
      JOIN org_members om ON o.id = om.org_id
      WHERE om.user_id = $1 AND om.status = 'active'
      ORDER BY o.created_at DESC
      LIMIT 1
    `, [req.user.id]);

    if (!result.rows.length) return fail(res, 'No organisation found', 404);
    ok(res, { ...result.rows[0] });
  } catch (e) {
    fail(res, 'Failed to load organisation', 500);
  }
});

// ── PATCH /api/orgs/:id ─────────────────────────────────────
router.patch('/:id', authenticate, requireOrgAccess(['manager']), async (req, res) => {
  try {
    const { name, billing_email, address, cac_number } = req.body;
    const result = await query(`
      UPDATE organisations SET
        name = COALESCE($1, name),
        billing_email = COALESCE($2, billing_email),
        address = COALESCE($3, address),
        cac_number = COALESCE($4, cac_number),
        updated_at = NOW()
      WHERE id = $5 RETURNING *
    `, [name || null, billing_email || null, address || null, cac_number || null, req.params.id]);
    ok(res, { org: result.rows[0] });
  } catch (e) {
    fail(res, 'Failed to update organisation', 500);
  }
});

// ── GET /api/orgs/:id/portfolio ─────────────────────────────
router.get('/:id/portfolio', authenticate, requireOrgAccess(), async (req, res) => {
  try {
    const result = await query(`
      SELECT l.*, u.full_name AS owner_name,
        (SELECT url FROM listing_images WHERE listing_id = l.id AND is_cover = TRUE LIMIT 1) AS cover_image,
        (SELECT url FROM listing_images WHERE listing_id = l.id ORDER BY sort_order LIMIT 1) AS first_image,
        rs_latest.status AS rent_status,
        tenant.full_name AS tenant_name
      FROM org_listings ol
      JOIN listings l ON ol.listing_id = l.id
      JOIN users u ON l.owner_id = u.id
      LEFT JOIN agreements agr ON agr.listing_id = l.id AND agr.status = 'fully_signed'
      LEFT JOIN users tenant ON agr.tenant_id = tenant.id
      LEFT JOIN LATERAL (
        SELECT status FROM rent_schedule
        WHERE agreement_id = agr.id
        ORDER BY due_date DESC LIMIT 1
      ) rs_latest ON TRUE
      WHERE ol.org_id = $1
      ORDER BY l.created_at DESC
    `, [req.params.id]);

    const properties = result.rows.map(p => ({
      ...p,
      images: [p.cover_image || p.first_image].filter(Boolean),
      is_occupied: !!p.tenant_name,
    }));

    ok(res, { properties });
  } catch (e) {
    logger.error('Portfolio error', { error: e.message });
    fail(res, 'Failed to load portfolio', 500);
  }
});

// ── GET /api/orgs/:id/team ───────────────────────────────────
router.get('/:id/team', authenticate, requireOrgAccess(), async (req, res) => {
  try {
    const result = await query(`
      SELECT om.*, u.full_name, u.avatar_url, u.email AS user_email,
             u.phone, u.last_login
      FROM org_members om
      LEFT JOIN users u ON om.user_id = u.id
      WHERE om.org_id = $1 AND om.status != 'removed'
      ORDER BY om.created_at ASC
    `, [req.params.id]);
    ok(res, { members: result.rows });
  } catch (e) {
    fail(res, 'Failed to load team', 500);
  }
});

// ── POST /api/orgs/:id/invite ────────────────────────────────
router.post('/:id/invite', authenticate, requireOrgAccess(['manager']), [
  body('email').isEmail().withMessage('Valid email required'),
  body('role').isIn(['manager', 'accountant', 'maintenance', 'owner_view']).withMessage('Invalid role'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const orgId = req.params.id;
    const { email, role } = req.body;

    // Check org plan seat limits
    const org = await query('SELECT * FROM organisations WHERE id = $1', [orgId]);
    if (!org.rows.length) return fail(res, 'Org not found', 404);

    const memberCount = await query(
      `SELECT COUNT(*) AS cnt FROM org_members WHERE org_id = $1 AND status = 'active'`,
      [orgId]
    );
    const currentSeats = parseInt(memberCount.rows[0]?.cnt) || 0;
    const planSeats = { starter: 1, growth: 5, enterprise: 9999 };
    const maxSeats = planSeats[org.rows[0].plan_tier] || 1;

    if (currentSeats >= maxSeats) {
      return fail(res, `Seat limit reached (${maxSeats} on ${org.rows[0].plan_tier} plan). Upgrade to add more.`, 403);
    }

    // Check if already invited
    const existing = await query(
      `SELECT id, status FROM org_members WHERE org_id = $1 AND email = $2`,
      [orgId, email.toLowerCase()]
    );
    if (existing.rows.length && existing.rows[0].status === 'active') {
      return fail(res, 'This person is already a member');
    }

    // Check if user already has an account
    const userResult = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    const userId = userResult.rows[0]?.id || null;
    const inviteToken = uuidv4();

    if (existing.rows.length) {
      // Re-send invite
      await query(
        `UPDATE org_members SET status = 'pending', role = $1, invite_token = $2 WHERE id = $3`,
        [role, inviteToken, existing.rows[0].id]
      );
    } else {
      await query(`
        INSERT INTO org_members (id, org_id, user_id, email, role, invited_by, invite_token)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [uuidv4(), orgId, userId, email.toLowerCase(), role, req.user.id, inviteToken]);
    }

    // Send invite email (non-blocking)
    notifyTeamInvite(email, org.rows[0].name, role, inviteToken).catch(e =>
      logger.error('Team invite email error', { error: e.message })
    );

    ok(res, { invited: true, email }, 201);
  } catch (e) {
    logger.error('Invite member error', { error: e.message });
    fail(res, 'Failed to send invitation', 500);
  }
});

// ── DELETE /api/orgs/:id/members/:uid ───────────────────────
router.delete('/:id/members/:uid', authenticate, requireOrgAccess(['manager']), async (req, res) => {
  try {
    const { id: orgId, uid: userId } = req.params;

    // Can't remove yourself if you're the owner
    const org = await query('SELECT owner_id FROM organisations WHERE id = $1', [orgId]);
    if (org.rows[0]?.owner_id === userId) return fail(res, 'Cannot remove org owner');
    if (userId === req.user.id) return fail(res, 'Cannot remove yourself');

    await query(
      `UPDATE org_members SET status = 'removed' WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId]
    );
    ok(res, { removed: true });
  } catch (e) {
    fail(res, 'Failed to remove member', 500);
  }
});

// ── GET /api/orgs/:id/tickets ────────────────────────────────
router.get('/:id/tickets', authenticate, requireOrgAccess(), async (req, res) => {
  try {
    const { status, priority, category } = req.query;
    let conditions = ['t.org_id = $1'];
    const params = [req.params.id];
    let i = 2;

    if (status)   { conditions.push(`t.status = $${i++}`);   params.push(status); }
    if (priority) { conditions.push(`t.priority = $${i++}`); params.push(priority); }
    if (category) { conditions.push(`t.category = $${i++}`); params.push(category); }

    const result = await query(`
      SELECT t.*,
        l.title AS property_title, l.area AS property_area,
        tenant.full_name AS tenant_name, tenant.phone AS tenant_phone,
        assignee.full_name AS assigned_name
      FROM maintenance_tickets t
      LEFT JOIN listings l ON t.listing_id = l.id
      LEFT JOIN users tenant ON t.tenant_id = tenant.id
      LEFT JOIN users assignee ON t.assigned_to = assignee.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        t.created_at DESC
    `, params);

    ok(res, { tickets: result.rows });
  } catch (e) {
    fail(res, 'Failed to load tickets', 500);
  }
});

// ── POST /api/orgs/:id/tickets ───────────────────────────────
router.post('/:id/tickets', authenticate, requireOrgAccess(['manager', 'maintenance']), [
  body('title').trim().notEmpty().withMessage('Ticket title required'),
  body('category').optional().isIn(['plumbing','electrical','structural','security','cleaning','other']),
  body('priority').optional().isIn(['low','medium','high','urgent']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const orgId = req.params.id;
    const { title, description, category, priority, property_id, tenant_id } = req.body;

    const ticketId = 'tkt_' + uuidv4().replace(/-/g, '').slice(0, 12);
    const result = await query(`
      INSERT INTO maintenance_tickets
        (id, org_id, listing_id, tenant_id, raised_by, title, description, category, priority)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [ticketId, orgId, property_id || null, tenant_id || null, req.user.id,
        title.trim(), description || null, category || 'other', priority || 'medium']);

    ok(res, { ticket: result.rows[0] }, 201);
  } catch (e) {
    logger.error('Create ticket error', { error: e.message });
    fail(res, 'Failed to create ticket', 500);
  }
});

// ── PATCH /api/orgs/:id/tickets/:tid ────────────────────────
router.patch('/:id/tickets/:tid', authenticate, requireOrgAccess(['manager', 'maintenance']), async (req, res) => {
  try {
    const { tid } = req.params;
    const { status, assigned_to, resolution_note, priority } = req.body;

    const validStatuses = ['open','assigned','in_progress','resolved','closed'];
    if (status && !validStatuses.includes(status)) return fail(res, 'Invalid status');

    const resolved_at = status === 'resolved' ? 'NOW()' : null;
    const closed_at   = status === 'closed' ? 'NOW()' : null;

    const result = await query(`
      UPDATE maintenance_tickets SET
        status          = COALESCE($1, status),
        assigned_to     = COALESCE($2, assigned_to),
        resolution_note = COALESCE($3, resolution_note),
        priority        = COALESCE($4, priority),
        resolved_at     = CASE WHEN $1 = 'resolved' THEN NOW() ELSE resolved_at END,
        closed_at       = CASE WHEN $1 = 'closed'   THEN NOW() ELSE closed_at END,
        updated_at      = NOW()
      WHERE id = $5 AND org_id = $6
      RETURNING *
    `, [status || null, assigned_to || null, resolution_note || null, priority || null, tid, req.params.id]);

    if (!result.rows.length) return fail(res, 'Ticket not found', 404);

    // Notify tenant if resolved
    if (status === 'resolved' && result.rows[0].tenant_id) {
      const tenantResult = await query('SELECT phone FROM users WHERE id = $1', [result.rows[0].tenant_id]);
      notifyTicketResolved(
        result.rows[0].tenant_id,
        result.rows[0].title,
        tenantResult.rows[0]?.phone
      ).catch(() => {});
    }

    ok(res, { ticket: result.rows[0] });
  } catch (e) {
    fail(res, 'Failed to update ticket', 500);
  }
});

// ── GET /api/orgs/:id/ledger ─────────────────────────────────
router.get('/:id/ledger', authenticate, requireOrgAccess(['manager', 'accountant']), async (req, res) => {
  try {
    const result = await query(`
      SELECT
        rs.id, rs.due_date, rs.amount AS amount_due, rs.status,
        rs.paid_at, rs.transaction_id,
        l.title AS property_title, l.area,
        tenant.full_name AS tenant_name, tenant.phone AS tenant_phone,
        COALESCE(txn.amount, 0) AS amount_paid
      FROM org_listings ol
      JOIN listings l ON ol.listing_id = l.id
      JOIN agreements agr ON agr.listing_id = l.id AND agr.status IN ('fully_signed','tenant_signed')
      JOIN rent_schedule rs ON rs.agreement_id = agr.id
      JOIN users tenant ON agr.tenant_id = tenant.id
      LEFT JOIN transactions txn ON rs.transaction_id = txn.id
      WHERE ol.org_id = $1
      ORDER BY rs.due_date DESC, l.title
    `, [req.params.id]);

    ok(res, { entries: result.rows });
  } catch (e) {
    fail(res, 'Failed to load ledger', 500);
  }
});

// ── GET /api/orgs/:id/subscription ──────────────────────────
router.get('/:id/subscription', authenticate, requireOrgAccess(['manager', 'accountant']), async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM org_subscriptions WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.params.id]
    );
    const org = await query('SELECT plan_tier FROM organisations WHERE id = $1', [req.params.id]);
    ok(res, {
      subscription: result.rows[0] || null,
      plan: org.rows[0]?.plan_tier || 'starter'
    });
  } catch (e) {
    fail(res, 'Failed to load subscription', 500);
  }
});

// ── POST /api/orgs/:id/subscribe ────────────────────────────
router.post('/:id/subscribe', authenticate, requireOrgAccess(['manager']), [
  body('plan').isIn(['starter','growth','enterprise']).withMessage('Invalid plan'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const orgId = req.params.id;
    const { plan } = req.body;
    const org = await query('SELECT * FROM organisations WHERE id = $1', [orgId]);
    if (!org.rows.length) return fail(res, 'Org not found', 404);

    const planPrices = { starter: 2500000, growth: 6000000, enterprise: 15000000 }; // kobo
    const planSeats  = { starter: 1, growth: 5, enterprise: 9999 };
    const planUnits  = { starter: 20, growth: 100, enterprise: 9999 };
    const amount = planPrices[plan];

    // Initialize Paystack transaction
    const paystackRes = await paystack.initializeTransaction({
      email: org.rows[0].billing_email,
      amount,
      metadata: {
        org_id: orgId,
        plan,
        type: 'org_subscription',
      },
      callback_url: `${process.env.FRONTEND_URL || 'https://propati.ng'}/billing-callback`,
    });

    if (!paystackRes.status) throw new Error(paystackRes.message || 'Paystack error');

    // Store pending subscription
    await query(`
      INSERT INTO org_subscriptions (id, org_id, plan, status, amount, created_at)
      VALUES ($1, $2, $3, 'active', $4, NOW())
      ON CONFLICT DO NOTHING
    `, [uuidv4(), orgId, plan, amount]);

    // Optimistically update plan (will be confirmed by webhook)
    await query(`
      UPDATE organisations SET plan_tier = $1, max_units = $2, max_seats = $3, updated_at = NOW()
      WHERE id = $4
    `, [plan, planUnits[plan], planSeats[plan], orgId]);

    ok(res, {
      authorization_url: paystackRes.data?.authorization_url,
      access_code: paystackRes.data?.access_code,
      reference: paystackRes.data?.reference,
    });
  } catch (e) {
    logger.error('Subscribe error', { error: e.message });
    fail(res, e.message || 'Subscription initiation failed', 500);
  }
});

// ── POST /api/orgs/:id/bulk-upload ───────────────────────────
router.post('/:id/bulk-upload', authenticate, requireOrgAccess(['manager']),
  upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return fail(res, 'No file uploaded');
    const orgId = req.params.id;
    const userId = req.user.id;

    // Parse CSV in memory
    const csv = req.file.buffer.toString('utf-8');
    const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return fail(res, 'CSV appears empty');

    const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''));
    const requiredCols = ['title', 'listing_type', 'property_type', 'address', 'location', 'price'];
    const missing = requiredCols.filter(c => !headers.includes(c));
    if (missing.length) return fail(res, `Missing required columns: ${missing.join(', ')}`);

    const preview = [];
    let imported = 0;
    let errors = 0;

    // Check org unit limit
    const org = await query('SELECT max_units FROM organisations WHERE id = $1', [orgId]);
    const currentCount = await query('SELECT COUNT(*) AS cnt FROM org_listings WHERE org_id = $1', [orgId]);
    const available = (org.rows[0]?.max_units || 20) - parseInt(currentCount.rows[0]?.cnt || 0);

    const rows = lines.slice(1, Math.min(lines.length, available + 2));

    for (const line of rows) {
      if (imported >= available) break;

      // Simple CSV parse (handles quoted fields)
      const values = [];
      let inQuote = false;
      let current = '';
      for (const char of line + ',') {
        if (char === '"') { inQuote = !inQuote; continue; }
        if (char === ',' && !inQuote) { values.push(current.trim()); current = ''; continue; }
        current += char;
      }

      const row = {};
      headers.forEach((h, i) => { row[h] = values[i] || ''; });

      // Validate
      if (!row.title || !row.listing_type || !row.address || !row.price) {
        preview.push({ ...row, error: 'Missing required fields' });
        errors++;
        continue;
      }

      const validTypes = ['rent','sale','short-let','share','commercial'];
      if (!validTypes.includes(row.listing_type)) {
        preview.push({ ...row, error: `Invalid listing_type: ${row.listing_type}` });
        errors++;
        continue;
      }

      const price = parseFloat(row.price);
      if (isNaN(price) || price <= 0) {
        preview.push({ ...row, error: 'Invalid price' });
        errors++;
        continue;
      }

      try {
        const listingId = 'lst_' + uuidv4().replace(/-/g, '').slice(0, 12);
        await query(`
          INSERT INTO listings
            (id, owner_id, title, listing_type, property_type, address, area, price, bedrooms, bathrooms, size_sqm, description, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')
          ON CONFLICT DO NOTHING
        `, [
          listingId, userId,
          row.title.trim(),
          row.listing_type,
          row.property_type || 'apartment',
          row.address.trim(),
          row.location || row.address.trim(),
          price,
          parseInt(row.bedrooms) || null,
          parseInt(row.bathrooms) || null,
          parseFloat(row.size_sqm) || null,
          row.description || null,
        ]);

        // Link to org
        await query(`
          INSERT INTO org_listings (id, org_id, listing_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
        `, [uuidv4(), orgId, listingId]);

        preview.push({ ...row, imported: true });
        imported++;
      } catch (insertErr) {
        preview.push({ ...row, error: insertErr.message });
        errors++;
      }
    }

    ok(res, { imported, errors, preview, skipped: rows.length - imported - errors });
  } catch (e) {
    logger.error('Bulk upload error', { error: e.message });
    fail(res, 'Bulk upload failed: ' + e.message, 500);
  }
});

// ── GET /api/orgs/:id/reports/:month ────────────────────────
// Returns a pre-signed Cloudinary PDF URL or generates on the fly
// month format: YYYY-MM
router.get('/:id/reports/:month', authenticate, requireOrgAccess(['manager', 'accountant', 'owner_view']), async (req, res) => {
  try {
    const { id: orgId, month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) return fail(res, 'Invalid month format. Use YYYY-MM');

    const startDate = `${month}-01`;
    const endDate = new Date(new Date(startDate).setMonth(new Date(startDate).getMonth() + 1)).toISOString().slice(0, 10);

    // Gather report data
    const [orgResult, portfolioResult, rentResult, ticketsResult] = await Promise.all([
      query('SELECT * FROM organisations WHERE id = $1', [orgId]),
      query('SELECT COUNT(*) AS total FROM org_listings WHERE org_id = $1', [orgId]),
      query(`
        SELECT
          COUNT(*) AS total_units,
          COUNT(CASE WHEN rs.status = 'paid' THEN 1 END) AS paid,
          COUNT(CASE WHEN rs.status = 'overdue' THEN 1 END) AS overdue,
          SUM(CASE WHEN rs.status = 'paid' THEN rs.amount ELSE 0 END) AS collected,
          SUM(rs.amount) AS expected
        FROM org_listings ol
        JOIN listings l ON ol.listing_id = l.id
        JOIN agreements agr ON agr.listing_id = l.id AND agr.status = 'fully_signed'
        JOIN rent_schedule rs ON rs.agreement_id = agr.id
        WHERE ol.org_id = $1 AND rs.due_date >= $2 AND rs.due_date < $3
      `, [orgId, startDate, endDate]),
      query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN status = 'resolved' OR status = 'closed' THEN 1 END) AS resolved
        FROM maintenance_tickets
        WHERE org_id = $1 AND created_at >= $2 AND created_at < $3
      `, [orgId, startDate, endDate]),
    ]);

    const org = orgResult.rows[0];
    const rent = rentResult.rows[0];
    const tickets = ticketsResult.rows[0];

    // Build JSON report (in production, this would be rendered to PDF via a PDF service)
    const reportData = {
      org: { name: org?.name, plan: org?.plan_tier },
      month,
      generated_at: new Date().toISOString(),
      portfolio: { total_units: parseInt(portfolioResult.rows[0]?.total) || 0 },
      rent_collection: {
        expected: parseFloat(rent?.expected) || 0,
        collected: parseFloat(rent?.collected) || 0,
        overdue_units: parseInt(rent?.overdue) || 0,
        collection_rate: rent?.expected > 0
          ? Math.round((rent.collected / rent.expected) * 100) + '%'
          : '0%',
      },
      maintenance: {
        total_tickets: parseInt(tickets?.total) || 0,
        resolved: parseInt(tickets?.resolved) || 0,
      },
    };

    // TODO: In production, render this to PDF using Puppeteer or a PDF API
    // and upload to Cloudinary, then return the signed URL.
    // For now, return the JSON data and a placeholder URL.
    ok(res, {
      report: reportData,
      url: null, // Will be a Cloudinary PDF URL once PDF generation is implemented
      message: 'Report data ready. PDF generation coming soon.',
    });
  } catch (e) {
    logger.error('Report error', { error: e.message });
    fail(res, 'Failed to generate report', 500);
  }
});

module.exports = router;
