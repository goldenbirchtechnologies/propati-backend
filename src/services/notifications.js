// src/services/notifications.js — Full Notification Service
// Channels: in-app DB + Nodemailer email + Termii SMS (Nigerian gateway)
// Env vars: SMTP_HOST/SMTP_USER/SMTP_PASS/EMAIL_FROM or GMAIL_USER/GMAIL_APP_PASSWORD
//           TERMII_API_KEY, TERMII_SENDER_ID (request "PROPATI" at termii.com)
'use strict';
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const logger = require('./logger');
const axios = require('axios');

function getTransport() {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({ service:'gmail', auth:{ user:process.env.GMAIL_USER, pass:process.env.GMAIL_APP_PASSWORD } });
  }
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({ host:process.env.SMTP_HOST, port:parseInt(process.env.SMTP_PORT)||587, secure:parseInt(process.env.SMTP_PORT)===465, auth:{ user:process.env.SMTP_USER, pass:process.env.SMTP_PASS } });
  }
  return null;
}

function wrap(body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F5F3EE;font-family:Inter,system-ui,sans-serif">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
  <div style="background:#0B1220;padding:20px 28px"><span style="font-size:18px;font-weight:900;color:#fff;letter-spacing:.06em">PROPATI</span><span style="margin-left:8px;font-size:10px;color:#C9952A;font-weight:600;text-transform:uppercase;letter-spacing:.1em">Verified Property</span></div>
  <div style="padding:28px 28px 8px">${body}</div>
  <div style="padding:16px 28px 24px;border-top:1px solid #F0EDE8"><p style="margin:0;font-size:11px;color:#9CA3AF">Questions? <a href="mailto:support@propati.ng" style="color:#0e7c6a">support@propati.ng</a></p><p style="margin:6px 0 0;font-size:11px;color:#9CA3AF">© 2026 PROPATI. Lagos · Abuja · Port Harcourt</p></div>
</div></body></html>`;
}

const TEMPLATES = {
  welcome: ({name}) => ({ subject:`Welcome to PROPATI, ${name.split(' ')[0]}! 🎉`, html: wrap(`<h2 style="color:#0B1220;margin:0 0 8px">Welcome, ${name.split(' ')[0]}! 🎉</h2><p style="color:#4B5563">You're now on Nigeria's most trusted property platform.</p><a href="https://propati.ng" style="display:inline-block;margin-top:16px;background:#0e7c6a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Get Started →</a>`) }),
  rent_due: ({name,amount,daysLeft,propertyTitle,agreementId}) => ({ subject:`Rent Due in ${daysLeft} Day(s) — ${propertyTitle}`, html: wrap(`<h2 style="color:#0B1220">Rent Due in ${daysLeft} Day${daysLeft!==1?'s':''}</h2><p style="color:#4B5563">Hi ${name.split(' ')[0]}, your rent of <strong>₦${parseFloat(amount).toLocaleString()}</strong> for <strong>${propertyTitle}</strong> is due in ${daysLeft} day(s).</p><a href="https://propati.ng" style="display:inline-block;background:#C9952A;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Pay Now →</a>`) }),
  payment_confirmed: ({name,amount,propertyTitle,reference}) => ({ subject:`Payment Confirmed — ${propertyTitle}`, html: wrap(`<h2 style="color:#0B1220">✅ Payment Confirmed</h2><p style="color:#4B5563">Hi ${name.split(' ')[0]}, ₦${parseFloat(amount).toLocaleString()} received for <strong>${propertyTitle}</strong> and held in escrow.</p><p style="color:#6B7280;font-size:12px">Ref: ${reference}</p><p style="color:#4B5563;font-size:13px">Funds release to your landlord after 7 days.</p>`) }),
  agreement_ready: ({name,propertyTitle,agreementId,role}) => ({ subject:`Lease Agreement Ready to Sign — ${propertyTitle}`, html: wrap(`<h2 style="color:#0B1220">📄 Sign Your Agreement</h2><p style="color:#4B5563">Hi ${name.split(' ')[0]}, a tenancy agreement for <strong>${propertyTitle}</strong> is ready for your signature.</p><a href="https://propati.ng" style="display:inline-block;background:#0B1220;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Review & Sign →</a>`) }),
  verification_update: ({name,propertyTitle,layer,status,notes}) => ({ subject:`Verification Layer ${layer} ${status} — ${propertyTitle}`, html: wrap(`<h2 style="color:#0B1220">${status==='approved'?'✅':'❌'} Layer ${layer} ${status}</h2><p style="color:#4B5563">Hi ${name.split(' ')[0]}, Layer ${layer} for <strong>${propertyTitle}</strong> was <strong>${status}</strong>.${notes?`<br><br>Notes: ${notes}`:''}</p><a href="https://propati.ng/verify" style="display:inline-block;background:#0B1220;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">View Status →</a>`) }),
  new_message: ({name,senderName,preview,conversationId}) => ({ subject:`New message from ${senderName}`, html: wrap(`<h2 style="color:#0B1220">💬 New Message from ${senderName}</h2><p style="color:#4B5563">Hi ${name.split(' ')[0]},</p><div style="background:#F5F3EE;border-left:4px solid #C9952A;padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0;font-style:italic;color:#374151">"${preview}"</div><a href="https://propati.ng" style="display:inline-block;background:#0B1220;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Reply →</a>`) }),
  org_invite: ({orgName,inviterName,email,role}) => ({ subject:`You've been invited to join ${orgName} on PROPATI`, html: wrap(`<h2 style="color:#0B1220">🏢 Organisation Invitation</h2><p style="color:#4B5563"><strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> as <strong>${role.replace('_',' ')}</strong>.</p><p style="color:#4B5563">Sign in or create an account with <strong>${email}</strong> at propati.ng.</p><a href="https://propati.ng/login" style="display:inline-block;background:#1A3A6A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Accept Invitation →</a>`) }),
};

