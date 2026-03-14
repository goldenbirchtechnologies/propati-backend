// src/services/encryption.js — Field-level encryption for sensitive data
// Used for: NIN, BVN, ID numbers, document paths, agreement content
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // bytes = 256 bits

// Load and validate encryption key
function getKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length < 64) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY must be set in production (64-char hex = 32 bytes)');
    }
    // Dev fallback — never use in production
    console.warn('⚠️  Using dev encryption key. Set ENCRYPTION_KEY in .env for production!');
    return crypto.scryptSync('propati-dev-key-never-use-in-prod', 'salt', KEY_LENGTH);
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * Encrypt a string value.
 * Returns a base64 string containing: iv:authTag:ciphertext
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(String(plaintext), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted
  ].join(':');
}

/**
 * Decrypt an encrypted field value.
 */
function decrypt(encryptedValue) {
  if (!encryptedValue) return null;
  const key = getKey();
  const [ivB64, authTagB64, ciphertext] = encryptedValue.split(':');

  if (!ivB64 || !authTagB64 || !ciphertext) {
    throw new Error('Invalid encrypted value format');
  }

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Hash a value one-way (for NIN lookup without storing plaintext).
 * Use when you need to check "does this NIN exist" without decrypting everything.
 */
function hashForLookup(value) {
  if (!value) return null;
  return crypto
    .createHmac('sha256', process.env.ENCRYPTION_KEY || 'dev-lookup-key')
    .update(String(value).toLowerCase().trim())
    .digest('hex');
}

/**
 * Safely encrypt a field — returns null if value is falsy.
 */
function encryptField(value) {
  return value ? encrypt(value) : null;
}

/**
 * Safely decrypt a field — returns null if value is falsy or decryption fails.
 */
function decryptField(value) {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch (e) {
    console.error('Decryption failed:', e.message);
    return '[decryption_error]';
  }
}

module.exports = { encrypt, decrypt, hashForLookup, encryptField, decryptField };
