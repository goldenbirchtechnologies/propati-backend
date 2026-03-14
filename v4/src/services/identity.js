// src/services/identity.js — Identity Verification via Prembly IdentityPass
// Docs: https://docs.prembly.com/
// Sign up: https://identitypass.prembly.com
// Required env: PREMBLY_API_KEY, PREMBLY_APP_ID
'use strict';
const axios  = require('axios');
const logger = require('./logger');

const BASE = 'https://api.prembly.com/identitypass/verification';

function getHeaders() {
  return {
    'x-api-key': process.env.PREMBLY_API_KEY,
    'app-id':    process.env.PREMBLY_APP_ID,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function isMockMode() {
  return !process.env.PREMBLY_API_KEY || process.env.PREMBLY_API_KEY === 'mock';
}

// ── Verify NIN (National Identity Number) ─────────────────
// Returns { verified, data: { first_name, last_name, dob, photo, nin } }
async function verifyNIN(nin) {
  if (isMockMode()) {
    logger.info('[MOCK] NIN verification', { nin: nin.slice(0,4) + '***' });
    // Realistic mock response for dev/testing
    return {
      verified: true,
      data: {
        nin,
        first_name:  'VERIFIED',
        last_name:   'USER',
        middle_name: '',
        dob:         '1990-01-01',
        phone:       '08000000000',
        gender:      'M',
        photo:       null,
        address:     'Lagos, Nigeria',
      },
      source: 'mock',
    };
  }

  try {
    const res = await axios.post(`${BASE}/biometric/nin`, { nin }, {
      headers: getHeaders(), timeout: 15000,
    });

    const d = res.data;
    if (d.status && d.data) {
      return {
        verified: true,
        data: {
          nin,
          first_name:  d.data.firstname  || d.data.first_name,
          last_name:   d.data.surname    || d.data.last_name,
          middle_name: d.data.middlename || '',
          dob:         d.data.birthdate  || d.data.dob,
          phone:       d.data.phone,
          gender:      d.data.gender,
          photo:       d.data.photo,
          address:     d.data.residence_address,
        },
        source: 'prembly',
      };
    }
    return { verified: false, error: d.message || 'NIN verification failed', source: 'prembly' };
  } catch (e) {
    logger.error('NIN verification error', { error: e.message });
    const msg = e.response?.data?.message || e.message;
    return { verified: false, error: msg, source: 'prembly' };
  }
}

// ── Verify BVN (Bank Verification Number) ─────────────────
async function verifyBVN(bvn) {
  if (isMockMode()) {
    logger.info('[MOCK] BVN verification', { bvn: bvn.slice(0,4) + '***' });
    return {
      verified: true,
      data: { bvn, first_name: 'VERIFIED', last_name: 'USER', dob: '1990-01-01', phone: '08000000000' },
      source: 'mock',
    };
  }

  try {
    const res = await axios.post(`${BASE}/biometric/bvn`, { number: bvn }, {
      headers: getHeaders(), timeout: 15000,
    });
    const d = res.data;
    if (d.status && d.data) {
      return {
        verified: true,
        data: {
          bvn,
          first_name:  d.data.first_name || d.data.firstName,
          last_name:   d.data.last_name  || d.data.lastName,
          middle_name: d.data.middle_name || '',
          dob:         d.data.date_of_birth || d.data.dob,
          phone:       d.data.phone_number,
        },
        source: 'prembly',
      };
    }
    return { verified: false, error: d.message || 'BVN verification failed', source: 'prembly' };
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    return { verified: false, error: msg, source: 'prembly' };
  }
}

// ── Verify Voter's Card ────────────────────────────────────
async function verifyVotersCard(vin, dob) {
  if (isMockMode()) {
    return { verified: true, data: { vin, first_name: 'VERIFIED', last_name: 'USER' }, source: 'mock' };
  }
  try {
    const res = await axios.post(`${BASE}/voter_card`, { vin, dob }, {
      headers: getHeaders(), timeout: 15000,
    });
    const d = res.data;
    return d.status
      ? { verified: true, data: d.data, source: 'prembly' }
      : { verified: false, error: d.message, source: 'prembly' };
  } catch (e) {
    return { verified: false, error: e.response?.data?.message || e.message, source: 'prembly' };
  }
}

// ── Verify Driver's License ────────────────────────────────
async function verifyDriversLicense(license_number, dob) {
  if (isMockMode()) {
    return { verified: true, data: { license_number, first_name: 'VERIFIED', last_name: 'USER' }, source: 'mock' };
  }
  try {
    const res = await axios.post(`${BASE}/drivers_license`, { license_number, dob }, {
      headers: getHeaders(), timeout: 15000,
    });
    const d = res.data;
    return d.status
      ? { verified: true, data: d.data, source: 'prembly' }
      : { verified: false, error: d.message, source: 'prembly' };
  } catch (e) {
    return { verified: false, error: e.response?.data?.message || e.message, source: 'prembly' };
  }
}

module.exports = { verifyNIN, verifyBVN, verifyVotersCard, verifyDriversLicense, isMockMode };
