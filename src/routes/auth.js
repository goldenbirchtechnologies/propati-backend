// src/routes/auth.js — Full auth with email notifications + phone verification
'use strict';
const router    = require('express').Router();
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { generateTokens, sanitizeUser, ok, fail } = require('../utils');
const { authenticate } = require('../middleware/auth');
const { createNotification, sendTemplateEmail, sendSMS } = require('../services/notifications');
const logger = require('../services/logger');

// ── POST /api/auth/signup ──────────────────────────────────
router.post('/signup', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[A-Z])(?=.*[0-9])/)
    .withMessage('Password must be at least 8 characters with one uppercase and one number'),
  body('full_name').trim().isLength({ min: 2, max: 100 }),
  body('role').isIn(['landlord','tenant','agent','estate_manager'])
    .withMessage('Role must be landlord, tenant, agent, or estate_manager'),
  body('phone').optional().isMobilePhone('any'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422, errors.array());

  const { email, password, full_name, role, phone } = req.body;

  try {
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) return fail(res, 'This email is already registered. Try signing in.', 409);

    if (phone) {
      const phoneExists = await query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (phoneExists.rows.length) return fail(res, 'Phone number already in use', 409);
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

    // ── Welcome notifications (non-blocking) ────────────────
    const firstName = full_name.split(' ')[0];

    // In-app notification
    createNotification(id, 'welcome', 'Welcome to PROPATI! 🏠',
      `Hi ${firstName}, your account is ready. Complete your profile to unlock all features.`
    ).catch(() => {});

    // Welcome email
    sendTemplateEmail(email, 'welcome', { name: full_name }).catch(() => {});

    // Welcome SMS
    if (phone) {
      sendSMS(phone,
        `Welcome to PROPATI, ${firstName}! 🏠 Nigeria's verified property platform. Login at propati.ng`
      ).catch(() => {});
    }

    // Phone verification OTP (if phone provided)
    if (phone) {
      sendPhoneOTP(id, phone).catch(() => {});
    }

    const userResult = await query('SELECT * FROM users WHERE id = $1', [id]);
    logger.info('signup', { id, role, email });

    return ok(res, {
      message: 'Account created! Check your email for a welcome message.',
      user: sanitizeUser(userResult.rows[0]),
      access_token: access,
      refresh_token: refresh,
    }, 201);
  } catch (err) {
    logger.error('Signup error', { error: err.message, email });
    return fail(res, 'Registration failed. Please try again.', 500);
  }
});

// ── POST /api/auth/login ───────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Please enter your email and password', 422);

  const { email, password } = req.body;

  try {
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      await bcrypt.compare(password, '$2a$12$notarealhashbutneedstimingprotection123456');
      return fail(res, 'Invalid email or password', 401);
    }
    if (user.is_banned)  return fail(res, 'Account suspended. Contact support@propati.ng', 403);
    if (!user.is_active) return fail(res, 'Account deactivated', 403);

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      logger.warn('Failed login', { ip: req.ip, email });
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

    return ok(res, { user: sanitizeUser(user), access_token: access, refresh_token: refresh });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    return fail(res, 'Login failed', 500);
  }
});

// ── POST /api/auth/forgot-password ────────────────────────
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Valid email required', 422);

  // Always return success to prevent email enumeration
  const successMsg = 'If this email is registered, you\'ll receive a reset link shortly.';

  try {
    const { rows } = await query('SELECT id, full_name, email FROM users WHERE email = $1', [req.body.email]);
    if (!rows.length) return ok(res, { message: successMsg });

    const user = rows[0];
    const token = uuidv4().replace(/-/g, '');
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store reset token
    await query(
      `INSERT INTO password_resets (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET token_hash=$3, expires_at=$4, created_at=NOW()`,
      [uuidv4(), user.id, await bcrypt.hash(token, 8), expiry]
    ).catch(async () => {
      // Table might not exist yet — create it
      await query(`CREATE TABLE IF NOT EXISTS password_resets (
        id TEXT PRIMARY KEY, user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
      await query(
        `INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id) DO UPDATE SET token_hash=$3, expires_at=$4, created_at=NOW()`,
        [uuidv4(), user.id, await bcrypt.hash(token, 8), expiry]
      );
    });

    const resetUrl = `${process.env.FRONTEND_URL || 'https://propati.ng'}?reset=${token}&uid=${user.id}`;
    const { sendEmail } = require('../services/notifications');
    const { wrap } = require('../services/notifications');

    await sendEmail(user.email, 'Reset your PROPATI password',
      `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
      <body style="margin:0;padding:0;background:#F5F3EE;font-family:Inter,system-ui,sans-serif">
      <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
        <div style="background:#0B1220;padding:20px 28px"><span style="font-size:18px;font-weight:900;color:#fff">PROPATI</span></div>
        <div style="padding:28px">
          <h2 style="color:#0B1220;margin:0 0 8px">Reset your password</h2>
          <p style="color:#4B5563">Hi ${user.full_name.split(' ')[0]}, click the button below to reset your password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;margin:16px 0;background:#0e7c6a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Reset Password →</a>
          <p style="color:#9CA3AF;font-size:12px">If you didn't request this, ignore this email. Your password won't change.</p>
        </div>
      </div></body></html>`
    ).catch(() => {});

    return ok(res, { message: successMsg });
  } catch (err) {
    logger.error('Forgot password error', { error: err.message });
    return ok(res, { message: successMsg }); // still return success
  }
});

// ── POST /api/auth/reset-password ─────────────────────────
router.post('/reset-password', [
  body('token').notEmpty(),
  body('user_id').notEmpty(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[A-Z])(?=.*[0-9])/),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const { token, user_id, password } = req.body;
    const { rows } = await query(
      'SELECT * FROM password_resets WHERE user_id = $1 AND expires_at > NOW()',
      [user_id]
    );
    if (!rows.length) return fail(res, 'Reset link has expired. Request a new one.', 400);

    const valid = await bcrypt.compare(token, rows[0].token_hash);
    if (!valid) return fail(res, 'Invalid reset link', 400);

    const hashed = await bcrypt.hash(password, 12);
    await query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, user_id]);
    await query('DELETE FROM password_resets WHERE user_id = $1', [user_id]);
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [user_id]); // invalidate all sessions

    return ok(res, { message: 'Password reset successfully. Please sign in.' });
  } catch (err) {
    logger.error('Reset password error', { error: err.message });
    return fail(res, 'Password reset failed', 500);
  }
});

// ── POST /api/auth/send-phone-otp ─────────────────────────
router.post('/send-phone-otp', authenticate, async (req, res) => {
  const phone = req.user.phone || req.body.phone;
  if (!phone) return fail(res, 'Phone number required');

  try {
    await sendPhoneOTP(req.user.id, phone);
    return ok(res, { message: 'OTP sent to ' + phone.slice(0,4) + '****' + phone.slice(-3) });
  } catch (err) {
    return fail(res, 'Failed to send OTP: ' + err.message, 500);
  }
});

// ── POST /api/auth/verify-phone ───────────────────────────
router.post('/verify-phone', authenticate, [
  body('otp').isLength({ min: 4, max: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'OTP required', 422);

  try {
    const { rows } = await query(
      `SELECT * FROM phone_otps WHERE user_id = $1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) return fail(res, 'OTP expired. Request a new one.', 400);

    const valid = await bcrypt.compare(req.body.otp, rows[0].otp_hash);
    if (!valid) return fail(res, 'Incorrect OTP', 400);

    await query('UPDATE users SET phone_verified = TRUE WHERE id = $1', [req.user.id]);
    await query('DELETE FROM phone_otps WHERE user_id = $1', [req.user.id]);

    return ok(res, { message: 'Phone number verified! ✅' });
  } catch (err) {
    logger.error('Phone verify error', { error: err.message });
    return fail(res, 'Verification failed', 500);
  }
});

