'use strict';
// src/routes/listings.js — PostgreSQL version
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, query: qv, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate, requireRole, optionalAuth } = require('../middleware/auth');
const { uploadImages, uploadToCloudinary } = require('../middleware/upload');
const logger = require('../services/logger');

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const fail = (res, msg, status = 400, details) => res.status(status).json({ success: false, error: msg, details });

// ── GET /api/listings ──────────────────────────────────────
router.get('/', optionalAuth, [
  qv('type').optional().isIn(['rent','sale','short-let','share','commercial']),
  qv('area').optional().isString(),
  qv('min_price').optional().isFloat({ min: 0 }),
  qv('max_price').optional().isFloat({ min: 0 }),
  qv('bedrooms').optional().isInt({ min: 0 }),
  qv('page').optional().isInt({ min: 1 }),
  qv('limit').optional().isInt({ min: 1, max: 50 }),
  qv('sort').optional().isIn(['newest','price_asc','price_desc','most_verified']),
], async (req, res) => {
  try {
    const { type, area, min_price, max_price, bedrooms, verified, page = 1, limit = 20, sort = 'newest', q } = req.query;

    const conditions = ["l.status = 'active'"];
    const params = [];
    let i = 1;

    if (type)      { conditions.push(`l.listing_type = $${i++}`); params.push(type); }
    if (area)      { conditions.push(`l.area ILIKE $${i++}`);     params.push(`%${area}%`); }
    if (min_price) { conditions.push(`l.price >= $${i++}`);       params.push(Number(min_price)); }
    if (max_price) { conditions.push(`l.price <= $${i++}`);       params.push(Number(max_price)); }
    if (bedrooms)  { conditions.push(`l.bedrooms >= $${i++}`);    params.push(Number(bedrooms)); }
    if (verified === 'true') conditions.push(`l.verification_tier IN ('verified','inspected','certified')`);
    if (q) {
      conditions.push(`(l.title ILIKE $${i} OR l.area ILIKE $${i} OR l.address ILIKE $${i})`);
      params.push(`%${q}%`); i++;
    }

    const orderMap = {
      newest:        'l.created_at DESC',
      price_asc:     'l.price ASC',
      price_desc:    'l.price DESC',
      most_verified: `CASE l.verification_tier WHEN 'certified' THEN 1 WHEN 'inspected' THEN 2 WHEN 'verified' THEN 3 ELSE 4 END`,
    };
    const whereSQL = 'WHERE ' + conditions.join(' AND ');
    const offset = (Number(page) - 1) * Number(limit);

    const [countResult, rows] = await Promise.all([
      query(`SELECT COUNT(*) AS n FROM listings l ${whereSQL}`, params),
      query(`
        SELECT l.*, u.full_name AS owner_name,
          (SELECT url FROM listing_images WHERE listing_id = l.id AND is_cover = TRUE LIMIT 1) AS cover_image,
          (SELECT COUNT(*) FROM listing_images WHERE listing_id = l.id)::int AS image_count
        FROM listings l
        JOIN users u ON l.owner_id = u.id
        ${whereSQL}
        ORDER BY l.is_featured DESC NULLS LAST, ${orderMap[sort] || orderMap.newest}
        LIMIT $${i} OFFSET $${i+1}
      `, [...params, Number(limit), offset]),
    ]);

    const total = parseInt(countResult.rows[0].n);
    return ok(res, {
      listings: rows.rows,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (e) {
    logger.error('GET /listings error', { error: e.message });
    return fail(res, 'Failed to load listings', 500);
  }
});

// ── GET /api/listings/owner/mine ───────────────────────────
router.get('/owner/mine', authenticate, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT l.*,
        (SELECT url FROM listing_images WHERE listing_id = l.id AND is_cover = TRUE LIMIT 1) AS cover_image
      FROM listings l
      WHERE l.owner_id = $1 AND l.status != 'deleted'
      ORDER BY l.created_at DESC
    `, [req.user.id]);
    return ok(res, { listings: rows });
  } catch (e) {
    return fail(res, 'Failed to load your listings', 500);
  }
});

// ── GET /api/listings/:id ──────────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT l.*, u.full_name AS owner_name, u.phone AS owner_phone,
        a.full_name AS agent_name, a.phone AS agent_phone, a.agent_tier
      FROM listings l
      JOIN users u ON l.owner_id = u.id
      LEFT JOIN users a ON l.agent_id = a.id
      WHERE l.id = $1 AND l.status != 'deleted'
    `, [req.params.id]);

    if (!rows.length) return fail(res, 'Listing not found', 404);
    const listing = rows[0];

    // Increment views (non-blocking)
    query('UPDATE listings SET views_count = COALESCE(views_count,0) + 1 WHERE id = $1', [listing.id]).catch(() => {});

    const [imagesRes, verifyRes] = await Promise.all([
      query('SELECT * FROM listing_images WHERE listing_id = $1 ORDER BY sort_order', [listing.id]),
      query('SELECT * FROM verifications WHERE listing_id = $1', [listing.id]),
    ]);

    let saved = false;
    if (req.user) {
      const sv = await query('SELECT id FROM saved_listings WHERE user_id = $1 AND listing_id = $2', [req.user.id, listing.id]);
      saved = sv.rows.length > 0;
    }

    return ok(res, { listing: { ...listing, images: imagesRes.rows, verification: verifyRes.rows[0] || null, saved } });
  } catch (e) {
    logger.error('GET /listings/:id error', { error: e.message });
    return fail(res, 'Failed to load listing', 500);
  }
});

