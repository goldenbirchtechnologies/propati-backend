// src/middleware/auth.js — JWT verification with PostgreSQL
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const logger = require('../services/logger');

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result  = await query(
      'SELECT * FROM users WHERE id = $1 AND is_active = TRUE AND is_banned = FALSE',
      [payload.sub]
    );
    if (!result.rows.length) {
      return res.status(401).json({ success: false, error: 'User not found or deactivated' });
    }
    req.user = result.rows[0];
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError')
      return res.status(401).json({ success: false, error: 'Token expired', code: 'TOKEN_EXPIRED' });
    logger.security('Invalid token attempt', req.ip, { path: req.path });
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
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
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const result  = await query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    req.user = result.rows[0] || null;
  } catch (_) { req.user = null; }
  next();
}

module.exports = { authenticate, requireRole, optionalAuth };
