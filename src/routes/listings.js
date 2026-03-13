// src/routes/listings.js
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, query, validationResult } = require('express-validator');
const { getDb } = require('../db');
const { authenticate, requireRole, optionalAuth } = require('../middleware/auth');
const { uploadImages } = require('../middleware/upload');
const { paginate, ok, fail } = require('../utils');

// ── GET /api/listings ──────────────────────────────────────
// Public search with filters
router.get('/', optionalAuth, [
  query('type').optional().isIn(['rent','sale','short-let','share','commercial']),
  query('area').optional().isString(),
  query('state').optional().isString(),
  query('min_price').optional().isFloat({ min: 0 }),
  query('max_price').optional().isFloat({ min: 0 }),
  query('bedrooms').optional().isInt({ min: 0 }),
  query('verified').optional().isBoolean(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  query('sort').optional().isIn(['newest','price_asc','price_desc','most_verified']),
], (req, res) => {
  const db = getDb();
  const {
    type, area, state, min_price, max_price, bedrooms,
    verified, page = 1, limit = 20, sort = 'newest', q
  } = req.query;

  const where = ["l.status = 'active'"];
  const params = [];

  if (type)      { where.push('l.listing_type = ?'); params.push(type); }
  if (area)      { where.push('l.area LIKE ?'); params.push(`%${area}%`); }
  if (state)     { where.push('l.state = ?'); params.push(state); }
  if (min_price) { where.push('l.price >= ?'); params.push(Number(min_price)); }
  if (max_price) { where.push('l.price <= ?'); params.push(Number(max_price)); }
  if (bedrooms)  { where.push('l.bedrooms >= ?'); params.push(Number(bedrooms)); }
  if (verified === 'true') { where.push("l.verification_tier IN ('verified','inspected','certified')"); }
  if (q) {
    where.push('(l.title LIKE ? OR l.description LIKE ? OR l.area LIKE ? OR l.address LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const orderMap = {
    newest: 'l.created_at DESC',
    price_asc: 'l.price ASC',
    price_desc: 'l.price DESC',
    most_verified: "CASE l.verification_tier WHEN 'certified' THEN 1 WHEN 'inspected' THEN 2 WHEN 'verified' THEN 3 WHEN 'basic' THEN 4 ELSE 5 END",
  };

  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as n FROM listings l ${whereSQL}`).get(...params).n;

  const offset = (Number(page) - 1) * Number(limit);
  const rows = db.prepare(`
    SELECT l.*, 
      u.full_name as owner_name,
      (SELECT url FROM listing_images WHERE listing_id = l.id AND is_cover = 1 LIMIT 1) as cover_image,
      (SELECT COUNT(*) FROM listing_images WHERE listing_id = l.id) as image_count
    FROM listings l
    JOIN users u ON l.owner_id = u.id
    ${whereSQL}
    ORDER BY l.is_featured DESC, ${orderMap[sort] || orderMap.newest}
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), offset);

  return ok(res, { listings: rows, pagination: paginate(total, Number(page), Number(limit)) });
});

