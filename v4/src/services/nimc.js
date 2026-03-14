// src/services/nimc.js — NIMC NIN Verification
const axios = require('axios');

async function verifyNIN(nin, firstName, lastName, dateOfBirth) {
  // In dev/without API key — simulate verification
  if (!process.env.NIMC_API_KEY || process.env.NIMC_API_KEY.includes('your_nimc')) {
    console.log(`[NIMC MOCK] Verifying NIN: ${nin} for ${firstName} ${lastName}`);
    // Simulate: NIN starting with 9 passes, others fail (for testing)
    const passes = nin.startsWith('9') || process.env.NODE_ENV === 'development';
    return {
      success: passes,
      mock: true,
      data: passes ? {
        nin,
        firstName,
        lastName,
        verified: true,
        gender: 'M',
        dateOfBirth,
      } : null,
      error: passes ? null : 'NIN not found or does not match provided details'
    };
  }

  try {
    const res = await axios.post(
      `${process.env.NIMC_BASE_URL}/verify`,
      { nin, firstname: firstName, lastname: lastName, dob: dateOfBirth },
      {
        headers: {
          'apiKey': process.env.NIMC_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    const d = res.data;
    return {
      success: d.verified === true,
      data: d,
      error: d.verified ? null : 'NIN verification failed'
    };
  } catch (e) {
    console.error('NIMC error:', e.response?.data || e.message);
    return {
      success: false,
      error: e.response?.data?.message || 'NIN verification service unavailable'
    };
  }
}

module.exports = { verifyNIN };
