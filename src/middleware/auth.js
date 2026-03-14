// src/middleware/auth.js — Auth middleware (Clerk + JWT fallback)
'use strict';
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const logger = require('../services/logger');

const useClerk = () => !!process.env.CLERK_SECRET_KEY;

let _clerkClient = null;
function getClerkClient() {
  if (!_clerkClient && useClerk()) {
    const { createClerkClient } = require('@clerk/express');
    _clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  }
  return _clerkClient;
}

// ── Clerk auth: verify session token, look up local user ──
async function authenticateClerk(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    const clerk = getClerkClient();
    const payload = await clerk.verifyToken(token);
    const clerkUserId = payload.sub;

    // Look up local user by clerk_user_id, fall back to email
    let result = await query(
      'SELECT * FROM users WHERE clerk_user_id = $1 AND is_active = TRUE AND is_banned = FALSE',
      [clerkUserId]
    );

    if (!result.rows.length) {
      // First Clerk login — try to match by email from Clerk user profile
      const clerkUser = await clerk.users.getUser(clerkUserId);
      const email = clerkUser.emailAddresses?.[0]?.emailAddress;
      if (email) {
        result = await query(
          'SELECT * FROM users WHERE email = $1 AND is_active = TRUE AND is_banned = FALSE',
          [email]
        );
        if (result.rows.length) {
          // Link Clerk ID to existing user
          await query('UPDATE users SET clerk_user_id = $1 WHERE id = $2', [clerkUserId, result.rows[0].id]);
        }
      }
    }

    if (!result.rows.length) {
      return res.status(401).json({ success: false, error: 'User not found or deactivated' });
    }

    req.user = result.rows[0];
    if (process.env.SENTRY_DSN) {
      require('@sentry/node').setUser({ id: req.user.id, email: req.user.email, role: req.user.role });
    }
    next();
  } catch (e) {
    logger.security('Clerk token verification failed', req.ip, { path: req.path, error: e.message });
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

// ── Legacy JWT auth ──
async function authenticateJWT(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await query(
      'SELECT * FROM users WHERE id = $1 AND is_active = TRUE AND is_banned = FALSE',
      [payload.sub]
    );
    if (!result.rows.length) {
      return res.status(401).json({ success: false, error: 'User not found or deactivated' });
    }
    req.user = result.rows[0];
    if (process.env.SENTRY_DSN) {
      require('@sentry/node').setUser({ id: req.user.id, email: req.user.email, role: req.user.role });
    }
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError')
      return res.status(401).json({ success: false, error: 'Token expired', code: 'TOKEN_EXPIRED' });
    logger.security('Invalid token attempt', req.ip, { path: req.path });
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

// ── Main authenticate — routes to Clerk or JWT ──
async function authenticate(req, res, next) {
  if (useClerk()) return authenticateClerk(req, res, next);
  return authenticateJWT(req, res, next);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      logger.security('Unauthorized role access', req.ip, {
        userId: req.user.id, required: roles, actual: req.user.role, path: req.path
      });
      return res.status(403).json({ success: false, error: `Access denied. Required: ${roles.join(' or ')}` });
    }
    next();
  };
}

async function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  try {
    if (useClerk()) {
      const clerk = getClerkClient();
      const payload = await clerk.verifyToken(header.slice(7));
      const result = await query('SELECT * FROM users WHERE clerk_user_id = $1', [payload.sub]);
      req.user = result.rows[0] || null;
    } else {
      const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      const result = await query('SELECT * FROM users WHERE id = $1', [payload.sub]);
      req.user = result.rows[0] || null;
    }
  } catch (_) { req.user = null; }
  next();
}

module.exports = { authenticate, requireRole, optionalAuth };