// ── GET /api/listings/:id ──────────────────────────────────
router.get('/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const listing = db.prepare(`
    SELECT l.*, u.full_name as owner_name, u.phone as owner_phone,
      a.full_name as agent_name, a.phone as agent_phone, a.agent_tier
    FROM listings l
    JOIN users u ON l.owner_id = u.id
    LEFT JOIN users a ON l.agent_id = a.id
    WHERE l.id = ? AND l.status != 'deleted'
  `).get(req.params.id);

  if (!listing) return fail(res, 'Listing not found', 404);

  // Increment view count
  db.prepare('UPDATE listings SET views_count = views_count + 1 WHERE id = ?').run(listing.id);

  const images = db.prepare('SELECT * FROM listing_images WHERE listing_id = ? ORDER BY sort_order').all(listing.id);
  const verification = db.prepare('SELECT * FROM verifications WHERE listing_id = ?').get(listing.id);

  // If authenticated, check if user saved this listing
  let saved = false;
  if (req.user) {
    saved = !!db.prepare('SELECT id FROM saved_listings WHERE user_id = ? AND listing_id = ?').get(req.user.id, listing.id);
  }

  return ok(res, { listing: { ...listing, images, verification, saved } });
});

// ── POST /api/listings ─────────────────────────────────────
router.post('/', authenticate, requireRole('landlord', 'agent', 'admin'), [
  body('title').trim().isLength({ min: 10 }),
  body('listing_type').isIn(['rent','sale','short-let','share','commercial']),
  body('property_type').isIn(['apartment','house','duplex','land','office','shop','warehouse']),
  body('address').trim().notEmpty(),
  body('area').trim().notEmpty(),
  body('price').isFloat({ min: 1 }),
  body('price_period').isIn(['night','month','year','total']),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  const db = getDb();
  const id = 'lst_' + uuidv4().replace(/-/g, '').slice(0, 12);
  const {
    title, description, listing_type, property_type,
    address, area, state = 'Lagos', price, price_period,
    caution_deposit, service_charge, bedrooms, bathrooms, toilets,
    size_sqm, floor_level, furnished, parking_spaces,
    amenities, available_from, minimum_stay, agent_id
  } = req.body;

  db.prepare(`
    INSERT INTO listings (
      id, owner_id, agent_id, title, description, listing_type, property_type,
      address, area, state, price, price_period, caution_deposit, service_charge,
      bedrooms, bathrooms, toilets, size_sqm, floor_level, furnished, parking_spaces,
      amenities, available_from, minimum_stay, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')
  `).run(
    id, req.user.id, agent_id || null, title, description || null, listing_type, property_type,
    address, area, state, price, price_period, caution_deposit || null, service_charge || null,
    bedrooms || null, bathrooms || null, toilets || null, size_sqm || null,
    floor_level || null, furnished ? 1 : 0, parking_spaces || 0,
    amenities ? JSON.stringify(amenities) : null, available_from || null, minimum_stay || null
  );

  // Auto-create verification record
  db.prepare(`INSERT INTO verifications (id, listing_id, owner_id) VALUES (?, ?, ?)`)
    .run(uuidv4(), id, req.user.id);

  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
  return ok(res, { listing }, 201);
});

// ── PATCH /api/listings/:id ────────────────────────────────
router.patch('/:id', authenticate, (req, res) => {
  const db = getDb();
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing) return fail(res, 'Listing not found', 404);

  const isOwner = listing.owner_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return fail(res, 'Not authorised to edit this listing', 403);

  const allowed = ['title','description','price','price_period','caution_deposit','service_charge',
    'bedrooms','bathrooms','size_sqm','furnished','amenities','available_from','status'];

  const updates = [];
  const vals = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      vals.push(key === 'amenities' ? JSON.stringify(req.body[key]) : req.body[key]);
    }
  }
  if (!updates.length) return fail(res, 'No valid fields to update', 400);

  updates.push('updated_at = datetime("now")');
  db.prepare(`UPDATE listings SET ${updates.join(', ')} WHERE id = ?`).run(...vals, listing.id);

  return ok(res, { listing: db.prepare('SELECT * FROM listings WHERE id = ?').get(listing.id) });
});

// ── DELETE /api/listings/:id ───────────────────────────────
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing) return fail(res, 'Listing not found', 404);
  if (listing.owner_id !== req.user.id && req.user.role !== 'admin') return fail(res, 'Not authorised', 403);

  db.prepare("UPDATE listings SET status = 'deleted', updated_at = datetime('now') WHERE id = ?").run(listing.id);
  return ok(res, { message: 'Listing deleted' });
});

// ── POST /api/listings/:id/images ─────────────────────────
router.post('/:id/images', authenticate, uploadImages.array('images', 10), (req, res) => {
  const db = getDb();
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!listing) return fail(res, 'Listing not found', 404);
  if (listing.owner_id !== req.user.id && req.user.role !== 'admin') return fail(res, 'Not authorised', 403);
  if (!req.files || req.files.length === 0) return fail(res, 'No images uploaded', 400);

  const existingCount = db.prepare('SELECT COUNT(*) as n FROM listing_images WHERE listing_id = ?').get(listing.id).n;
  const insertImg = db.prepare('INSERT INTO listing_images (id, listing_id, url, is_cover, sort_order) VALUES (?, ?, ?, ?, ?)');

  const inserted = [];
  req.files.forEach((file, i) => {
    const id = uuidv4();
    const url = `/uploads/images/${file.filename}`;
    const isCover = existingCount === 0 && i === 0 ? 1 : 0;
    insertImg.run(id, listing.id, url, isCover, existingCount + i);
    inserted.push({ id, url, is_cover: isCover });
  });

  return ok(res, { images: inserted }, 201);
});

// ── POST /api/listings/:id/save ────────────────────────────
router.post('/:id/save', authenticate, (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM saved_listings WHERE user_id = ? AND listing_id = ?').get(req.user.id, req.params.id);

  if (existing) {
    db.prepare('DELETE FROM saved_listings WHERE user_id = ? AND listing_id = ?').run(req.user.id, req.params.id);
    return ok(res, { saved: false });
  } else {
    db.prepare('INSERT INTO saved_listings (id, user_id, listing_id) VALUES (?, ?, ?)').run(uuidv4(), req.user.id, req.params.id);
    return ok(res, { saved: true });
  }
});

// ── GET /api/listings/mine ─────────────────────────────────
router.get('/owner/mine', authenticate, (req, res) => {
  const db = getDb();
  const listings = db.prepare(`
    SELECT l.*, (SELECT url FROM listing_images WHERE listing_id = l.id AND is_cover = 1 LIMIT 1) as cover_image
    FROM listings l
    WHERE l.owner_id = ? AND l.status != 'deleted'
    ORDER BY l.created_at DESC
  `).all(req.user.id);
  return ok(res, { listings });
});

// ── POST /api/listings/:id/flag ────────────────────────────
router.post('/:id/flag', authenticate, [
  body('type').isIn(['fraud','duplicate','misleading','wrong_price','harassment','other']),
  body('description').optional().isString(),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, 'Validation failed', 422, errors.array());

  const db = getDb();
  const listing = db.prepare('SELECT id FROM listings WHERE id = ?').get(req.params.id);
  if (!listing) return fail(res, 'Listing not found', 404);

  const alreadyFlagged = db.prepare('SELECT id FROM listing_flags WHERE listing_id = ? AND flagged_by = ?').get(req.params.id, req.user.id);
  if (alreadyFlagged) return fail(res, 'You have already flagged this listing', 409);

  db.prepare('INSERT INTO listing_flags (id, listing_id, flagged_by, type, description) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), req.params.id, req.user.id, req.body.type, req.body.description || null);

  // Auto-suspend if 10+ flags
  const flagCount = db.prepare("SELECT COUNT(*) as n FROM listing_flags WHERE listing_id = ? AND status = 'open'").get(req.params.id).n;
  if (flagCount >= 10) {
    db.prepare("UPDATE listings SET status = 'suspended' WHERE id = ?").run(req.params.id);
  }

  return ok(res, { message: 'Listing flagged. Our team will review it.', total_flags: flagCount + 1 });
});

module.exports = router;
