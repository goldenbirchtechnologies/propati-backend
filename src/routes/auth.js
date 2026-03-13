// src/routes/auth.js — PostgreSQL + encrypted KYC fields
const router    = require('express').Router();
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query, transaction } = require('../db');
const { generateTokens, sanitizeUser, ok, fail } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { verifyNIN } = require('../services/nimc');
const { createNotification } = require('../services/notifications');
const { encryptField, hashForLookup } = require('../services/encryption');
const logger    = require('../services/logger');

// ── POST /api/auth/signup ──────────────────────────────────
router.post('/signup', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[A-Z])(?=.*[0-9])/),
  body('full_name').trim().isLength({ min: 2, max: 100 }),
  body('role').isIn(['landlord', 'tenant', 'agent']),
  body('phone').optional().isMobilePhone('any'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  const { email, password, full_name, role, phone } = req.body;

  try {
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) return fail(res, 'Email already registered', 409);

    if (phone) {
      const phoneExists = await query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (phoneExists.rows.length) return fail(res, 'Phone number already registered', 409);
    }

    const id = 'usr_' + uuidv4().replace(/-/g, '').slice(0, 16);
    const hashed = await bcrypt.hash(password, 12);

    await query(
      `INSERT INTO users (id, email, phone, password, role, full_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, email, phone || null, hashed, role, full_name]
    );

    const { access, refresh } = generateTokens(id);
    const refreshId   = uuidv4();
    const refreshHash = await bcrypt.hash(refresh, 8);
    const refreshExp  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await query(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
      [refreshId, id, refreshHash, refreshExp]
    );

    const userResult = await query('SELECT * FROM users WHERE id = $1', [id]);
    createNotification(id, 'welcome', 'Welcome to PROPATI! 🏠',
      `Hi ${full_name.split(' ')[0]}, your account is ready. Complete KYC to unlock all features.`);

    logger.auth('signup', id, { role, email });
    return ok(res, { message: 'Account created', user: sanitizeUser(userResult.rows[0]), access_token: access, refresh_token: refresh }, 201);
  } catch (err) {
    logger.error('Signup error', { error: err.message, email });
    return fail(res, 'Registration failed', 500);
  }
});

// ── POST /api/auth/login ───────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  const { email, password } = req.body;

  try {
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      // Timing-safe: still run bcrypt even for nonexistent user
      await bcrypt.compare(password, '$2a$12$notarealhashbutneedstimingprotection123456');
      return fail(res, 'Invalid email or password', 401);
    }
    if (user.is_banned)   return fail(res, 'Account suspended. Contact support@propati.ng', 403);
    if (!user.is_active)  return fail(res, 'Account deactivated', 403);

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      logger.security('Failed login attempt', req.ip, { email });
      return fail(res, 'Invalid email or password', 401);
    }

    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    await query('DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at < NOW()', [user.id]);

    const { access, refresh } = generateTokens(user.id);
    const refreshId   = uuidv4();
    const refreshHash = await bcrypt.hash(refresh, 8);
    const refreshExp  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await query(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
      [refreshId, user.id, refreshHash, refreshExp]
    );

    logger.auth('login', user.id, { role: user.role });
    return ok(res, { user: sanitizeUser(user), access_token: access, refresh_token: refresh });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    return fail(res, 'Login failed', 500);
  }
});

// ── POST /api/auth/refresh ─────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return fail(res, 'Refresh token required', 400);

  let payload;
  try {
    payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
  } catch {
    return fail(res, 'Invalid or expired refresh token', 401);
  }

  try {
    const tokens = await query(
      'SELECT * FROM refresh_tokens WHERE user_id = $1 AND expires_at > NOW()',
      [payload.sub]
    );

    let valid = false;
    for (const t of tokens.rows) {
      if (await bcrypt.compare(refresh_token, t.token_hash)) { valid = true; break; }
    }
    if (!valid) return fail(res, 'Refresh token not recognised', 401);

    const { access, refresh: newRefresh } = generateTokens(payload.sub);
    return ok(res, { access_token: access, refresh_token: newRefresh });
  } catch (err) {
    return fail(res, 'Token refresh failed', 500);
  }
});

// ── POST /api/auth/logout ──────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  await query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);
  logger.auth('logout', req.user.id);
  return ok(res, { message: 'Logged out' });
});

// ── GET /api/auth/me ───────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  return ok(res, { user: sanitizeUser(req.user) });
});

// ── POST /api/auth/kyc/nin ─────────────────────────────────
// Verify NIN — stores encrypted NIN + HMAC hash for lookup
router.post('/kyc/nin', authenticate, [
  body('nin').isLength({ min: 11, max: 11 }).isNumeric(),
  body('first_name').trim().notEmpty(),
  body('last_name').trim().notEmpty(),
  body('date_of_birth').isISO8601(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  const { nin, first_name, last_name, date_of_birth } = req.body;

  // Check if NIN already registered to another account
  const ninHash = hashForLookup(nin);
  const existing = await query('SELECT id FROM users WHERE nin_hash = $1 AND id != $2', [ninHash, req.user.id]);
  if (existing.rows.length) {
    logger.security('Duplicate NIN attempt', req.ip, { userId: req.user.id });
    return fail(res, 'This NIN is already linked to another account', 409);
  }

  const result = await verifyNIN(nin, first_name, last_name, date_of_birth);
  if (!result.success) return fail(res, result.error || 'NIN verification failed', 400);

  // Store encrypted NIN — never plaintext in DB
  const ninEncrypted = encryptField(nin);
  await query(
    'UPDATE users SET nin_encrypted = $1, nin_hash = $2, nin_verified = TRUE, updated_at = NOW() WHERE id = $3',
    [ninEncrypted, ninHash, req.user.id]
  );

  logger.auth('NIN verified', req.user.id);
  createNotification(req.user.id, 'kyc_success', 'NIN Verified ✓',
    'Your NIN has been verified. You can now list properties.');

  return ok(res, { message: 'NIN verified successfully', verified: true });
});

// ── PATCH /api/auth/password ───────────────────────────────
router.patch('/password', authenticate, [
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 8 }).matches(/^(?=.*[A-Z])(?=.*[0-9])/),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  const { current_password, new_password } = req.body;
  const userResult = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = userResult.rows[0];

  if (!await bcrypt.compare(current_password, user.password))
    return fail(res, 'Current password is incorrect', 401);

  const hashed = await bcrypt.hash(new_password, 12);
  await query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, req.user.id]);
  await query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);

  logger.auth('password_changed', req.user.id);
  return ok(res, { message: 'Password updated. Please log in again.' });
});

module.exports = router;