// ── POST /api/listings ─────────────────────────────────────
router.post('/', authenticate, requireRole('landlord', 'agent', 'admin', 'estate_manager'), [
  body('title').trim().isLength({ min: 10 }),
  body('listing_type').isIn(['rent','sale','short-let','share','commercial']),
  body('property_type').isIn(['apartment','house','duplex','land','office','shop','warehouse']),
  body('address').trim().notEmpty(),
  body('area').trim().notEmpty(),
  body('price').isFloat({ min: 1 }),
  body('price_period').isIn(['night','month','year','total']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  try {
    const id = 'lst_' + uuidv4().replace(/-/g, '').slice(0, 12);
    const {
      title, description, listing_type, property_type,
      address, area, state = 'Lagos', price, price_period,
      caution_deposit, service_charge, bedrooms, bathrooms,
      size_sqm, furnished, amenities, agent_id,
    } = req.body;

    const { rows } = await query(`
      INSERT INTO listings (
        id, owner_id, agent_id, title, description, listing_type, property_type,
        address, area, state, price, price_period, caution_deposit, service_charge,
        bedrooms, bathrooms, size_sqm, furnished, amenities, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'draft')
      RETURNING *
    `, [
      id, req.user.id, agent_id || null, title, description || null, listing_type, property_type,
      address, area, state, price, price_period,
      caution_deposit || null, service_charge || null,
      bedrooms || null, bathrooms || null, size_sqm || null,
      furnished ? true : false,
      amenities ? JSON.stringify(amenities) : null,
    ]);

    // Auto-create verification record
    await query(
      `INSERT INTO verifications (id, listing_id, owner_id) VALUES ($1,$2,$3) ON CONFLICT (listing_id) DO NOTHING`,
      [uuidv4(), id, req.user.id]
    );

    return ok(res, { listing: rows[0] }, 201);
  } catch (e) {
    logger.error('POST /listings error', { error: e.message });
    return fail(res, 'Failed to create listing', 500);
  }
});

// ── PATCH /api/listings/:id ────────────────────────────────
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!rows.length) return fail(res, 'Listing not found', 404);
    const listing = rows[0];

    if (listing.owner_id !== req.user.id && req.user.role !== 'admin') return fail(res, 'Not authorised', 403);

    const allowed = ['title','description','price','price_period','caution_deposit',
      'bedrooms','bathrooms','size_sqm','furnished','amenities','available_from','status'];

    const updates = [];
    const vals = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = $${i++}`);
        vals.push(key === 'amenities' ? JSON.stringify(req.body[key]) : req.body[key]);
      }
    }
    if (!updates.length) return fail(res, 'No valid fields to update');

    updates.push(`updated_at = NOW()`);
    vals.push(listing.id);

    const updated = await query(
      `UPDATE listings SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    return ok(res, { listing: updated.rows[0] });
  } catch (e) {
    return fail(res, 'Failed to update listing', 500);
  }
});

