// src/db/migrate_v3.js — Tenant profile fields
require('dotenv').config();
const { query } = require('./index');
const logger = require('../services/logger');

async function migrateV3() {
  logger.info('Running migration v3 — tenant profile fields...');

  const patches = [
    // Tenant employment profile
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_status TEXT CHECK(employment_status IN ('employed','self_employed','business_owner','student','retired','unemployed'))`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_type TEXT CHECK(employment_type IN ('full_time','part_time','contract','freelance','internship'))`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS employer_name TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS yearly_income BIGINT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS income_verified BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_bio TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_completed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS guarantor_name TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS guarantor_phone TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS guarantor_relationship TEXT`,
    // Fix role constraint to include estate_manager
    `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
    `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('landlord','tenant','agent','admin','estate_manager'))`,
  ];

  for (const sql of patches) {
    try {
      await query(sql);
      logger.info('  ✓ ' + sql.slice(0, 70));
    } catch (e) {
      if (e.message.includes('already exists')) {
        logger.debug('  skip (exists): ' + sql.slice(0, 50));
      } else {
        logger.warn('  ⚠ ' + e.message.slice(0, 80));
      }
    }
  }

  logger.info('✅ Migration v3 complete');
}

// Only exit when run directly — not when imported by migrate.js
if (require.main === module) {
  migrateV3()
    .then(() => process.exit(0))
    .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { migrateV3 };
