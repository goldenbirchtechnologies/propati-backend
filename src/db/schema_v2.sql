-- ═══════════════════════════════════════════════════════════
-- PROPATI SCHEMA v2 — New tables appended to schema.sql
-- Run: psql $DATABASE_URL -f schema_v2.sql
-- ═══════════════════════════════════════════════════════════

-- ─────────────────────────────────────
-- MESSAGES
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  landlord_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id      TEXT REFERENCES listings(id) ON DELETE SET NULL,
  subject         TEXT,
  last_message    TEXT,
  last_message_at TEXT DEFAULT (NOW()::text),
  tenant_unread   INTEGER DEFAULT 0,
  landlord_unread INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','archived','blocked')),
  created_at      TEXT DEFAULT (NOW()::text),
  UNIQUE(tenant_id, landlord_id, listing_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  attachment_url  TEXT,
  attachment_type TEXT CHECK (attachment_type IN ('image','document','voice',NULL)),
  is_read         INTEGER DEFAULT 0,
  read_at         TEXT,
  created_at      TEXT DEFAULT (NOW()::text)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv     ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_t   ON conversations(tenant_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_l   ON conversations(landlord_id, last_message_at DESC);

-- ─────────────────────────────────────
-- ORGANISATIONS (Estate Manager B2B)
-- ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS organisations (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  owner_id              TEXT NOT NULL REFERENCES users(id),
  plan_tier             TEXT DEFAULT 'starter' CHECK (plan_tier IN ('starter','growth','enterprise')),
  max_units             INTEGER DEFAULT 20,
  max_seats             INTEGER DEFAULT 1,
  billing_email         TEXT,
  address               TEXT,
  cac_number            TEXT,
  paystack_customer_id  TEXT,
  is_active             INTEGER DEFAULT 1,
  created_at            TEXT DEFAULT (NOW()::text),
  updated_at            TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS org_members (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id),
  role        TEXT NOT NULL CHECK (role IN ('manager','accountant','maintenance','owner_view')),
  invited_by  TEXT REFERENCES users(id),
  invite_email TEXT,
  status      TEXT DEFAULT 'active' CHECK (status IN ('pending','active','removed')),
  joined_at   TEXT DEFAULT (NOW()::text),
  UNIQUE(org_id, user_id)
);

-- Link listings to an org
ALTER TABLE listings ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organisations(id);

CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id            TEXT PRIMARY KEY,
  org_id        TEXT REFERENCES organisations(id) ON DELETE CASCADE,
  property_id   TEXT REFERENCES listings(id) ON DELETE SET NULL,
  tenant_id     TEXT REFERENCES users(id),
  title         TEXT NOT NULL,
  description   TEXT,
  category      TEXT DEFAULT 'other' CHECK (category IN ('plumbing','electrical','structural','security','cleaning','other')),
  priority      TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status        TEXT DEFAULT 'open' CHECK (status IN ('open','assigned','in_progress','resolved','closed')),
  assigned_to   TEXT REFERENCES users(id),
  photo_urls    TEXT,  -- JSON array of Cloudinary URLs
  resolved_at   TEXT,
  created_at    TEXT DEFAULT (NOW()::text),
  updated_at    TEXT DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS org_subscriptions (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  paystack_sub_id       TEXT UNIQUE,
  paystack_customer_id  TEXT,
  plan                  TEXT NOT NULL,
  status                TEXT DEFAULT 'active' CHECK (status IN ('active','paused','cancelled','past_due')),
  amount                BIGINT,
  current_period_start  TEXT,
  current_period_end    TEXT,
  next_billing_date     TEXT,
  created_at            TEXT DEFAULT (NOW()::text),
  updated_at            TEXT DEFAULT (NOW()::text)
);

CREATE INDEX IF NOT EXISTS idx_org_members_org  ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_org      ON maintenance_tickets(org_id, status);
CREATE INDEX IF NOT EXISTS idx_listings_org     ON listings(org_id);

-- ─────────────────────────────────────
-- AGREEMENT PDF URLS (add to agreements)
-- ─────────────────────────────────────
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS pdf_url TEXT;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS pdf_generated_at TEXT;

-- ─────────────────────────────────────
-- USERS — add estate_manager role + org
-- ─────────────────────────────────────
-- Postgres requires a new constraint — drop old CHECK then re-add
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('landlord','tenant','agent','admin','estate_manager'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organisations(id);

-- ─────────────────────────────────────
-- RENT LEDGER VIEW (convenience)
-- ─────────────────────────────────────
CREATE OR REPLACE VIEW rent_ledger_view AS
  SELECT
    rs.id,
    rs.agreement_id,
    rs.due_date,
    rs.amount        AS amount_due,
    COALESCE((SELECT t.amount FROM transactions t WHERE t.id = rs.transaction_id), 0) AS amount_paid,
    rs.status,
    l.title          AS property_title,
    l.id             AS property_id,
    l.org_id,
    u.full_name      AS tenant_name,
    u.email          AS tenant_email,
    a.landlord_id
  FROM rent_schedule rs
  JOIN agreements a ON rs.agreement_id = a.id
  JOIN listings l   ON a.listing_id = l.id
  JOIN users u      ON a.tenant_id = u.id;