// ── DELETE /api/listings/:id ───────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!rows.length) return fail(res, 'Listing not found', 404);
    if (rows[0].owner_id !== req.user.id && req.user.role !== 'admin') return fail(res, 'Not authorised', 403);

    await query("UPDATE listings SET status = 'deleted', updated_at = NOW() WHERE id = $1", [req.params.id]);
    return ok(res, { message: 'Listing deleted' });
  } catch (e) {
    return fail(res, 'Failed to delete listing', 500);
  }
});

// ── POST /api/listings/:id/images ─────────────────────────
router.post('/:id/images', authenticate, uploadImages.array('images', 10), async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM listings WHERE id = $1', [req.params.id]);
    if (!rows.length) return fail(res, 'Listing not found', 404);
    if (rows[0].owner_id !== req.user.id && req.user.role !== 'admin') return fail(res, 'Not authorised', 403);
    if (!req.files || req.files.length === 0) return fail(res, 'No images uploaded');

    const countRes = await query('SELECT COUNT(*) AS n FROM listing_images WHERE listing_id = $1', [req.params.id]);
    const existingCount = parseInt(countRes.rows[0].n);

    const inserted = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      // Upload buffer to Cloudinary
      const result = await uploadToCloudinary(file.buffer, { subfolder: 'images', resource_type: 'image' });
      const imgId = uuidv4();
      const isCover = existingCount === 0 && i === 0;

      await query(
        `INSERT INTO listing_images (id, listing_id, url, public_id, is_cover, sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
        [imgId, req.params.id, result.secure_url, result.public_id, isCover, existingCount + i]
      );
      inserted.push({ id: imgId, url: result.secure_url, is_cover: isCover });
    }

    // Activate listing if it was a draft
    if (rows[0].status === 'draft') {
      await query("UPDATE listings SET status = 'active' WHERE id = $1", [req.params.id]);
    }

    return ok(res, { images: inserted }, 201);
  } catch (e) {
    logger.error('Image upload error', { error: e.message });
    return fail(res, 'Image upload failed: ' + e.message, 500);
  }
});

// ── POST /api/listings/:id/save ────────────────────────────
router.post('/:id/save', authenticate, async (req, res) => {
  try {
    const existing = await query(
      'SELECT id FROM saved_listings WHERE user_id = $1 AND listing_id = $2',
      [req.user.id, req.params.id]
    );
    if (existing.rows.length) {
      await query('DELETE FROM saved_listings WHERE user_id = $1 AND listing_id = $2', [req.user.id, req.params.id]);
      return ok(res, { saved: false });
    } else {
      await query('INSERT INTO saved_listings (id, user_id, listing_id) VALUES ($1,$2,$3)', [uuidv4(), req.user.id, req.params.id]);
      return ok(res, { saved: true });
    }
  } catch (e) {
    return fail(res, 'Failed to save listing', 500);
  }
});

// ── POST /api/listings/:id/flag ────────────────────────────
router.post('/:id/flag', authenticate, [
  body('type').isIn(['fraud','duplicate','misleading','wrong_price','other']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  try {
    const listing = await query('SELECT id FROM listings WHERE id = $1', [req.params.id]);
    if (!listing.rows.length) return fail(res, 'Listing not found', 404);

    const already = await query(
      'SELECT id FROM listing_flags WHERE listing_id = $1 AND flagged_by = $2',
      [req.params.id, req.user.id]
    );
    if (already.rows.length) return fail(res, 'You already flagged this listing', 409);

    await query(
      'INSERT INTO listing_flags (id, listing_id, flagged_by, type, description) VALUES ($1,$2,$3,$4,$5)',
      [uuidv4(), req.params.id, req.user.id, req.body.type, req.body.description || null]
    );

    const flagCount = await query(
      "SELECT COUNT(*) AS n FROM listing_flags WHERE listing_id = $1 AND status = 'open'",
      [req.params.id]
    );
    const n = parseInt(flagCount.rows[0].n);
    if (n >= 10) await query("UPDATE listings SET status = 'suspended' WHERE id = $1", [req.params.id]);

    return ok(res, { message: 'Listing flagged. Our team will review it.', total_flags: n });
  } catch (e) {
    return fail(res, 'Failed to flag listing', 500);
  }
});

module.exports = router;