// ── POST /api/auth/refresh ─────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return fail(res, 'Refresh token required', 400);

  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
    if (payload.type !== 'refresh') return fail(res, 'Invalid token type', 401);

    const { rows } = await query(
      'SELECT * FROM refresh_tokens WHERE user_id = $1 AND expires_at > NOW()',
      [payload.sub]
    );
    if (!rows.length) return fail(res, 'Session expired', 401);

    const valid = await Promise.any(
      rows.map(r => bcrypt.compare(refresh_token, r.token_hash))
    ).catch(() => false);
    if (!valid) return fail(res, 'Invalid session', 401);

    const userResult = await query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (!userResult.rows.length) return fail(res, 'User not found', 404);

    const { access, refresh: newRefresh } = generateTokens(payload.sub);
    const newHash = await bcrypt.hash(newRefresh, 8);
    const newExp  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await query(
      'INSERT INTO refresh_tokens (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)',
      [uuidv4(), payload.sub, newHash, newExp]
    );

    return ok(res, { access_token: access, refresh_token: newRefresh, user: sanitizeUser(userResult.rows[0]) });
  } catch (err) {
    return fail(res, 'Session refresh failed', 401);
  }
});

// ── GET /api/auth/me ───────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return fail(res, 'User not found', 404);
    return ok(res, { user: sanitizeUser(rows[0]) });
  } catch (err) {
    return fail(res, 'Failed to load user', 500);
  }
});

// ── POST /api/auth/logout ──────────────────────────────────
router.post('/logout', authenticate, async (req, res) => {
  try {
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [req.user.id]);
    return ok(res, { message: 'Signed out' });
  } catch (err) {
    return ok(res, { message: 'Signed out' });
  }
});

// ── Helper: send phone OTP ─────────────────────────────────
async function sendPhoneOTP(userId, phone) {
  const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
  const hash = await bcrypt.hash(otp, 8);
  const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  // Create table if needed
  await query(`CREATE TABLE IF NOT EXISTS phone_otps (
    id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    otp_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});

  await query(
    `INSERT INTO phone_otps (id,user_id,otp_hash,expires_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING`,
    [uuidv4(), userId, hash, expiry]
  );

  // Try WhatsApp first via Twilio, fall back to SMS
  const sent = await sendWhatsAppOTP(phone, otp).catch(() => false);
  if (!sent) {
    await sendSMS(phone,
      `PROPATI verification code: ${otp}\nValid for 10 minutes. Do not share this code.`
    );
  }
}

// ── Helper: send OTP via WhatsApp (Twilio) ────────────────
async function sendWhatsAppOTP(phone, otp) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    logger.info(`[WhatsApp OTP DEV] → ${phone}: ${otp}`);
    return true; // mock success in dev
  }

  // Normalise phone to E.164
  let n = phone.toString().trim().replace(/\D/g, '');
  if (n.startsWith('0')) n = '234' + n.slice(1);
  if (!n.startsWith('+')) n = '+' + n;

  const axios = require('axios');
  const creds = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');

  const body = new URLSearchParams({
    From: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || '+14155238886'}`,
    To:   `whatsapp:${n}`,
    Body: `Your PROPATI verification code is: *${otp}*\n\nValid for 10 minutes. Do not share this code.`,
  });

  const res = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    body.toString(),
    { headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );

  if (res.data?.sid) {
    logger.info('WhatsApp OTP sent', { phone: n.slice(0,6) + '***', sid: res.data.sid });
    return true;
  }
  return false;
}

module.exports = router;
