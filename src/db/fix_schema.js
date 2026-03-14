// src/db/fix_schema.js — Patch all missing columns
require('dotenv').config();
const { query } = require('./index');

async function fix() {
  console.log('🔧 Fixing schema...');

  const patches = [
    // conversations
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tenant_unread INT DEFAULT 0`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS landlord_unread INT DEFAULT 0`,
    `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`,
    // messages
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS body TEXT`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read INT DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type TEXT`,
    // org_members
    `ALTER TABLE org_members ADD COLUMN IF NOT EXISTS email TEXT`,
    `ALTER TABLE org_members ADD COLUMN IF NOT EXISTS invite_token TEXT`,
    `ALTER TABLE org_members ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`,
    // organisations
    `ALTER TABLE organisations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
    // maintenance_tickets
    `ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS raised_by TEXT REFERENCES users(id)`,
    `ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS resolution_note TEXT`,
    `ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`,
    `ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
    // org_subscriptions
    `ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ`,
    `ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ`,
    `ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMPTZ`,
    // listings
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS views_count INT DEFAULT 0`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS agent_id TEXT REFERENCES users(id)`,
    // listing_images
    `ALTER TABLE listing_images ADD COLUMN IF NOT EXISTS public_id TEXT`,
    // users
    `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
    `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('landlord','tenant','agent','admin','estate_manager'))`,
  ];

  for (const sql of patches) {
    try {
      await query(sql);
      console.log('  ✓', sql.slice(0, 60));
    } catch (e) {
      console.log('  ⚠ skipped:', e.message.slice(0, 80));
    }
  }

  console.log('\n✅ Schema fix complete. Now run: npm run seed');
  process.exit(0);
}

fix().catch(e => { console.error('Fix error:', e.message); process.exit(1); });