async function createNotification(userId, type, title, body, data=null) {
  try {
    await query('INSERT INTO notifications (id,user_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), userId, type, title, body, data ? JSON.stringify(data) : null]);
  } catch(e) { logger.error('Notification insert error', {error:e.message}); }
}

async function sendEmail(to, subject, html) {
  if (!to) return {success:false,error:'No recipient'};
  const transport = getTransport();
  if (!transport) { logger.info(`[EMAIL DEV → ${to}] ${subject}`); return {success:true,mock:true}; }
  try {
    await transport.sendMail({ from: process.env.EMAIL_FROM||'PROPATI <noreply@propati.ng>', to, subject, html });
    logger.info(`Email sent: ${to} — ${subject}`);
    return {success:true};
  } catch(e) { logger.error('Email error', {error:e.message,to}); return {success:false,error:e.message}; }
}

async function sendTemplateEmail(to, templateName, vars) {
  const tmpl = TEMPLATES[templateName];
  if (!tmpl) return;
  const {subject,html} = tmpl(vars);
  return sendEmail(to, subject, html);
}

async function sendSMS(phone, message) {
  if (!phone) return {success:false,error:'No phone'};
  let n = phone.toString().trim().replace(/\D/g,'');
  if (n.startsWith('0')) n = '234'+n.slice(1);
  if (!n.startsWith('234')) n = '234'+n;
  if (!process.env.TERMII_API_KEY) { logger.info(`[SMS DEV → +${n}] ${message}`); return {success:true,mock:true}; }
  try {
    const res = await axios.post('https://api.ng.termii.com/api/sms/send', {
      to:n, from:process.env.TERMII_SENDER_ID||'PROPATI', sms:message,
      type:'plain', channel:'generic', api_key:process.env.TERMII_API_KEY,
    }, {timeout:8000});
    if (res.data.code==='ok') { logger.info(`SMS sent to +${n}`); return {success:true,message_id:res.data.message_id}; }
    return {success:false,error:res.data.message};
  } catch(e) { logger.error('SMS error',{error:e.message}); return {success:false,error:e.message}; }
}

async function notifyWelcome(user) {
  await createNotification(user.id,'welcome','Welcome to PROPATI! 🎉','Your verified property account is ready.',{});
  if (user.email) sendTemplateEmail(user.email,'welcome',{name:user.full_name}).catch(()=>{});
  if (user.phone) sendSMS(user.phone,`Welcome to PROPATI, ${user.full_name.split(' ')[0]}! Visit propati.ng to get started.`).catch(()=>{});
}

async function notifyRentDue(tenant, agreement, daysUntilDue) {
  const msg = `PROPATI: Rent of ₦${parseFloat(agreement.rent_amount).toLocaleString()} for ${agreement.listing_title||'your property'} is due in ${daysUntilDue} day(s). Pay at propati.ng`;
  await createNotification(tenant.id,'rent_due',`Rent Due in ${daysUntilDue} day(s)`,msg,{agreement_id:agreement.id});
  if (tenant.email) sendTemplateEmail(tenant.email,'rent_due',{name:tenant.full_name,amount:agreement.rent_amount,daysLeft:daysUntilDue,propertyTitle:agreement.listing_title||'your property',agreementId:agreement.id}).catch(()=>{});
  if (tenant.phone) sendSMS(tenant.phone,msg).catch(()=>{});
}

async function notifyPaymentReceived(landlord, amount, listingTitle) {
  const msg = `PROPATI: ₦${parseFloat(amount).toLocaleString()} received for ${listingTitle} and held in escrow.`;
  await createNotification(landlord.id,'payment_received','Payment Received',msg,{});
  if (landlord.phone) sendSMS(landlord.phone,msg).catch(()=>{});
  if (landlord.email) sendTemplateEmail(landlord.email,'payment_confirmed',{name:landlord.full_name,amount,propertyTitle:listingTitle,reference:'See dashboard'}).catch(()=>{});
}

async function notifyEscrowReleased(landlord, amount) {
  const msg = `PROPATI: ₦${parseFloat(amount).toLocaleString()} released from escrow and transferred to your account.`;
  await createNotification(landlord.id,'escrow_released','Escrow Released',msg,{});
  if (landlord.phone) sendSMS(landlord.phone,msg).catch(()=>{});
  if (landlord.email) sendEmail(landlord.email,'Escrow Released — PROPATI', wrap(`<h2>💰 Escrow Released</h2><p>₦${parseFloat(amount).toLocaleString()} is on its way to your account.</p>`)).catch(()=>{});
}

async function notifyVerificationUpdate(owner, listingTitle, layer, status, notes) {
  await createNotification(owner.id,'verification_update',`Layer ${layer} ${status}`,`${listingTitle}: Layer ${layer} ${status}`,{layer,status});
  if (owner.email) sendTemplateEmail(owner.email,'verification_update',{name:owner.full_name,propertyTitle:listingTitle,layer,status,notes}).catch(()=>{});
  if (owner.phone && status==='rejected') sendSMS(owner.phone,`PROPATI: Verification Layer ${layer} for ${listingTitle} was rejected. Please resubmit at propati.ng`).catch(()=>{});
}

async function notifyNewMessage(recipient, senderName, messagePreview, conversationId) {
  await createNotification(recipient.id,'new_message',`New message from ${senderName}`,messagePreview.slice(0,100),{conversation_id:conversationId});
  if (recipient.email) sendTemplateEmail(recipient.email,'new_message',{name:recipient.full_name,senderName,preview:messagePreview.slice(0,120),conversationId}).catch(()=>{});
}

async function runRentReminders() {
  logger.info('Running rent reminders cron...');
  try {
    const {rows} = await query(`
      SELECT rs.id AS schedule_id, rs.due_date, rs.amount, a.id AS agreement_id, l.title AS listing_title,
        u.id AS tenant_id, u.full_name, u.email, u.phone
      FROM rent_schedule rs
      JOIN agreements a ON rs.agreement_id=a.id
      JOIN listings l ON a.listing_id=l.id
      JOIN users u ON a.tenant_id=u.id
      WHERE rs.status='upcoming' AND rs.reminder_sent=0
        AND rs.due_date IN (
          (NOW()+INTERVAL '7 days')::date::text,
          (NOW()+INTERVAL '3 days')::date::text,
          (NOW()+INTERVAL '1 day')::date::text
        )
    `);
    for (const r of rows) {
      const daysLeft = Math.round((new Date(r.due_date)-new Date())/(1000*60*60*24));
      await notifyRentDue({id:r.tenant_id,full_name:r.full_name,email:r.email,phone:r.phone},{id:r.agreement_id,rent_amount:r.amount,listing_title:r.listing_title},daysLeft);
      await query('UPDATE rent_schedule SET reminder_sent=1 WHERE id=$1',[r.schedule_id]);
    }
    await query("UPDATE rent_schedule SET status='overdue' WHERE status='upcoming' AND due_date<NOW()::date::text");
    logger.info(`Rent reminders done. ${rows.length} sent.`);
  } catch(e) { logger.error('Rent reminder cron error',{error:e.message}); }
}

// exports defined at bottom of file

// ── Missing functions called by orgs.js and agreements.js ──

async function notifyTeamInvite(email, orgName, role, inviteToken) {
  const inviteUrl = `${process.env.FRONTEND_URL || 'https://propati.ng'}/accept-invite?token=${inviteToken}`;
  const roleLabel = role.replace('_', ' ');
  await sendEmail(email, `You've been invited to join ${orgName} on PROPATI`,
    wrap(`<h2 style="color:#0B1220">🏢 You're invited to ${orgName}</h2>
    <p style="color:#4B5563">You've been invited to join <strong>${orgName}</strong> as <strong>${roleLabel}</strong> on PROPATI.</p>
    <p style="color:#4B5563">Click below to accept and set up your account.</p>
    <a href="${inviteUrl}" style="display:inline-block;margin-top:16px;background:#1A3A6A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Accept Invitation →</a>
    <p style="color:#9CA3AF;font-size:12px;margin-top:16px">If you weren't expecting this, ignore this email.</p>`)
  );
}

async function notifyNewTicket(orgId, ticket, propertyTitle) {
  try {
    // Notify all managers in the org
    const { query: db } = require('../db');
    const managers = await db(
      `SELECT u.id, u.email, u.phone, u.full_name FROM org_members om JOIN users u ON om.user_id = u.id WHERE om.org_id = $1 AND om.role IN ('manager','maintenance') AND om.status = 'active'`,
      [orgId]
    );
    for (const m of managers.rows) {
      await createNotification(m.id, 'new_ticket', `New ticket: ${ticket.title}`,
        `${ticket.priority?.toUpperCase()} priority ${ticket.category || ''} issue at ${propertyTitle}`,
        { ticket_id: ticket.id }
      );
      if (m.phone && ticket.priority === 'urgent') {
        sendSMS(m.phone, `PROPATI URGENT: New maintenance ticket "${ticket.title}" at ${propertyTitle}. Login to assign.`).catch(() => {});
      }
    }
  } catch (e) { logger.error('notifyNewTicket error', { error: e.message }); }
}

async function notifyTicketResolved(tenantId, ticketTitle, tenantPhone) {
  await createNotification(tenantId, 'ticket_resolved', 'Issue Resolved ✅',
    `Your maintenance request "${ticketTitle}" has been resolved.`, {}
  );
  if (tenantPhone) {
    sendSMS(tenantPhone, `PROPATI: Your maintenance request "${ticketTitle.slice(0, 60)}" has been resolved. Login to confirm.`).catch(() => {});
  }
  try {
    const { query: db } = require('../db');
    const tenant = await db('SELECT email, full_name FROM users WHERE id = $1', [tenantId]);
    if (tenant.rows[0]?.email) {
      sendEmail(tenant.rows[0].email, `Issue Resolved: ${ticketTitle}`,
        wrap(`<h2 style="color:#0B1220">✅ Issue Resolved</h2>
        <p style="color:#4B5563">Hi ${tenant.rows[0].full_name?.split(' ')[0]}, your maintenance request <strong>"${ticketTitle}"</strong> has been resolved by the property management team.</p>
        <p style="color:#4B5563">If the issue persists, you can reopen it from your dashboard.</p>
        <a href="https://propati.ng" style="display:inline-block;background:#0B1220;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">View Dashboard →</a>`)
      ).catch(() => {});
    }
  } catch (e) {}
}

async function notifyAgreementReady(tenantId, landlordId, propertyTitle, agreementId) {
  // Notify tenant
  await createNotification(tenantId, 'agreement_ready', 'Agreement ready to sign',
    `Your tenancy agreement for ${propertyTitle} is ready.`, { agreement_id: agreementId }
  );
  // Notify landlord
  await createNotification(landlordId, 'agreement_ready', 'Tenant agreement sent',
    `Agreement for ${propertyTitle} sent to tenant for signature.`, { agreement_id: agreementId }
  );
  try {
    const { query: db } = require('../db');
    const tenant   = await db('SELECT email, full_name, phone FROM users WHERE id = $1', [tenantId]);
    const landlord = await db('SELECT email, full_name FROM users WHERE id = $1', [landlordId]);
    const t = tenant.rows[0];
    const l = landlord.rows[0];
    if (t?.email) sendTemplateEmail(t.email, 'agreement_ready', { name: t.full_name, propertyTitle, agreementId, role: 'tenant' }).catch(() => {});
    if (t?.phone) sendSMS(t.phone, `PROPATI: Your tenancy agreement for ${propertyTitle} is ready to sign. Login at propati.ng`).catch(() => {});
    if (l?.email) sendEmail(l.email, `Agreement sent to tenant — ${propertyTitle}`,
      wrap(`<h2 style="color:#0B1220">📄 Agreement Sent</h2><p style="color:#4B5563">Hi ${l.full_name?.split(' ')[0]}, your tenancy agreement for <strong>${propertyTitle}</strong> has been sent to the tenant for e-signature.</p><a href="https://propati.ng" style="display:inline-block;background:#0B1220;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Track Status →</a>`)
    ).catch(() => {});
  } catch (e) { logger.error('notifyAgreementReady error', { error: e.message }); }
}

module.exports = {
  createNotification, sendEmail, sendSMS, sendTemplateEmail, wrap,
  notifyWelcome, notifyRentDue, notifyPaymentReceived, notifyEscrowReleased,
  notifyVerificationUpdate, notifyNewMessage, runRentReminders,
  notifyTeamInvite, notifyNewTicket, notifyTicketResolved, notifyAgreementReady,
};
