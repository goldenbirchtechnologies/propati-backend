// src/routes/users.js — PostgreSQL version
'use strict';
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { uploadImages, uploadToCloudinary } = require('../middleware/upload');
const logger = require('../services/logger');

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const fail = (res, msg, status = 400) => res.status(status).json({ success: false, error: msg });

function sanitizeUser(u) {
  if (!u) return null;
  const { password, nin_encrypted, id_number_enc, ...safe } = u;
  return safe;
}

// ── GET /api/users/profile ─────────────────────────────────
router.get('/profile', authenticate, (req, res) => {
  return ok(res, { user: sanitizeUser(req.user) });
});

// ── PATCH /api/users/profile ───────────────────────────────
router.patch('/profile', authenticate, uploadImages.single('avatar'), [
  body('full_name').optional().trim().isLength({ min: 2 }),
  body('phone').optional().isMobilePhone('any'),
  body('agent_bio').optional().isString(),
  body('agent_areas').optional().isArray(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422);

  try {
    const updates = [];
    const vals = [];
    let i = 1;

    for (const key of ['full_name','phone','agent_bio']) {
      if (req.body[key] !== undefined) { updates.push(`${key} = $${i++}`); vals.push(req.body[key]); }
    }
    if (req.body.agent_areas) { updates.push(`agent_areas = $${i++}`); vals.push(JSON.stringify(req.body.agent_areas)); }

    // Avatar upload to Cloudinary
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, { subfolder: 'avatars', resource_type: 'image' });
      updates.push(`avatar_url = $${i++}`);
      vals.push(result.secure_url);
    }

    if (!updates.length) return fail(res, 'Nothing to update');
    updates.push(`updated_at = NOW()`);
    vals.push(req.user.id);

    const { rows } = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    return ok(res, { user: sanitizeUser(rows[0]) });
  } catch (e) {
    logger.error('PATCH /profile error', { error: e.message });
    return fail(res, 'Failed to update profile', 500);
  }
});

// ── GET /api/users/notifications ──────────────────────────
router.get('/notifications', authenticate, async (req, res) => {
  try {
    const [notifs, unread] = await Promise.all([
      query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]),
      query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND read = FALSE', [req.user.id]),
    ]);
    return ok(res, { notifications: notifs.rows, unread: parseInt(unread.rows[0].n) });
  } catch (e) {
    return fail(res, 'Failed to load notifications', 500);
  }
});

// ── POST /api/users/notifications/read-all ────────────────
router.post('/notifications/read-all', authenticate, async (req, res) => {
  try {
    await query('UPDATE notifications SET read = TRUE WHERE user_id = $1', [req.user.id]);
    return ok(res, { message: 'All notifications marked as read' });
  } catch (e) {
    return fail(res, 'Failed to mark notifications', 500);
  }
});

