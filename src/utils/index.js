// src/utils/index.js
const jwt    = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

function generateTokens(userId) {
  const access = jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m'
  });
  const refresh = jwt.sign({ sub: userId, type: 'refresh' }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
  });
  return { access, refresh };
}

// Strip sensitive fields — never send password, NIN, BVN to client
function sanitizeUser(user) {
  if (!user) return null;
  const { password, nin_encrypted, nin_hash, bvn_encrypted, id_number_enc, ...safe } = user;
  return safe;
}

function computeFees(type, amount) {
  const rates     = { rent:0.10, sale:amount>20_000_000?0.01:0.02, short_let:0.05, commercial:0.08, share:0.05 };
  const agentRate = { rent:0.10, sale:amount>20_000_000?0.01:0.015, short_let:0.03, commercial:0.05 };
  const platformFee      = Math.round(amount * (rates[type] || 0.10));
  const agentCommission  = Math.round(amount * (agentRate[type] || 0));
  const payeeAmount      = amount - platformFee;
  return { platformFee, agentCommission, payeeAmount };
}

function paginate(total, page, limit) {
  const pages = Math.ceil(total / limit);
  return { total, page, limit, pages, hasNext: page < pages, hasPrev: page > 1 };
}

function generateRef() {
  return `PROPATI-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function generateQRCode() {
  const code    = `PROPATI-QR-${uuidv4().toUpperCase()}`;
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return { code, expires };
}

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, ...data });
}
function fail(res, message, status = 400, details = null) {
  const resp = { success: false, error: message };
  if (details) resp.details = details;
  return res.status(status).json(resp);
}

module.exports = { generateTokens, sanitizeUser, computeFees, paginate, generateRef, generateQRCode, ok, fail };
