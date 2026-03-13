// src/routes/users.js — User profiles, notifications, admin user management
const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { sanitizeUser, paginate, ok, fail } = require('../utils');
const { uploadImages } = require('../middleware/upload');

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
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  const db = getDb();
  const allowed = ['full_name','phone','agent_bio'];
  const updates = [];
  const vals = [];

  for (const key of allowed) {
    if (req.body[key] !== undefined) { updates.push(`${key} = ?`); vals.push(req.body[key]); }
  }
  if (req.body.agent_areas) { updates.push('agent_areas = ?'); vals.push(JSON.stringify(req.body.agent_areas)); }
  if (req.file) { updates.push('avatar_url = ?'); vals.push(`/uploads/images/${req.file.filename}`); }

  if (!updates.length) return fail(res, 'Nothing to update', 400);
  updates.push("updated_at = datetime('now')");
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals, req.user.id);

  return ok(res, { user: sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

// ── GET /api/users/notifications ──────────────────────────
router.get('/notifications', authenticate, (req, res) => {
  const db = getDb();
  const notifs = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) as n FROM notifications WHERE user_id = ? AND read = 0').get(req.user.id).n;
  return ok(res, { notifications: notifs, unread });
});

// ── POST /api/users/notifications/read-all ────────────────
router.post('/notifications/read-all', authenticate, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  return ok(res, { message: 'All notifications marked as read' });
});

// ── GET /api/users/saved-listings ─────────────────────────
router.get('/saved-listings', authenticate, (req, res) => {
  const db = getDb();
  const listings = db.prepare(`
    SELECT l.*, sl.created_at as saved_at,
      (SELECT url FROM listing_images WHERE listing_id = l.id AND is_cover = 1 LIMIT 1) as cover_image
    FROM saved_listings sl
    JOIN listings l ON sl.listing_id = l.id
    WHERE sl.user_id = ? AND l.status = 'active'
    ORDER BY sl.created_at DESC
  `).all(req.user.id);
  return ok(res, { listings });
});

// ── GET /api/users/agents ──────────────────────────────────
// Public: browse approved agents
router.get('/agents', (req, res) => {
  const db = getDb();
  const { area, page = 1, limit = 20 } = req.query;
  const where = ["role = 'agent'", "agent_approved = 1", "is_active = 1"];
  const params = [];

  if (area) { where.push('agent_areas LIKE ?'); params.push(`%${area}%`); }

  const total = db.prepare(`SELECT COUNT(*) as n FROM users WHERE ${where.join(' AND ')}`).get(...params).n;
  const offset = (Number(page) - 1) * Number(limit);
  const agents = db.prepare(`
    SELECT id, full_name, agent_tier, agent_bio, agent_areas, avatar_url, created_at
    FROM users WHERE ${where.join(' AND ')}
    ORDER BY CASE agent_tier WHEN 'senior' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), offset);

  return ok(res, { agents, pagination: paginate(total, Number(page), Number(limit)) });
});

// ── ADMIN: Get all users ───────────────────────────────────
router.get('/admin/all', authenticate, requireRole('admin'), (req, res) => {
  const db = getDb();
  const { role, page = 1, limit = 50, q } = req.query;
  const where = [];
  const params = [];

  if (role) { where.push('role = ?'); params.push(role); }
  if (q) {
    where.push('(full_name LIKE ? OR email LIKE ? OR phone LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as n FROM users ${whereSQL}`).get(...params).n;
  const offset = (Number(page) - 1) * Number(limit);
  const users = db.prepare(`SELECT id,email,phone,role,full_name,nin_verified,id_verified,is_active,is_banned,agent_tier,agent_approved,created_at,last_login FROM users ${whereSQL} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(limit), offset);

  return ok(res, { users, pagination: paginate(total, Number(page), Number(limit)) });
});

// ── ADMIN: Suspend/unsuspend user ─────────────────────────
router.post('/admin/:userId/suspend', authenticate, requireRole('admin'), [
  body('reason').trim().isLength({ min: 5 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return fail(res, 'User not found', 404);
  if (user.role === 'admin') return fail(res, 'Cannot suspend another admin', 403);

  const suspend = !user.is_banned;
  db.prepare('UPDATE users SET is_banned = ?, ban_reason = ?, updated_at = datetime("now") WHERE id = ?')
    .run(suspend ? 1 : 0, suspend ? req.body.reason : null, user.id);

  return ok(res, { message: `User ${suspend ? 'suspended' : 'reinstated'}`, user_id: user.id });
});

// ── ADMIN: Approve/reject agent application ───────────────
router.post('/admin/:userId/approve-agent', authenticate, requireRole('admin'), [
  body('approved').isBoolean(),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent'").get(req.params.userId);
  if (!user) return fail(res, 'Agent not found', 404);

  db.prepare('UPDATE users SET agent_approved = ?, updated_at = datetime("now") WHERE id = ?')
    .run(req.body.approved ? 1 : 0, user.id);

  return ok(res, { message: `Agent ${req.body.approved ? 'approved' : 'rejected'}` });
});

// ── ADMIN: Platform stats ──────────────────────────────────
router.get('/admin/stats', authenticate, requireRole('admin'), (req, res) => {
  const db = getDb();
  const stats = {
    users: {
      total: db.prepare('SELECT COUNT(*) as n FROM users').get().n,
      landlords: db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'landlord'").get().n,
      tenants: db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'tenant'").get().n,
      agents: db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'agent'").get().n,
    },
    listings: {
      total: db.prepare("SELECT COUNT(*) as n FROM listings WHERE status != 'deleted'").get().n,
      active: db.prepare("SELECT COUNT(*) as n FROM listings WHERE status = 'active'").get().n,
      certified: db.prepare("SELECT COUNT(*) as n FROM listings WHERE verification_tier = 'certified'").get().n,
      pending_verification: db.prepare("SELECT COUNT(*) as n FROM verifications WHERE overall_status = 'in_progress'").get().n,
    },
    transactions: {
      total: db.prepare('SELECT COUNT(*) as n FROM transactions').get().n,
      in_escrow: db.prepare("SELECT COUNT(*) as n FROM transactions WHERE status = 'in_escrow'").get().n,
      total_volume: db.prepare("SELECT COALESCE(SUM(amount),0) as n FROM transactions WHERE status IN ('in_escrow','released')").get().n,
      platform_revenue: db.prepare("SELECT COALESCE(SUM(platform_fee),0) as n FROM transactions WHERE status IN ('in_escrow','released')").get().n,
    },
    disputes: {
      open: db.prepare("SELECT COUNT(*) as n FROM disputes WHERE status = 'open'").get().n,
      total: db.prepare('SELECT COUNT(*) as n FROM disputes').get().n,
    },
    flags: {
      open: db.prepare("SELECT COUNT(*) as n FROM listing_flags WHERE status = 'open'").get().n,
    }
  };
  return ok(res, { stats });
});

module.exports = router;