// ── GET /api/users/saved-listings ─────────────────────────
router.get('/saved-listings', authenticate, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT l.*, sl.created_at AS saved_at,
        (SELECT url FROM listing_images WHERE listing_id = l.id AND is_cover = TRUE LIMIT 1) AS cover_image
      FROM saved_listings sl
      JOIN listings l ON sl.listing_id = l.id
      WHERE sl.user_id = $1 AND l.status = 'active'
      ORDER BY sl.created_at DESC
    `, [req.user.id]);
    return ok(res, { listings: rows });
  } catch (e) {
    return fail(res, 'Failed to load saved listings', 500);
  }
});

// ── GET /api/users/agents ──────────────────────────────────
router.get('/agents', async (req, res) => {
  try {
    const { area, page = 1, limit = 20 } = req.query;
    const conditions = ["role = 'agent'", "agent_approved = TRUE", "is_active = TRUE"];
    const params = [];
    let i = 1;

    if (area) { conditions.push(`agent_areas ILIKE $${i++}`); params.push(`%${area}%`); }

    const whereSQL = 'WHERE ' + conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(limit);

    const [countRes, agentsRes] = await Promise.all([
      query(`SELECT COUNT(*) AS n FROM users ${whereSQL}`, params),
      query(`
        SELECT id, full_name, agent_tier, agent_bio, agent_areas, avatar_url, created_at
        FROM users ${whereSQL}
        ORDER BY CASE agent_tier WHEN 'senior' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END
        LIMIT $${i} OFFSET $${i+1}
      `, [...params, Number(limit), offset]),
    ]);

    const total = parseInt(countRes.rows[0].n);
    return ok(res, {
      agents: agentsRes.rows,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (e) {
    return fail(res, 'Failed to load agents', 500);
  }
});

// ── ADMIN: Get all users ───────────────────────────────────
router.get('/admin/all', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { role, page = 1, limit = 50, q } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;

    if (role) { conditions.push(`role = $${i++}`); params.push(role); }
    if (q) {
      conditions.push(`(full_name ILIKE $${i} OR email ILIKE $${i} OR phone ILIKE $${i})`);
      params.push(`%${q}%`); i++;
    }

    const whereSQL = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (Number(page) - 1) * Number(limit);

    const [countRes, usersRes] = await Promise.all([
      query(`SELECT COUNT(*) AS n FROM users ${whereSQL}`, params),
      query(`
        SELECT id,email,phone,role,full_name,nin_verified,id_verified,is_active,is_banned,
               agent_tier,agent_approved,created_at,last_login
        FROM users ${whereSQL}
        ORDER BY created_at DESC
        LIMIT $${i} OFFSET $${i+1}
      `, [...params, Number(limit), offset]),
    ]);

    const total = parseInt(countRes.rows[0].n);
    return ok(res, {
      users: usersRes.rows,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (e) {
    return fail(res, 'Failed to load users', 500);
  }
});

// ── ADMIN: Suspend/unsuspend ───────────────────────────────
router.post('/admin/:userId/suspend', authenticate, requireRole('admin'), [
  body('reason').trim().isLength({ min: 5 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Reason required', 422);

  try {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.params.userId]);
    if (!rows.length) return fail(res, 'User not found', 404);
    if (rows[0].role === 'admin') return fail(res, 'Cannot suspend another admin', 403);

    const suspend = !rows[0].is_banned;
    await query(
      'UPDATE users SET is_banned = $1, ban_reason = $2, updated_at = NOW() WHERE id = $3',
      [suspend, suspend ? req.body.reason : null, rows[0].id]
    );
    return ok(res, { message: `User ${suspend ? 'suspended' : 'reinstated'}` });
  } catch (e) {
    return fail(res, 'Failed to update user', 500);
  }
});

// ── ADMIN: Approve/reject agent ────────────────────────────
router.post('/admin/:userId/approve-agent', authenticate, requireRole('admin'), [
  body('approved').isBoolean(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422);

  try {
    const { rows } = await query("SELECT id FROM users WHERE id = $1 AND role = 'agent'", [req.params.userId]);
    if (!rows.length) return fail(res, 'Agent not found', 404);

    await query('UPDATE users SET agent_approved = $1, updated_at = NOW() WHERE id = $2', [req.body.approved, rows[0].id]);
    return ok(res, { message: `Agent ${req.body.approved ? 'approved' : 'rejected'}` });
  } catch (e) {
    return fail(res, 'Failed to update agent', 500);
  }
});

// ── ADMIN: Platform stats ──────────────────────────────────
router.get('/admin/stats', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const [users, listings, transactions, disputes, flags] = await Promise.all([
      query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE role='landlord') AS landlords,
        COUNT(*) FILTER (WHERE role='tenant') AS tenants,
        COUNT(*) FILTER (WHERE role='agent') AS agents,
        COUNT(*) FILTER (WHERE role='estate_manager') AS estate_managers
        FROM users`),
      query(`SELECT
        COUNT(*) FILTER (WHERE status != 'deleted') AS total,
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE verification_tier = 'certified') AS certified,
        COUNT(*) FILTER (WHERE status = 'draft') AS draft
        FROM listings`),
      query(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'in_escrow') AS in_escrow,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('in_escrow','released')),0) AS total_volume,
        COALESCE(SUM(platform_fee) FILTER (WHERE status IN ('in_escrow','released')),0) AS platform_revenue
        FROM transactions`),
      query(`SELECT COUNT(*) FILTER (WHERE status='open') AS open, COUNT(*) AS total FROM disputes`),
      query(`SELECT COUNT(*) FILTER (WHERE status='open') AS open FROM listing_flags`),
    ]);

    return ok(res, {
      stats: {
        users:        users.rows[0],
        listings:     listings.rows[0],
        transactions: transactions.rows[0],
        disputes:     disputes.rows[0],
        flags:        flags.rows[0],
      }
    });
  } catch (e) {
    logger.error('Admin stats error', { error: e.message });
    return fail(res, 'Failed to load stats', 500);
  }
});

module.exports = router;

// ── PATCH /api/users/tenant-profile ───────────────────────
// Tenant updates their employment profile
router.patch('/tenant-profile', authenticate, requireRole('tenant'), [
  body('employment_status').optional().isIn(['employed','self_employed','business_owner','student','retired','unemployed']),
  body('employment_type').optional().isIn(['full_time','part_time','contract','freelance','internship']),
  body('employer_name').optional().trim().isLength({ max: 100 }),
  body('job_title').optional().trim().isLength({ max: 100 }),
  body('yearly_income').optional().isInt({ min: 0 }),
  body('profile_bio').optional().trim().isLength({ max: 500 }),
  body('guarantor_name').optional().trim().isLength({ max: 100 }),
  body('guarantor_phone').optional().trim(),
  body('guarantor_relationship').optional().trim().isLength({ max: 50 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const allowed = ['employment_status','employment_type','employer_name','job_title',
      'yearly_income','profile_bio','guarantor_name','guarantor_phone','guarantor_relationship'];
    const updates = [];
    const vals = [];
    let i = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = $${i++}`);
        vals.push(req.body[key]);
      }
    }
    if (!updates.length) return fail(res, 'Nothing to update');

    // Mark profile as completed if key fields are filled
    const checkFields = ['employment_status','yearly_income'];
    const willComplete = checkFields.every(f => req.body[f] || true); // optimistic
    updates.push(`profile_completed = (employment_status IS NOT NULL AND yearly_income IS NOT NULL)`);
    updates.push(`updated_at = NOW()`);
    vals.push(req.user.id);

    const { rows } = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    return ok(res, { user: sanitizeUser(rows[0]) });
  } catch (e) {
    logger.error('PATCH /tenant-profile error', { error: e.message });
    return fail(res, 'Failed to update profile', 500);
  }
});

