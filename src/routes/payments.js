// src/routes/payments.js — Payments, Escrow & Paystack Webhooks
'use strict';
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const paystack = require('../services/paystack');
const {
  notifyPaymentReceived, notifyEscrowReleased, createNotification
} = require('../services/notifications');
const logger = require('../services/logger');
const crypto = require('crypto');

const ok   = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const fail = (res, msg, status = 400)  => res.status(status).json({ success: false, error: msg });

const PLATFORM_FEE_PCT = parseFloat(process.env.PLATFORM_FEE_PCT) || 2.5;
const AGENT_COMMISSION_PCT = parseFloat(process.env.AGENT_COMMISSION_PCT) || 5.0;

function computeFees(type, amount) {
  const platformFee = Math.round(amount * (PLATFORM_FEE_PCT / 100) * 100) / 100;
  const agentCommission = type === 'rent' ? 0 : Math.round(amount * (AGENT_COMMISSION_PCT / 100) * 100) / 100;
  const payeeAmount = amount - platformFee - agentCommission;
  return { platformFee, agentCommission, payeeAmount };
}

function generateRef() {
  return 'PAY-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ── POST /api/payments/initiate ─────────────────────────────
// Tenant initiates payment → Paystack hosted checkout
router.post('/initiate', authenticate, [
  body('listing_id').notEmpty(),
  body('type').isIn(['rent','sale','short_let','caution','service_charge']),
  body('amount').isFloat({ min: 100 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return fail(res, errors.array()[0].msg, 422);

  try {
    const { listing_id, type, amount, agreement_id } = req.body;
    const payerId = req.user.id;

    const listingResult = await query(
      "SELECT l.*, u.email AS landlord_email, u.phone AS landlord_phone FROM listings l JOIN users u ON l.owner_id = u.id WHERE l.id = $1 AND l.status = 'active'",
      [listing_id]
    );
    if (!listingResult.rows.length) return fail(res, 'Listing not found or not active', 404);
    const listing = listingResult.rows[0];

    const { platformFee, agentCommission, payeeAmount } = computeFees(type, amount);
    const releaseAfterDays = type === 'sale' ? 30 : 7;
    const escrowRelease = new Date(Date.now() + releaseAfterDays * 86400000).toISOString();

    const txnId = 'txn_' + uuidv4().replace(/-/g, '').slice(0, 12);
    const reference = generateRef();

    // Create pending transaction
    await query(`
      INSERT INTO transactions
        (id, reference, listing_id, payer_id, payee_id, type, status, amount, platform_fee, agent_commission, payee_amount, escrow_release_date, description)
      VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11,$12)
    `, [txnId, reference, listing_id, payerId, listing.owner_id, type,
        amount, platformFee, agentCommission, payeeAmount, escrowRelease,
        `${type} payment for ${listing.title}`]);

    // Initialize Paystack transaction
    const paystackRes = await paystack.initializeTransaction({
      email: req.user.email,
      amount: Math.round(amount * 100), // kobo
      reference,
      metadata: {
        txn_id: txnId,
        listing_id,
        payer_id: payerId,
        payee_id: listing.owner_id,
        type,
        agreement_id: agreement_id || null,
        custom_fields: [
          { display_name: 'Property', variable_name: 'property', value: listing.title },
          { display_name: 'Transaction Type', variable_name: 'type', value: type },
        ],
      },
      callback_url: `${process.env.FRONTEND_URL || 'https://propati.ng'}/payment-callback`,
    });

    if (!paystackRes.success) throw new Error(paystackRes.error || 'Paystack init failed');

    ok(res, {
      transaction_id: txnId,
      reference,
      authorization_url: paystackRes.data.authorization_url,
      access_code: paystackRes.data.access_code,
      amount,
      fees: { platform_fee: platformFee, agent_commission: agentCommission, you_receive: payeeAmount },
      escrow_release: escrowRelease,
    });
  } catch (e) {
    logger.error('Payment initiate error', { error: e.message });
    fail(res, e.message || 'Payment initiation failed', 500);
  }
});

// ── GET /api/payments/verify/:reference ─────────────────────
// Called after redirect from Paystack to verify payment
router.get('/verify/:reference', authenticate, async (req, res) => {
  try {
    const { reference } = req.params;

    // Check our DB first
    const txnResult = await query('SELECT * FROM transactions WHERE reference = $1', [reference]);
    if (!txnResult.rows.length) return fail(res, 'Transaction not found', 404);
    const txn = txnResult.rows[0];

    if (txn.status === 'in_escrow' || txn.status === 'released') {
      return ok(res, { transaction: txn, already_verified: true });
    }

    // Verify with Paystack
    const paystackRes = await paystack.verifyTransaction(reference);
    if (!paystackRes.success) return fail(res, 'Paystack verification failed');

    const pData = paystackRes.data;
    if (pData.status !== 'success') {
      await query("UPDATE transactions SET status = 'failed', updated_at = NOW() WHERE reference = $1", [reference]);
      return fail(res, 'Payment was not successful: ' + pData.gateway_response);
    }

    // Mark as in_escrow
    await query(`
      UPDATE transactions SET
        status = 'in_escrow', paystack_ref = $1, paystack_txn_id = $2, updated_at = NOW()
      WHERE reference = $3
    `, [pData.reference, String(pData.id), reference]);

    // Update rent_schedule if linked to agreement
    if (pData.metadata?.agreement_id) {
      await query(`
        UPDATE rent_schedule SET status = 'paid', paid_at = NOW(), transaction_id = $1
        WHERE agreement_id = $2 AND status = 'upcoming'
        ORDER BY due_date ASC LIMIT 1
      `, [txn.id, pData.metadata.agreement_id]);
    }

    // Notify landlord
    const listingResult = await query(
      'SELECT title FROM listings WHERE id = $1', [txn.listing_id]
    );
    const landlordResult = await query('SELECT id, full_name, phone, email FROM users WHERE id = $1', [txn.payee_id]);

    if (landlordResult.rows[0]) {
      await notifyPaymentReceived(
        landlordResult.rows[0],
        txn.amount,
        listingResult.rows[0]?.title || 'your property'
      );
    }

    const updatedTxn = await query('SELECT * FROM transactions WHERE reference = $1', [reference]);
    ok(res, { transaction: updatedTxn.rows[0], verified: true });
  } catch (e) {
    logger.error('Payment verify error', { error: e.message });
    fail(res, 'Verification failed', 500);
  }
});

// ── POST /api/payments/webhook ───────────────────────────────
// Paystack webhook — MUST be unauthenticated, verified by signature
router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const secret = process.env.PAYSTACK_SECRET_KEY;

    if (!secret) {
      logger.warn('PAYSTACK_SECRET_KEY not set — skipping webhook signature verify');
    } else {
      const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
      if (hash !== signature) {
        logger.security('Invalid Paystack webhook signature', req.ip);
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    const event = req.body;
    logger.info('Paystack webhook', { event: event.event });

    switch (event.event) {
      case 'charge.success': {
        const data = event.data;
        const reference = data.reference;

        const txnResult = await query('SELECT * FROM transactions WHERE reference = $1', [reference]);
        if (!txnResult.rows.length) break;
        const txn = txnResult.rows[0];

        if (txn.status === 'in_escrow') break; // already processed

        await query(`
          UPDATE transactions SET
            status = 'in_escrow', paystack_ref = $1, paystack_txn_id = $2, updated_at = NOW()
          WHERE reference = $3
        `, [data.reference, String(data.id), reference]);

        // Handle org subscription activation
        if (data.metadata?.type === 'org_subscription') {
          const { org_id, plan } = data.metadata;
          const planSeats = { starter: 1, growth: 5, enterprise: 9999 };
          const planUnits = { starter: 20, growth: 100, enterprise: 9999 };
          await query(`
            UPDATE organisations SET plan_tier = $1, max_units = $2, max_seats = $3, updated_at = NOW()
            WHERE id = $4
          `, [plan, planUnits[plan] || 20, planSeats[plan] || 1, org_id]);
          await query(`
            UPDATE org_subscriptions SET
              status = 'active', paystack_sub_id = $1, amount = $2,
              current_period_start = NOW(), next_billing_date = NOW() + INTERVAL '30 days', updated_at = NOW()
            WHERE org_id = $3
          `, [data.reference, data.amount / 100, org_id]);
        }

        break;
      }

      case 'transfer.success': {
        // Payout to landlord confirmed
        const { reference } = event.data;
        await query(`
          UPDATE transactions SET status = 'released', escrow_released_at = NOW(), updated_at = NOW()
          WHERE paystack_ref = $1
        `, [reference]);
        break;
      }

      case 'subscription.create':
      case 'subscription.not_renew':
      case 'invoice.payment_failed': {
        logger.info('Subscription event', { event: event.event, data: event.data });
        break;
      }
    }

    res.status(200).json({ received: true });
  } catch (e) {
    logger.error('Webhook error', { error: e.message });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── POST /api/payments/release-escrow/:txn_id ───────────────
// Admin or auto-release after escrow_release_date
router.post('/release-escrow/:txn_id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { txn_id } = req.params;
    const txnResult = await query(
      "SELECT * FROM transactions WHERE id = $1 AND status = 'in_escrow'",
      [txn_id]
    );
    if (!txnResult.rows.length) return fail(res, 'Transaction not in escrow', 404);
    const txn = txnResult.rows[0];

    // Check escrow date
    if (new Date(txn.escrow_release_date) > new Date() && !req.body.force) {
      return fail(res, `Escrow not yet releasable. Earliest: ${new Date(txn.escrow_release_date).toLocaleDateString()}`);
    }

    // Initiate Paystack transfer to landlord
    const landlordResult = await query(
      'SELECT email, full_name FROM users WHERE id = $1',
      [txn.payee_id]
    );

    // Mark as released in DB
    await query(`
      UPDATE transactions SET
        status = 'released', escrow_released_at = NOW(),
        escrow_released_by = $1, updated_at = NOW()
      WHERE id = $2
    `, [req.user.id, txn_id]);

    // Notify landlord
    const landlord = landlordResult.rows[0];
    if (landlord) {
      await notifyEscrowReleased(
        { id: txn.payee_id, full_name: landlord.full_name, email: landlord.email },
        txn.payee_amount
      );
    }

    ok(res, { released: true, amount: txn.payee_amount, payee: landlord?.full_name });
  } catch (e) {
    logger.error('Release escrow error', { error: e.message });
    fail(res, 'Release failed', 500);
  }
});

// ── GET /api/payments/my ─────────────────────────────────────
router.get('/my', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await query(`
      SELECT t.*, l.title AS listing_title, l.area,
        payer.full_name AS payer_name, payee.full_name AS payee_name
      FROM transactions t
      LEFT JOIN listings l ON t.listing_id = l.id
      LEFT JOIN users payer ON t.payer_id = payer.id
      LEFT JOIN users payee ON t.payee_id = payee.id
      WHERE t.payer_id = $1 OR t.payee_id = $1
      ORDER BY t.created_at DESC
      LIMIT 50
    `, [userId]);
    ok(res, { transactions: result.rows });
  } catch (e) {
    fail(res, 'Failed to load transactions', 500);
  }
});

// ── GET /api/payments/rent-schedule/:agreement_id ───────────
router.get('/rent-schedule/:agreement_id', authenticate, async (req, res) => {
  try {
    const result = await query(`
      SELECT rs.*, a.tenant_id, a.landlord_id
      FROM rent_schedule rs
      JOIN agreements a ON rs.agreement_id = a.id
      WHERE rs.agreement_id = $1
        AND (a.tenant_id = $2 OR a.landlord_id = $2)
      ORDER BY rs.due_date ASC
    `, [req.params.agreement_id, req.user.id]);
    ok(res, { schedule: result.rows });
  } catch (e) {
    fail(res, 'Failed to load schedule', 500);
  }
});

// ── POST /api/payments/cron/release-due ─────────────────────
// Called by Railway cron daily — auto-releases past-due escrow
router.post('/cron/release-due', async (req, res) => {
  // Simple token check for cron security
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await query(`
      SELECT t.*, u.email AS landlord_email, u.phone AS landlord_phone,
             u.full_name AS landlord_name, l.title AS listing_title
      FROM transactions t
      JOIN users u ON t.payee_id = u.id
      JOIN listings l ON t.listing_id = l.id
      WHERE t.status = 'in_escrow' AND t.escrow_release_date <= NOW()
    `);

    let released = 0;
    for (const txn of result.rows) {
      await query(`
        UPDATE transactions SET
          status = 'released', escrow_released_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `, [txn.id]);

      await notifyEscrowReleased(
        { id: txn.payee_id, full_name: txn.landlord_name, phone: txn.landlord_phone, email: txn.landlord_email },
        txn.payee_amount
      );
      released++;
    }

    res.json({ released });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
