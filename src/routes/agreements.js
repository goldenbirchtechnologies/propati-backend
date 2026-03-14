// src/routes/agreements.js — Digital Agreements + E-Signing
'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { notifyAgreementReady, createNotification } = require('../services/notifications');
const crypto = require('crypto');
const logger = require('../services/logger');

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const fail = (res, msg, status = 400)  => res.status(status).json({ success: false, error: msg });

// ── POST /api/agreements ─────────────────────────────────────
// Landlord creates a lease agreement and sends it to tenant
router.post('/', authenticate, requireRole('landlord', 'agent', 'admin', 'estate_manager'), [
  body('listing_id').notEmpty(),
  body('tenant_id').notEmpty(),
  body('type').isIn(['rental','sale','short_let','share']),
  body('start_date').isISO8601(),
  body('rent_amount').isFloat({ min: 1 }),
  body('rent_period').isIn(['monthly','yearly']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const {
      listing_id, tenant_id, type, start_date, end_date,
      rent_amount, rent_period, caution_deposit, service_charge,
      notice_period_days, special_clauses, agent_id,
    } = req.body;

    const listing = await query('SELECT * FROM listings WHERE id = $1', [listing_id]);
    if (!listing.rows.length) return fail(res, 'Listing not found', 404);

    const tenant = await query("SELECT * FROM users WHERE id = $1 AND role = 'tenant'", [tenant_id]);
    if (!tenant.rows.length) return fail(res, 'Tenant not found', 404);

    // Check no active agreement already exists
    const existing = await query(`
      SELECT id FROM agreements
      WHERE listing_id = $1 AND tenant_id = $2
        AND status NOT IN ('terminated','expired')
      LIMIT 1
    `, [listing_id, tenant_id]);
    if (existing.rows.length) return fail(res, 'An active agreement already exists for this tenant');

    const id = 'agr_' + uuidv4().replace(/-/g, '').slice(0, 12);
    const landlordId = req.user.role === 'landlord' ? req.user.id : listing.rows[0].owner_id;

    // Build template variables for PDF generation
    const templateVars = {
      landlord_name: null, // filled in below
      tenant_name: tenant.rows[0].full_name,
      property_address: listing.rows[0].address,
      listing_title: listing.rows[0].title,
      rent_amount: parseFloat(rent_amount),
      rent_period,
      caution_deposit: parseFloat(caution_deposit) || 0,
      start_date,
      end_date: end_date || null,
      notice_period_days: notice_period_days || 30,
    };

    // Fetch landlord name
    const landlordResult = await query('SELECT full_name, email, phone FROM users WHERE id = $1', [landlordId]);
    if (landlordResult.rows.length) {
      templateVars.landlord_name = landlordResult.rows[0].full_name;
    }

    const agrResult = await query(`
      INSERT INTO agreements
        (id, listing_id, landlord_id, tenant_id, agent_id, type, status,
         start_date, end_date, rent_amount, rent_period, caution_deposit,
         service_charge, notice_period_days, special_clauses, template_vars)
      VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [id, listing_id, landlordId, tenant_id, agent_id || null, type,
        start_date, end_date || null, parseFloat(rent_amount),
        rent_period, parseFloat(caution_deposit) || 0,
        parseFloat(service_charge) || 0,
        notice_period_days || 30, special_clauses || null,
        JSON.stringify(templateVars)]);

    // Generate rent schedule
    if (type === 'rental' && end_date) {
      const scheduleEntries = generateRentSchedule(
        id, start_date, end_date, parseFloat(rent_amount), rent_period
      );
      for (const entry of scheduleEntries) {
        await query(`
          INSERT INTO rent_schedule (id, agreement_id, due_date, amount)
          VALUES ($1, $2, $3, $4)
        `, [entry.id, entry.agreement_id, entry.due_date, entry.amount]);
      }
    }

    // Notify tenant and landlord
    await notifyAgreementReady(
      tenant_id, landlordId, listing.rows[0].title, id
    );

    // Update agreement status to 'sent'
    await query("UPDATE agreements SET status = 'sent' WHERE id = $1", [id]);

    ok(res, { agreement: { ...agrResult.rows[0], status: 'sent' } }, 201);
  } catch (e) {
    logger.error('Create agreement error', { error: e.message });
    fail(res, 'Failed to create agreement', 500);
  }
});

// Helper: generate monthly or yearly rent schedule entries
function generateRentSchedule(agreementId, startDate, endDate, amount, period) {
  const entries = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  let current = new Date(start);

  const monthlyAmount = period === 'yearly' ? amount / 12 : amount;
  const increment = period === 'yearly' ? 12 : 1;

  while (current <= end) {
    entries.push({
      id: uuidv4(),
      agreement_id: agreementId,
      due_date: current.toISOString().slice(0, 10),
      amount: period === 'yearly' ? amount : monthlyAmount,
    });

    const next = new Date(current);
    next.setMonth(next.getMonth() + increment);
    current = next;

    // Max 36 entries to avoid infinite loops
    if (entries.length >= 36) break;
  }
  return entries;
}

// ── GET /api/agreements ───────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await query(`
      SELECT a.*,
        l.title AS listing_title, l.area, l.address, l.listing_type,
        tenant.full_name AS tenant_name, tenant.email AS tenant_email, tenant.phone AS tenant_phone,
        landlord.full_name AS landlord_name
      FROM agreements a
      JOIN listings l ON a.listing_id = l.id
      JOIN users tenant ON a.tenant_id = tenant.id
      JOIN users landlord ON a.landlord_id = landlord.id
      WHERE a.tenant_id = $1 OR a.landlord_id = $1
      ORDER BY a.created_at DESC
    `, [userId]);
    ok(res, { agreements: result.rows });
  } catch (e) {
    fail(res, 'Failed to load agreements', 500);
  }
});

// ── GET /api/agreements/:id ──────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await query(`
      SELECT a.*,
        l.title AS listing_title, l.area, l.address, l.property_type, l.bedrooms, l.bathrooms,
        tenant.full_name AS tenant_name, tenant.email AS tenant_email, tenant.phone AS tenant_phone,
        landlord.full_name AS landlord_name, landlord.email AS landlord_email,
        landlord.phone AS landlord_phone
      FROM agreements a
      JOIN listings l ON a.listing_id = l.id
      JOIN users tenant ON a.tenant_id = tenant.id
      JOIN users landlord ON a.landlord_id = landlord.id
      WHERE a.id = $1 AND (a.tenant_id = $2 OR a.landlord_id = $2 OR $3 = 'admin')
    `, [req.params.id, req.user.id, req.user.role]);

    if (!result.rows.length) return fail(res, 'Agreement not found', 404);

    // Load rent schedule
    const schedule = await query(
      'SELECT * FROM rent_schedule WHERE agreement_id = $1 ORDER BY due_date ASC',
      [req.params.id]
    );

    // Load signatures
    const signatures = await query(`
      SELECT s.*, u.full_name, u.email
      FROM agreement_signatures s
      JOIN users u ON s.signer_id = u.id
      WHERE s.agreement_id = $1
    `, [req.params.id]);

    ok(res, {
      agreement: result.rows[0],
      rent_schedule: schedule.rows,
      signatures: signatures.rows,
    });
  } catch (e) {
    fail(res, 'Failed to load agreement', 500);
  }
});

// ── POST /api/agreements/:id/sign ────────────────────────────
// E-sign an agreement — landlord or tenant
// Records: signer_id, timestamp, IP, user agent, consent text, doc checksum
router.post('/:id/sign', authenticate, [
  body('consent').isBoolean({ strict: false }).withMessage('consent field required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { consent } = req.body;

    if (!consent || consent === 'false') return fail(res, 'You must consent to sign the agreement');

    const agrResult = await query('SELECT * FROM agreements WHERE id = $1', [id]);
    if (!agrResult.rows.length) return fail(res, 'Agreement not found', 404);
    const agr = agrResult.rows[0];

    // Verify signer is party to the agreement
    const isLandlord = agr.landlord_id === userId;
    const isTenant   = agr.tenant_id === userId;
    if (!isLandlord && !isTenant) return fail(res, 'You are not a party to this agreement', 403);

    // Check not already signed by this party
    if (isLandlord && agr.landlord_signed_at) return fail(res, 'You have already signed this agreement');
    if (isTenant   && agr.tenant_signed_at)   return fail(res, 'You have already signed this agreement');

    // Check agreement is in signable state
    if (['terminated','expired','fully_signed'].includes(agr.status)) {
      return fail(res, `Agreement cannot be signed — status: ${agr.status}`);
    }

    const role = isLandlord ? 'landlord' : 'tenant';
    const ip   = req.ip;
    const ua   = req.headers['user-agent'] || '';
    const consentText = `I, ${req.user.full_name}, agree to the terms of this ${agr.type} agreement for ${agr.template_vars ? JSON.parse(agr.template_vars).listing_title : 'the property'}, signed on ${new Date().toISOString()}.`;

    // Create checksum for audit trail
    const checksum = crypto.createHash('sha256')
      .update(`${id}:${userId}:${new Date().toISOString()}:${ip}`)
      .digest('hex');

    // Record signature
    await query(`
      INSERT INTO agreement_signatures (id, agreement_id, signer_id, role, signed_at, ip_address, user_agent, consent_text, checksum)
      VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8)
    `, [uuidv4(), id, userId, role, ip, ua, consentText, checksum]);

    // Update agreement status
    let newStatus = agr.status;
    const sigUpdate = isLandlord
      ? `landlord_signed_at = NOW(), landlord_ip = '${ip}'`
      : `tenant_signed_at = NOW(), tenant_ip = '${ip}'`;

    // Determine new overall status
    if (isLandlord && agr.tenant_signed_at) newStatus = 'fully_signed';
    else if (isTenant && agr.landlord_signed_at) newStatus = 'fully_signed';
    else newStatus = isLandlord ? 'landlord_signed' : 'tenant_signed';

    await query(`
      UPDATE agreements SET ${sigUpdate}, status = $1, updated_at = NOW() WHERE id = $2
    `, [newStatus, id]);

    // If fully signed, notify both parties + update listing status
    if (newStatus === 'fully_signed') {
      const otherPartyId = isLandlord ? agr.tenant_id : agr.landlord_id;
      await createNotification(otherPartyId, 'agreement',
        '✅ Agreement Fully Signed!',
        'Your lease agreement is fully executed and binding.',
        { agreement_id: id });

      // Mark listing as rented/sold
      const newListingStatus = agr.type === 'sale' ? 'sold' : 'rented';
      await query('UPDATE listings SET status = $1, updated_at = NOW() WHERE id = $2',
        [newListingStatus, agr.listing_id]);
    } else {
      // Notify the other party it's waiting for their signature
      const otherPartyId = isLandlord ? agr.tenant_id : agr.landlord_id;
      const otherRole = isLandlord ? 'Landlord' : 'Tenant';
      await createNotification(otherPartyId, 'agreement',
        `📋 ${otherRole} has signed — your turn`,
        'The agreement is waiting for your signature.',
        { agreement_id: id });
    }

    ok(res, {
      signed: true,
      role,
      status: newStatus,
      fully_signed: newStatus === 'fully_signed',
      checksum,
    });
  } catch (e) {
    logger.error('Sign agreement error', { error: e.message });
    fail(res, 'Signing failed', 500);
  }
});

// ── GET /api/agreements/:id/preview ─────────────────────────
// Returns formatted HTML preview of the agreement (for display before signing)
router.get('/:id/preview', authenticate, async (req, res) => {
  try {
    const result = await query(`
      SELECT a.*, l.title AS listing_title, l.address, l.area, l.bedrooms, l.bathrooms,
        l.size_sqm, l.amenities,
        tenant.full_name AS tenant_name, tenant.phone AS tenant_phone,
        landlord.full_name AS landlord_name, landlord.phone AS landlord_phone
      FROM agreements a
      JOIN listings l ON a.listing_id = l.id
      JOIN users tenant ON a.tenant_id = tenant.id
      JOIN users landlord ON a.landlord_id = landlord.id
      WHERE a.id = $1 AND (a.tenant_id = $2 OR a.landlord_id = $2 OR $3 = 'admin')
    `, [req.params.id, req.user.id, req.user.role]);

    if (!result.rows.length) return fail(res, 'Agreement not found', 404);
    const agr = result.rows[0];
    const fmtNaira = n => '₦' + Number(n || 0).toLocaleString('en-NG');
    const fmtDate  = d => d ? new Date(d).toLocaleDateString('en-NG', { day:'numeric', month:'long', year:'numeric' }) : '—';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{font-family:'Georgia',serif;max-width:800px;margin:0 auto;padding:40px;color:#1a1a1a;line-height:1.7}
h1{font-size:1.4rem;text-align:center;text-transform:uppercase;letter-spacing:0.1em;border-bottom:2px solid #c9952a;padding-bottom:1rem}
h2{font-size:1rem;text-transform:uppercase;letter-spacing:0.05em;color:#c9952a;margin-top:2rem}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:2rem;margin:1.5rem 0}
.party{background:#f9f7f2;border:1px solid #e8e0d0;padding:1rem;border-radius:8px}
.clause{margin-bottom:1rem;padding:0.5rem 0;border-bottom:1px solid #f0e8d8}
.sig-block{display:grid;grid-template-columns:1fr 1fr;gap:2rem;margin-top:3rem}
.sig-line{border-top:1px solid #333;margin-top:2rem;padding-top:0.5rem;font-size:0.85rem}
</style></head><body>
<div style="text-align:center;margin-bottom:2rem">
  <div style="font-size:1.6rem;font-weight:900;letter-spacing:0.1em">PROPATI</div>
  <div style="font-size:0.85rem;color:#666">Nigeria's Verified Property Platform</div>
</div>

<h1>${agr.type === 'rental' ? 'Tenancy Agreement' : agr.type === 'sale' ? 'Sale Agreement' : 'Property Agreement'}</h1>
<p style="text-align:center;color:#666">Agreement ID: ${agr.id} · Generated: ${fmtDate(new Date())}</p>

<h2>1. Parties</h2>
<div class="parties">
  <div class="party">
    <strong>LANDLORD / LICENSOR</strong><br>
    ${agr.landlord_name}<br>
    Tel: ${agr.landlord_phone || '—'}
    ${agr.landlord_signed_at ? `<br><small style="color:green">✓ Signed ${fmtDate(agr.landlord_signed_at)}</small>` : ''}
  </div>
  <div class="party">
    <strong>TENANT / LICENSEE</strong><br>
    ${agr.tenant_name}<br>
    Tel: ${agr.tenant_phone || '—'}
    ${agr.tenant_signed_at ? `<br><small style="color:green">✓ Signed ${fmtDate(agr.tenant_signed_at)}</small>` : ''}
  </div>
</div>

<h2>2. Property</h2>
<p><strong>${agr.listing_title}</strong><br>
${agr.address}, ${agr.area}<br>
${agr.bedrooms || '—'} bedroom(s) · ${agr.bathrooms || '—'} bathroom(s)${agr.size_sqm ? ` · ${agr.size_sqm} m²` : ''}</p>

<h2>3. Terms</h2>
<div class="clause"><strong>Start Date:</strong> ${fmtDate(agr.start_date)}</div>
<div class="clause"><strong>End Date:</strong> ${agr.end_date ? fmtDate(agr.end_date) : 'Month-to-month'}</div>
<div class="clause"><strong>Rent:</strong> ${fmtNaira(agr.rent_amount)} per ${agr.rent_period === 'yearly' ? 'year' : 'month'}</div>
<div class="clause"><strong>Caution Deposit:</strong> ${fmtNaira(agr.caution_deposit)} (refundable, subject to property condition)</div>
${agr.service_charge > 0 ? `<div class="clause"><strong>Service Charge:</strong> ${fmtNaira(agr.service_charge)} per annum</div>` : ''}
<div class="clause"><strong>Notice Period:</strong> ${agr.notice_period_days || 30} days written notice required from either party</div>

<h2>4. Standard Clauses</h2>
<p>4.1 The Tenant shall use the property solely as a private dwelling and shall not sublet without prior written consent from the Landlord.</p>
<p>4.2 The Tenant shall maintain the property in good condition and report any damage immediately.</p>
<p>4.3 The Landlord shall ensure the property is habitable and all essential services are functional at the commencement of the tenancy.</p>
<p>4.4 All rent payments shall be made through the PROPATI platform and held in escrow until the Landlord confirms move-in.</p>
<p>4.5 The caution deposit shall be returned within 14 days of the termination of this agreement, subject to property inspection.</p>
<p>4.6 This agreement is governed by the laws of the Federal Republic of Nigeria.</p>

${agr.special_clauses ? `<h2>5. Special Clauses</h2><p>${agr.special_clauses}</p>` : ''}

<h2>Execution</h2>
<div class="sig-block">
  <div>
    <div style="height:60px;border:1px dashed #ccc;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#aaa;font-style:italic">
      ${agr.landlord_signed_at ? `<span style="color:green;font-style:normal">✓ Signed electronically</span>` : 'Landlord signature'}
    </div>
    <div class="sig-line"><strong>${agr.landlord_name}</strong><br>Landlord · ${agr.landlord_signed_at ? fmtDate(agr.landlord_signed_at) : 'Pending'}</div>
  </div>
  <div>
    <div style="height:60px;border:1px dashed #ccc;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#aaa;font-style:italic">
      ${agr.tenant_signed_at ? `<span style="color:green;font-style:normal">✓ Signed electronically</span>` : 'Tenant signature'}
    </div>
    <div class="sig-line"><strong>${agr.tenant_name}</strong><br>Tenant · ${agr.tenant_signed_at ? fmtDate(agr.tenant_signed_at) : 'Pending'}</div>
  </div>
</div>

<p style="margin-top:3rem;font-size:0.75rem;color:#999;text-align:center">
  This document was generated by PROPATI Technologies Ltd. Electronic signatures on this platform are legally binding under Nigerian law.
  Agreement ID: ${agr.id}
</p>
</body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    fail(res, 'Preview failed', 500);
  }
});

// ── PATCH /api/agreements/:id ────────────────────────────────
router.patch('/:id', authenticate, requireRole('landlord', 'admin', 'estate_manager'), async (req, res) => {
  try {
    const { status, special_clauses } = req.body;
    const validTransitions = ['terminated', 'expired'];
    if (status && !validTransitions.includes(status)) return fail(res, 'Invalid status transition');

    const result = await query(`
      UPDATE agreements SET
        status = COALESCE($1, status),
        special_clauses = COALESCE($2, special_clauses),
        updated_at = NOW()
      WHERE id = $3 AND (landlord_id = $4 OR $5 = 'admin')
      RETURNING *
    `, [status || null, special_clauses || null, req.params.id, req.user.id, req.user.role]);

    if (!result.rows.length) return fail(res, 'Agreement not found or access denied', 404);
    ok(res, { agreement: result.rows[0] });
  } catch (e) {
    fail(res, 'Update failed', 500);
  }
});

module.exports = router;