// ── GET /api/users/tenant-profile/:userId ─────────────────
// Landlord views a tenant's public profile for assessment
// Only accessible to landlords, agents, and admins
router.get('/tenant-profile/:userId', authenticate, async (req, res) => {
  if (!['landlord','agent','admin','estate_manager'].includes(req.user.role)) {
    return fail(res, 'Only landlords can view tenant profiles', 403);
  }

  try {
    const { rows } = await query(`
      SELECT
        id, full_name, avatar_url, phone,
        employment_status, employment_type, employer_name, job_title,
        yearly_income, income_verified, profile_bio, profile_completed,
        nin_verified, id_verified,
        guarantor_name, guarantor_phone, guarantor_relationship,
        created_at,
        -- Agreement history count
        (SELECT COUNT(*) FROM agreements WHERE tenant_id = u.id AND status = 'fully_signed')::int AS completed_tenancies,
        -- Any active agreement
        (SELECT l.title FROM agreements a JOIN listings l ON a.listing_id = l.id
         WHERE a.tenant_id = u.id AND a.status = 'fully_signed'
         ORDER BY a.created_at DESC LIMIT 1) AS current_property
      FROM users u
      WHERE id = $1 AND role = 'tenant'
    `, [req.params.userId]);

    if (!rows.length) return fail(res, 'Tenant not found', 404);

    const t = rows[0];
    // Mask sensitive fields — landlord sees income band not exact figure
    const incomeBand = t.yearly_income
      ? t.yearly_income < 1000000 ? 'Below ₦1M/yr'
      : t.yearly_income < 3000000 ? '₦1M–₦3M/yr'
      : t.yearly_income < 6000000 ? '₦3M–₦6M/yr'
      : t.yearly_income < 12000000 ? '₦6M–₦12M/yr'
      : 'Above ₦12M/yr'
      : null;

    return ok(res, {
      tenant: {
        ...t,
        yearly_income: undefined, // never expose exact figure
        income_band: incomeBand,
        verification_score: [t.nin_verified, t.id_verified, t.income_verified, t.profile_completed].filter(Boolean).length,
      }
    });
  } catch (e) {
    logger.error('GET /tenant-profile error', { error: e.message });
    return fail(res, 'Failed to load tenant profile', 500);
  }
});

// ── GET /api/users/receipts ────────────────────────────────
// Tenant gets all their payment receipts
router.get('/receipts', authenticate, requireRole('tenant'), async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        t.id, t.reference, t.amount, t.platform_fee, t.payee_amount,
        t.type, t.status, t.description, t.created_at,
        l.title AS property_title, l.area,
        u.full_name AS landlord_name,
        rs.due_date
      FROM transactions t
      JOIN listings l ON t.listing_id = l.id
      JOIN users u ON t.payee_id = u.id
      LEFT JOIN rent_schedule rs ON t.id = rs.transaction_id
      WHERE t.payer_id = $1
      ORDER BY t.created_at DESC
      LIMIT 100
    `, [req.user.id]);

    return ok(res, { receipts: rows });
  } catch (e) {
    return fail(res, 'Failed to load receipts', 500);
  }
});
