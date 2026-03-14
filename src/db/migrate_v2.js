// src/db/migrate_v2.js — PROPATI migration v2
// Adds: messages, conversations, organisations, org_members,
//       maintenance_tickets, org_subscriptions, email_log
// Run: node src/db/migrate_v2.js
require('dotenv').config();
const { query } = require('./index');
const logger = require('../services/logger');

const v2sql = `
  -- ─────────────────────────────────────────────────────────
  -- CONVERSATIONS & MESSAGES
  -- ─────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS conversations (
    id            TEXT PRIMARY KEY,
    listing_id    TEXT REFERENCES listings(id) ON DELETE SET NULL,
    landlord_id   TEXT NOT NULL REFERENCES users(id),
    tenant_id     TEXT NOT NULL REFERENCES users(id),
    subject       TEXT,
    last_message  TEXT,
    last_msg_at   TIMESTAMPTZ,
    unread_landlord INTEGER DEFAULT 0,
    unread_tenant   INTEGER DEFAULT 0,
    is_archived   BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(listing_id, tenant_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       TEXT NOT NULL REFERENCES users(id),
    content         TEXT NOT NULL,
    type            TEXT DEFAULT 'text' CHECK(type IN ('text','image','document','system')),
    attachment_url  TEXT,
    is_read         BOOLEAN DEFAULT FALSE,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_landlord ON conversations(landlord_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_tenant   ON conversations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_messages_conv          ON messages(conversation_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_sender        ON messages(sender_id);

  -- ─────────────────────────────────────────────────────────
  -- ORGANISATIONS (Estate Manager B2B)
  -- ─────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS organisations (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    owner_id              TEXT NOT NULL REFERENCES users(id),
    plan_tier             TEXT DEFAULT 'starter' CHECK(plan_tier IN ('starter','growth','enterprise')),
    max_units             INTEGER DEFAULT 20,
    max_seats             INTEGER DEFAULT 1,
    billing_email         TEXT NOT NULL,
    address               TEXT,
    cac_number            TEXT,
    paystack_customer_id  TEXT,
    logo_url              TEXT,
    is_active             BOOLEAN DEFAULT TRUE,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS org_members (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id     TEXT REFERENCES users(id),
    email       TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('manager','accountant','maintenance','owner_view')),
    invited_by  TEXT REFERENCES users(id),
    status      TEXT DEFAULT 'pending' CHECK(status IN ('pending','active','removed')),
    invite_token TEXT UNIQUE,
    joined_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, email)
  );

  CREATE TABLE IF NOT EXISTS org_listings (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    added_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, listing_id)
  );

  CREATE TABLE IF NOT EXISTS maintenance_tickets (
    id            TEXT PRIMARY KEY,
    org_id        TEXT REFERENCES organisations(id),
    listing_id    TEXT REFERENCES listings(id),
    tenant_id     TEXT REFERENCES users(id),
    raised_by     TEXT NOT NULL REFERENCES users(id),
    title         TEXT NOT NULL,
    description   TEXT,
    category      TEXT DEFAULT 'other' CHECK(category IN ('plumbing','electrical','structural','security','cleaning','other')),
    priority      TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
    status        TEXT DEFAULT 'open' CHECK(status IN ('open','assigned','in_progress','resolved','closed')),
    assigned_to   TEXT REFERENCES users(id),
    photo_urls    JSONB,
    resolution_note TEXT,
    resolved_at   TIMESTAMPTZ,
    closed_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS org_subscriptions (
    id                    TEXT PRIMARY KEY,
    org_id                TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    paystack_sub_id       TEXT UNIQUE,
    paystack_customer_code TEXT,
    plan                  TEXT NOT NULL,
    status                TEXT DEFAULT 'active' CHECK(status IN ('active','paused','cancelled','past_due')),
    amount                BIGINT,
    current_period_start  TIMESTAMPTZ,
    current_period_end    TIMESTAMPTZ,
    next_billing_date     TIMESTAMPTZ,
    cancelled_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
  );

  -- ─────────────────────────────────────────────────────────
  -- AGREEMENT SIGNING (e-sign audit trail)
  -- ─────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS agreement_signatures (
    id            TEXT PRIMARY KEY,
    agreement_id  TEXT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
    signer_id     TEXT NOT NULL REFERENCES users(id),
    role          TEXT NOT NULL CHECK(role IN ('landlord','tenant','agent','witness')),
    signed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address    TEXT,
    user_agent    TEXT,
    consent_text  TEXT,
    checksum      TEXT     -- SHA256 of doc_url + signer_id + signed_at
  );

  -- ─────────────────────────────────────────────────────────
  -- EMAIL LOG (track all outbound emails)
  -- ─────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS email_log (
    id          TEXT PRIMARY KEY,
    to_email    TEXT NOT NULL,
    to_name     TEXT,
    subject     TEXT NOT NULL,
    template    TEXT,
    status      TEXT DEFAULT 'queued' CHECK(status IN ('queued','sent','failed','bounced')),
    provider    TEXT,
    provider_id TEXT,
    error       TEXT,
    sent_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );

  -- ─────────────────────────────────────────────────────────
  -- UPDATE users table — add estate_manager role
  -- ─────────────────────────────────────────────────────────
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK(role IN ('landlord','tenant','agent','admin','estate_manager'));

  -- ─────────────────────────────────────────────────────────
  -- INDEXES
  -- ─────────────────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_org_members_org    ON org_members(org_id);
  CREATE INDEX IF NOT EXISTS idx_org_members_user   ON org_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_org_listings_org   ON org_listings(org_id);
  CREATE INDEX IF NOT EXISTS idx_maint_tickets_org  ON maintenance_tickets(org_id);
  CREATE INDEX IF NOT EXISTS idx_maint_tickets_status ON maintenance_tickets(status);
  CREATE INDEX IF NOT EXISTS idx_rent_schedule_due  ON rent_schedule(due_date, status);
  CREATE INDEX IF NOT EXISTS idx_email_log_status   ON email_log(status, created_at);
`;

async function migrateV2() {
  console.log('🔄 Running PROPATI migration v2...');
  try {
    await query(v2sql);
    console.log('✅ Migration v2 complete');
  } catch (err) {
    console.error('❌ Migration v2 failed:', err.message);
    // Some statements may fail if already applied — log and continue
    if (err.message.includes('already exists')) {
      console.log('  (Some tables already exist — skipping)');
    } else {
      throw err;
    }
  }
}

if (require.main === module) {
  migrateV2().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { migrateV2 };
