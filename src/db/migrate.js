// src/db/migrate.js — Run all migrations in order
require('dotenv').config();
const { query, checkConnection } = require('./index');
const logger = require('../services/logger');

const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      -- ─────────────────────────────────────
      -- USERS
      -- ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS users (
        id              TEXT PRIMARY KEY,
        email           TEXT UNIQUE NOT NULL,
        phone           TEXT UNIQUE,
        password        TEXT NOT NULL,
        role            TEXT NOT NULL CHECK(role IN ('landlord','tenant','agent','admin')),
        full_name       TEXT NOT NULL,
        avatar_url      TEXT,

        -- KYC — stored encrypted
        nin_encrypted   TEXT,            -- encrypted NIN
        nin_hash        TEXT,            -- HMAC hash for lookups
        nin_verified    BOOLEAN DEFAULT FALSE,
        bvn_encrypted   TEXT,
        id_type         TEXT CHECK(id_type IN ('nin','passport','drivers_licence')),
        id_number_enc   TEXT,            -- encrypted ID number
        id_verified     BOOLEAN DEFAULT FALSE,
        id_doc_url      TEXT,

        -- Status
        is_active       BOOLEAN DEFAULT TRUE,
        is_banned       BOOLEAN DEFAULT FALSE,
        ban_reason      TEXT,

        -- Agent fields
        agent_tier      TEXT CHECK(agent_tier IN ('standard','senior','probation')) DEFAULT 'standard',
        agent_approved  BOOLEAN DEFAULT FALSE,
        agent_bio       TEXT,
        agent_areas     JSONB,

        -- Timestamps
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        last_login      TIMESTAMPTZ
      );

      -- ─────────────────────────────────────
      -- REFRESH TOKENS
      -- ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- ─────────────────────────────────────
      -- LISTINGS
      -- ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS listings (
        id              TEXT PRIMARY KEY,
        owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id        TEXT REFERENCES users(id),
        title           TEXT NOT NULL,
        description     TEXT,
        listing_type    TEXT NOT NULL CHECK(listing_type IN ('rent','sale','short-let','share','commercial')),
        property_type   TEXT NOT NULL CHECK(property_type IN ('apartment','house','duplex','land','office','shop','warehouse')),
        address         TEXT NOT NULL,
        area            TEXT NOT NULL,
        state           TEXT NOT NULL DEFAULT 'Lagos',
        latitude        NUMERIC(10,7),
        longitude       NUMERIC(10,7),
        price           NUMERIC(15,2) NOT NULL,
        price_period    TEXT CHECK(price_period IN ('night','month','year','total')),
        caution_deposit NUMERIC(15,2),
        service_charge  NUMERIC(15,2),
        bedrooms        INTEGER,
        bathrooms       INTEGER,
        toilets         INTEGER,
        size_sqm        NUMERIC(10,2),
        floor_level     INTEGER,
        total_floors    INTEGER,
        parking_spaces  INTEGER DEFAULT 0,
        furnished       BOOLEAN DEFAULT FALSE,
        amenities       JSONB,
        status          TEXT DEFAULT 'draft' CHECK(status IN ('draft','active','rented','sold','suspended','deleted')),
        is_featured     BOOLEAN DEFAULT FALSE,
        views_count     INTEGER DEFAULT 0,
        saves_count     INTEGER DEFAULT 0,
        available_from  DATE,
        minimum_stay    INTEGER,
        verification_tier TEXT DEFAULT 'none' CHECK(verification_tier IN ('none','basic','verified','inspected','certified')),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS listing_images (
        id          TEXT PRIMARY KEY,
        listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        url         TEXT NOT NULL,
        public_id   TEXT,            -- Cloudinary public_id for deletion
        is_cover    BOOLEAN DEFAULT FALSE,
        sort_order  INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS saved_listings (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, listing_id)
      );

      -- ─────────────────────────────────────
      -- VERIFICATION (5-layer)
      -- ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS verifications (
        id              TEXT PRIMARY KEY,
        listing_id      TEXT NOT NULL UNIQUE REFERENCES listings(id) ON DELETE CASCADE,
        owner_id        TEXT NOT NULL REFERENCES users(id),
        l1_status       TEXT DEFAULT 'pending' CHECK(l1_status IN ('pending','submitted','approved','rejected')),
        l1_doc_coo      TEXT,
        l1_doc_title    TEXT,
        l1_doc_survey   TEXT,
        l1_doc_deed     TEXT,
        l1_doc_govcon   TEXT,
        l1_submitted_at TIMESTAMPTZ,
        l1_reviewed_at  TIMESTAMPTZ,
        l1_reviewer_id  TEXT REFERENCES users(id),
        l1_notes        TEXT,
        l2_status       TEXT DEFAULT 'pending' CHECK(l2_status IN ('pending','submitted','approved','rejected')),
        l2_id_type      TEXT,
        l2_id_number    TEXT,        -- encrypted
        l2_id_doc_url   TEXT,
        l2_nin_match    BOOLEAN DEFAULT FALSE,
        l2_submitted_at TIMESTAMPTZ,
        l2_reviewed_at  TIMESTAMPTZ,
        l2_notes        TEXT,
        l3_status       TEXT DEFAULT 'pending' CHECK(l3_status IN ('pending','qr_issued','submitted','approved','rejected')),
        l3_qr_code      TEXT,
        l3_qr_expires   TIMESTAMPTZ,
        l3_video_url    TEXT,
        l3_submitted_at TIMESTAMPTZ,
        l3_reviewed_at  TIMESTAMPTZ,
        l3_reviewer_id  TEXT REFERENCES users(id),
        l3_notes        TEXT,
        l4_status       TEXT DEFAULT 'pending' CHECK(l4_status IN ('pending','scheduled','completed','failed')),
        l4_agent_id     TEXT REFERENCES users(id),
        l4_scheduled_at TIMESTAMPTZ,
        l4_completed_at TIMESTAMPTZ,
        l4_report_url   TEXT,
        l4_notes        TEXT,
        l5_status       TEXT DEFAULT 'pending' CHECK(l5_status IN ('pending','approved','rejected')),
        l5_certified_at TIMESTAMPTZ,
        l5_admin_id     TEXT REFERENCES users(id),
        l5_notes        TEXT,
        current_layer   INTEGER DEFAULT 1,
        overall_status  TEXT DEFAULT 'in_progress' CHECK(overall_status IN ('in_progress','certified','rejected')),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );

      -- ─────────────────────────────────────
      -- TRANSACTIONS & ESCROW
      -- ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS transactions (
        id                TEXT PRIMARY KEY,
        reference         TEXT UNIQUE NOT NULL,
        listing_id        TEXT REFERENCES listings(id),
        payer_id          TEXT NOT NULL REFERENCES users(id),
        payee_id          TEXT NOT NULL REFERENCES users(id),
        agent_id          TEXT REFERENCES users(id),
        type              TEXT NOT NULL CHECK(type IN ('rent','sale','short_let','caution','service_charge','commission','refund')),
        status            TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','in_escrow','released','refunded','failed','disputed')),
        amount            NUMERIC(15,2) NOT NULL,
        platform_fee      NUMERIC(15,2) NOT NULL,
        agent_commission  NUMERIC(15,2) DEFAULT 0,
        payee_amount      NUMERIC(15,2) NOT NULL,
        paystack_ref      TEXT,
        paystack_txn_id   TEXT,
        escrow_release_date TIMESTAMPTZ,
        escrow_released_at  TIMESTAMPTZ,
        escrow_released_by  TEXT REFERENCES users(id),
        description       TEXT,
        metadata          JSONB,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      );

      -- ─────────────────────────────────────
      -- AGREEMENTS
      -- ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS agreements (
        id              TEXT PRIMARY KEY,
        listing_id      TEXT NOT NULL REFERENCES listings(id),
        transaction_id  TEXT REFERENCES transactions(id),
        landlord_id     TEXT NOT NULL REFERENCES users(id),
        tenant_id       TEXT NOT NULL REFERENCES users(id),
        agent_id        TEXT REFERENCES users(id),
        type            TEXT NOT NULL CHECK(type IN ('rental','sale','short_let','share')),
        status          TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','landlord_signed','tenant_signed','fully_signed','terminated','expired')),
        start_date      DATE NOT NULL,
        end_date        DATE,
        rent_amount     NUMERIC(15,2),
        rent_period     TEXT CHECK(rent_period IN ('monthly','yearly')),
        caution_deposit NUMERIC(15,2) DEFAULT 0,
        service_charge  NUMERIC(15,2) DEFAULT 0,
        notice_period_days INTEGER DEFAULT 30,
        landlord_signed_at TIMESTAMPTZ,
        landlord_ip        TEXT,
        tenant_signed_at   TIMESTAMPTZ,
        tenant_ip          TEXT,
        doc_url            TEXT,
        template_vars      JSONB,
        special_clauses    TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rent_schedule (
        id              TEXT PRIMARY KEY,
        agreement_id    TEXT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
        due_date        DATE NOT NULL,
        amount          NUMERIC(15,2) NOT NULL,
        status          TEXT DEFAULT 'upcoming' CHECK(status IN ('upcoming','paid','overdue','waived')),
        transaction_id  TEXT REFERENCES transactions(id),
        reminder_sent   BOOLEAN DEFAULT FALSE,
        paid_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

      -- ─────────────────────────────────────
      -- DISPUTES
      -- ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS disputes (
        id              TEXT PRIMARY KEY,
        agreement_id    TEXT REFERENCES agreements(id),
        transaction_id  TEXT REFERENCES transactions(id),
        raised_by       TEXT NOT NULL REFERENCES users(id),
        against         TEXT NOT NULL REFERENCES users(id),
        assigned_admin  TEXT REFERENCES users(id),
        type            TEXT NOT NULL CHECK(type IN ('caution_refund','payment_not_received','lease_breach','harassment','fraud','other')),
        status          TEXT DEFAULT 'open' CHECK(status IN ('open','investigating','mediation','resolved_tenant','resolved_landlord','closed')),
        severity        INTEGER DEFAULT 1 CHECK(severity IN (1,2,3)),
        description     TEXT NOT NULL,
        evidence_urls   JSONB,
        resolution_note TEXT,
        amount_disputed NUMERIC(15,2),
        resolved_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );

      -- ─────────────────────────────────────
      -- FLAGS
      -- ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS listing_flags (
        id          TEXT PRIMARY KEY,
        listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        flagged_by  TEXT NOT NULL REFERENCES users(id),
        type        TEXT NOT NULL CHECK(type IN ('fraud','duplicate','misleading','wrong_price','harassment','other')),
        description TEXT,
        status      TEXT DEFAULT 'open' CHECK(status IN ('open','investigating','resolved','dismissed')),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- ─────────────────────────────────────
      -- NOTIFICATIONS
      -- ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS notifications (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        data        JSONB,
        read        BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- ─────────────────────────────────────
      -- SCREENING CALLS
      -- ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS screening_calls (
        id              TEXT PRIMARY KEY,
        listing_id      TEXT NOT NULL REFERENCES listings(id),
        landlord_id     TEXT NOT NULL REFERENCES users(id),
        tenant_id       TEXT NOT NULL REFERENCES users(id),
        agent_id        TEXT REFERENCES users(id),
        status          TEXT DEFAULT 'requested' CHECK(status IN ('requested','scheduled','in_progress','completed','cancelled','no_show')),
        scheduled_at    TIMESTAMPTZ,
        duration_mins   INTEGER,
        notes           TEXT,
        outcome         TEXT CHECK(outcome IN ('approved','rejected','pending_decision')),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );

      -- ─────────────────────────────────────
      -- INDEXES
      -- ─────────────────────────────────────
      CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_nin_hash     ON users(nin_hash);
      CREATE INDEX IF NOT EXISTS idx_listings_owner     ON listings(owner_id);
      CREATE INDEX IF NOT EXISTS idx_listings_status    ON listings(status);
      CREATE INDEX IF NOT EXISTS idx_listings_type      ON listings(listing_type);
      CREATE INDEX IF NOT EXISTS idx_listings_area      ON listings(area);
      CREATE INDEX IF NOT EXISTS idx_listings_price     ON listings(price);
      CREATE INDEX IF NOT EXISTS idx_listings_verified  ON listings(verification_tier);
      CREATE INDEX IF NOT EXISTS idx_transactions_payer ON transactions(payer_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_payee ON transactions(payee_id);
      CREATE INDEX IF NOT EXISTS idx_agreements_tenant  ON agreements(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_agreements_landlord ON agreements(landlord_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
      CREATE INDEX IF NOT EXISTS idx_flags_listing      ON listing_flags(listing_id);

      -- Full-text search on listings
      CREATE INDEX IF NOT EXISTS idx_listings_fts ON listings
        USING gin(to_tsvector('english', title || ' ' || COALESCE(description,'') || ' ' || area || ' ' || address));
    `
  }
];

async function migrate() {
  const ok = await checkConnection();
  if (!ok) throw new Error('Cannot connect to PostgreSQL. Check DATABASE_URL in .env');

  // Create migrations tracking table
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version   INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const applied = await query('SELECT version FROM _migrations ORDER BY version');
  const appliedVersions = new Set(applied.rows.map(r => r.version));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      logger.debug(`Migration ${migration.version} (${migration.name}) already applied`);
      continue;
    }
    logger.info(`Applying migration ${migration.version}: ${migration.name}`);
    await query(migration.sql);
    await query('INSERT INTO _migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
    logger.info(`✅ Migration ${migration.version} applied`);
  }

  logger.info('✅ All migrations complete');

  // Run additive patch migrations (safe to re-run)
  try { const { migrateV3 } = require('./migrate_v3'); await migrateV3(); }
  catch (e) { logger.warn('migrate_v3 skipped', { error: e.message }); }

  try { const { migrateV4 } = require('./migrate_v4'); await migrateV4(); }
  catch (e) { logger.warn('migrate_v4 skipped', { error: e.message }); }
}

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(err => {
    logger.error('Migration failed', { error: err.message });
    process.exit(1);
  });
}

module.exports = { migrate };
