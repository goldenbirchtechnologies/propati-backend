// src/db/migrate_v4.js — Clerk integration: add clerk_user_id column
'use strict';
const { query } = require('./index');
const logger = require('../services/logger');

async function migrateV4() {
  try {
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT UNIQUE`);
    logger.info('migrate_v4: clerk_user_id column ready');
  } catch (e) {
    logger.error('migrate_v4 error', { error: e.message });
  }
}

module.exports = { migrateV4 };
