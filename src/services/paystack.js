// src/services/paystack.js — Paystack integration
const axios = require('axios');

const BASE = 'https://api.paystack.co';
const headers = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  'Content-Type': 'application/json'
});

// Initialize a payment (returns authorization_url for redirect)
async function initializePayment({ email, amount, reference, metadata, callbackUrl }) {
  if (!process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes('your_key')) {
    // Mock for dev
    return {
      success: true,
      mock: true,
      data: {
        authorization_url: `https://checkout.paystack.com/mock?ref=${reference}`,
        reference,
        access_code: 'mock_access_code'
      }
    };
  }
  try {
    const res = await axios.post(`${BASE}/transaction/initialize`, {
      email,
      amount: Math.round(amount * 100), // Paystack uses kobo
      reference,
      metadata,
      callback_url: callbackUrl || process.env.FRONTEND_URL + '/payment/callback'
    }, { headers: headers() });
    return { success: true, data: res.data.data };
  } catch (e) {
    return { success: false, error: e.response?.data?.message || e.message };
  }
}

// Verify a transaction by reference
async function verifyPayment(reference) {
  if (!process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes('your_key')) {
    return {
      success: true,
      mock: true,
      data: { status: 'success', reference, amount: 0, paid_at: new Date().toISOString() }
    };
  }
  try {
    const res = await axios.get(`${BASE}/transaction/verify/${reference}`, { headers: headers() });
    const d = res.data.data;
    return {
      success: d.status === 'success',
      data: {
        status: d.status,
        reference: d.reference,
        amount: d.amount / 100, // back to Naira
        paid_at: d.paid_at,
        channel: d.channel,
        customer: d.customer
      }
    };
  } catch (e) {
    return { success: false, error: e.response?.data?.message || e.message };
  }
}

// Create a transfer recipient (for paying out to landlords)
async function createRecipient({ name, accountNumber, bankCode }) {
  if (!process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes('your_key')) {
    return { success: true, mock: true, data: { recipient_code: 'RCP_mock_' + Date.now() } };
  }
  try {
    const res = await axios.post(`${BASE}/transferrecipient`, {
      type: 'nuban',
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN'
    }, { headers: headers() });
    return { success: true, data: res.data.data };
  } catch (e) {
    return { success: false, error: e.response?.data?.message || e.message };
  }
}

// Initiate a transfer (payout to landlord)
async function initiateTransfer({ amount, recipientCode, reason, reference }) {
  if (!process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes('your_key')) {
    return { success: true, mock: true, data: { transfer_code: 'TRF_mock_' + Date.now(), status: 'success' } };
  }
  try {
    const res = await axios.post(`${BASE}/transfer`, {
      source: 'balance',
      amount: Math.round(amount * 100),
      recipient: recipientCode,
      reason,
      reference
    }, { headers: headers() });
    return { success: true, data: res.data.data };
  } catch (e) {
    return { success: false, error: e.response?.data?.message || e.message };
  }
}

// Verify webhook signature
const crypto = require('crypto');
function verifyWebhook(body, signature) {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET || '')
    .update(JSON.stringify(body))
    .digest('hex');
  return hash === signature;
}

module.exports = {
  initializePayment, verifyPayment, createRecipient, initiateTransfer, verifyWebhook,
  // Aliases used by payments.js and orgs.js
  initializeTransaction: initializePayment,
  verifyTransaction: verifyPayment,
};
