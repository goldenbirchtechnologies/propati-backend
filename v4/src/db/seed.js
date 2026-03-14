// src/db/seed.js — Complete PROPATI demo seed
require('dotenv').config();
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('./index');
const { migrate } = require('./migrate');

const hash = (pw) => bcrypt.hash(pw, 10);

async function seed() {
  console.log('🌱 Seeding PROPATI database...');
  await migrate();

  // ── USERS ─────────────────────────────────────────────────
  const users = [
    { id:'usr_admin_001',   email:'admin@propati.ng',  phone:'08000000001', pw:'Admin1234!',  role:'admin',           full_name:'Emeka Okafor',   nin_verified:true, id_verified:true },
    { id:'usr_ll_001',      email:'chidi@propati.ng',  phone:'08012345678', pw:'Chidi1234!',  role:'landlord',        full_name:'Chidi Okonkwo',  nin_verified:true, id_verified:true },
    { id:'usr_ll_002',      email:'rita@propati.ng',   phone:'08033334444', pw:'Rita1234!',   role:'landlord',        full_name:'Rita Sule',      nin_verified:true, id_verified:true },
    { id:'usr_tenant_001',  email:'adaeze@propati.ng', phone:'08087654321', pw:'Adaeze1234!', role:'tenant',          full_name:'Adaeze Obi',    nin_verified:true, id_verified:true },
    { id:'usr_agent_001',   email:'akin@propati.ng',   phone:'08011112222', pw:'Akin1234!',   role:'agent',           full_name:'Akin Balogun',  nin_verified:true, id_verified:true, agent_tier:'senior', agent_approved:true, agent_bio:'Senior PROPATI agent. 14 deals closed.', agent_areas:JSON.stringify(['Lekki','Victoria Island','Ikoyi']) },
    { id:'usr_em_001',      email:'taiwo@propati.ng',  phone:'08055556666', pw:'Taiwo1234!',  role:'estate_manager',  full_name:'Taiwo Adeyemi', nin_verified:true, id_verified:true },
  ];

  for (const u of users) {
    const pw = await hash(u.pw);
    await query(`
      INSERT INTO users (id,email,phone,password,role,full_name,nin_verified,id_verified,agent_tier,agent_approved,agent_bio,agent_areas)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (email) DO UPDATE SET role=$5, full_name=$6
    `, [u.id, u.email, u.phone, pw, u.role, u.full_name,
        u.nin_verified||false, u.id_verified||false,
        u.agent_tier||'standard', u.agent_approved||false,
        u.agent_bio||null, u.agent_areas||null]);
  }
  console.log(`  ✓ ${users.length} users`);

  // ── LISTINGS ──────────────────────────────────────────────
  const listings = [
    { id:'lst_001', owner_id:'usr_ll_001', title:'4-Bed Duplex, Lekki Phase 1',           listing_type:'rent',     property_type:'duplex',    address:'12 Admiralty Way, Lekki Phase 1',    area:'Lekki Phase 1',     price:800000,   price_period:'year',  caution_deposit:800000, bedrooms:4, bathrooms:3, size_sqm:280, furnished:false, verification_tier:'certified', amenities:JSON.stringify(['Generator','Borehole','Security','CCTV','Swimming Pool']) },
    { id:'lst_002', owner_id:'usr_ll_001', title:'Luxury 3-Bed Serviced Apartment, VI',   listing_type:'short-let',property_type:'apartment', address:'45 Adeola Odeku St, Victoria Island', area:'Victoria Island',   price:85000,    price_period:'night', caution_deposit:170000, bedrooms:3, bathrooms:3, size_sqm:190, furnished:true,  verification_tier:'verified',  amenities:JSON.stringify(['Pool','Gym','Concierge','Generator','WiFi']) },
    { id:'lst_003', owner_id:'usr_ll_002', title:'5-Bed Detached House, Magodo GRA',       listing_type:'sale',     property_type:'house',     address:'7 Shangisha Road, Magodo Phase 2',   area:'Magodo Phase 2',    price:65000000, price_period:'total',         bedrooms:5, bathrooms:4, size_sqm:420, furnished:false, verification_tier:'certified', amenities:JSON.stringify(['Generator','Borehole','Security','Garden','BQ']) },
    { id:'lst_004', owner_id:'usr_ll_002', title:'2-Bed Flat, Surulere',                   listing_type:'rent',     property_type:'apartment', address:'18 Bode Thomas Street, Surulere',    area:'Surulere',          price:480000,   price_period:'year',  caution_deposit:480000, bedrooms:2, bathrooms:2, size_sqm:110, furnished:false, verification_tier:'verified',  amenities:JSON.stringify(['Security','Borehole','Generator']) },
    { id:'lst_005', owner_id:'usr_em_001', title:'3-Bed Flat, Ikeja GRA (Block A)',        listing_type:'rent',     property_type:'apartment', address:'5 Aromire Avenue, Ikeja GRA',        area:'Ikeja GRA',         price:600000,   price_period:'year',  caution_deposit:600000, bedrooms:3, bathrooms:2, size_sqm:135, furnished:false, verification_tier:'verified',  amenities:JSON.stringify(['Generator','Borehole','Security','Parking']) },
    { id:'lst_006', owner_id:'usr_em_001', title:'2-Bed Flat, Ikeja GRA (Block B)',        listing_type:'rent',     property_type:'apartment', address:'5 Aromire Avenue Block B, Ikeja GRA','area':'Ikeja GRA',      price:500000,   price_period:'year',  caution_deposit:500000, bedrooms:2, bathrooms:2, size_sqm:105, furnished:false, verification_tier:'certified', amenities:JSON.stringify(['Generator','Borehole','Security','Parking']) },
    { id:'lst_007', owner_id:'usr_em_001', title:'Studio, Ikeja GRA (Block C)',            listing_type:'rent',     property_type:'apartment', address:'5 Aromire Avenue Block C, Ikeja GRA','area':'Ikeja GRA',      price:300000,   price_period:'year',  caution_deposit:300000, bedrooms:1, bathrooms:1, size_sqm:55,  furnished:true,  verification_tier:'verified',  amenities:JSON.stringify(['Generator','Borehole','Security']) },
  ];

  for (const l of listings) {
    await query(`
      INSERT INTO listings (id,owner_id,title,listing_type,property_type,address,area,price,price_period,caution_deposit,bedrooms,bathrooms,size_sqm,furnished,status,verification_tier,amenities)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',$15,$16)
      ON CONFLICT (id) DO NOTHING
    `, [l.id,l.owner_id,l.title,l.listing_type,l.property_type,l.address,l.area,l.price,l.price_period,l.caution_deposit||null,l.bedrooms||null,l.bathrooms||null,l.size_sqm||null,l.furnished||false,l.verification_tier,l.amenities||null]);
  }
  console.log(`  ✓ ${listings.length} listings`);

  // ── VERIFICATIONS ─────────────────────────────────────────
  for (const l of listings) {
    const cert = l.verification_tier === 'certified';
    await query(`
      INSERT INTO verifications (id,listing_id,owner_id,l1_status,l2_status,l3_status,l4_status,l5_status,current_layer,overall_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (listing_id) DO NOTHING
    `, [uuidv4(), l.id, l.owner_id,
        'approved','approved',
        cert ? 'approved' : 'pending',
        cert ? 'completed' : 'pending',
        cert ? 'approved' : 'pending',
        cert ? 5 : 2,
        cert ? 'certified' : 'in_progress']);
  }
  console.log('  ✓ verifications');

  // ── AGREEMENT + RENT SCHEDULE ─────────────────────────────
  await query(`
    INSERT INTO agreements (id,listing_id,landlord_id,tenant_id,agent_id,type,status,start_date,end_date,rent_amount,rent_period,caution_deposit,landlord_signed_at,tenant_signed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
    ON CONFLICT (id) DO NOTHING
  `, ['agr_001','lst_004','usr_ll_002','usr_tenant_001','usr_agent_001','rental','fully_signed','2026-01-01','2026-12-31',480000,'yearly',480000]);

  await query(`
    INSERT INTO rent_schedule (id,agreement_id,due_date,amount,status) VALUES ($1,'agr_001','2026-01-01',480000,'paid')
    ON CONFLICT (id) DO NOTHING
  `, [uuidv4()]);

  await query(`
    INSERT INTO rent_schedule (id,agreement_id,due_date,amount,status) VALUES ($1,'agr_001','2026-04-01',480000,'upcoming')
    ON CONFLICT (id) DO NOTHING
  `, [uuidv4()]);
  console.log('  ✓ agreement + rent schedule');

  // ── TRANSACTION ───────────────────────────────────────────
  await query(`
    INSERT INTO transactions (id,reference,listing_id,payer_id,payee_id,agent_id,type,status,amount,platform_fee,agent_commission,payee_amount,description)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (id) DO NOTHING
  `, ['txn_001','PROPATI-2026-001','lst_004','usr_tenant_001','usr_ll_002','usr_agent_001','rent','released',480000,48000,48000,384000,'Annual rent — Surulere flat']);
  console.log('  ✓ transaction');

  // ── CONVERSATIONS + MESSAGES ──────────────────────────────
  await query(`
    INSERT INTO conversations (id,tenant_id,landlord_id,listing_id,subject,last_message,last_message_at,unread_tenant,unread_landlord,status)
    VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8,'active')
    ON CONFLICT (id) DO NOTHING
  `, ['cnv_001','usr_tenant_001','usr_ll_001','lst_001','Enquiry about Lekki duplex','Is the property still available?',1,0]);

  await query(`
    INSERT INTO messages (id,conversation_id,sender_id,content,is_read,created_at)
    VALUES
      ($1,'cnv_001','usr_tenant_001','Hi, I saw the 4-bed duplex listing on PROPATI. Is it still available for viewing?',TRUE,NOW()-INTERVAL '2 hours'),
      ($2,'cnv_001','usr_ll_001','Yes, it is! When would you like to come for a viewing? I am available weekday afternoons.',TRUE,NOW()-INTERVAL '1 hour'),
      ($3,'cnv_001','usr_tenant_001','Is the property still available?',FALSE,NOW())
    ON CONFLICT (id) DO NOTHING
  `, [uuidv4(), uuidv4(), uuidv4()]);
  console.log('  ✓ conversations + messages');

  // ── ORGANISATION (Estate Manager) ─────────────────────────
  await query(`
    INSERT INTO organisations (id,name,owner_id,billing_email,address,plan_tier,max_units,max_seats)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO NOTHING
  `, ['org_001','Cityscape Properties Ltd','usr_em_001','billing@cityscape.ng','32 Toyin Street, Ikeja, Lagos','growth',100,5]);

  await query(`
    INSERT INTO org_members (id,org_id,user_id,email,role,status,joined_at)
    VALUES ($1,$2,$3,$4,$5,'active',NOW())
    ON CONFLICT DO NOTHING
  `, [uuidv4(), 'org_001', 'usr_em_001', 'taiwo@propati.ng', 'manager']);

  // Link org listings
  for (const lid of ['lst_005','lst_006','lst_007']) {
    await query(`
      INSERT INTO org_listings (id,org_id,listing_id) VALUES ($1,'org_001',$2) ON CONFLICT DO NOTHING
    `, [uuidv4(), lid]);
  }
  console.log('  ✓ organisation + org_listings');

  // ── MAINTENANCE TICKETS ───────────────────────────────────
  const tickets = [
    { title:'Burst pipe under kitchen sink',      category:'plumbing',   priority:'urgent',  status:'open',      listing_id:'lst_005' },
    { title:'Generator not starting',             category:'electrical', priority:'high',    status:'assigned',  listing_id:'lst_006' },
    { title:'Leaking roof over bedroom 2',        category:'structural', priority:'high',    status:'in_progress',listing_id:'lst_005' },
    { title:'Security camera not recording',      category:'security',   priority:'medium',  status:'resolved',  listing_id:'lst_007' },
    { title:'Blocked toilet in bathroom 1',       category:'plumbing',   priority:'medium',  status:'open',      listing_id:'lst_006' },
  ];
  for (const t of tickets) {
    await query(`
      INSERT INTO maintenance_tickets (id,org_id,listing_id,raised_by,title,category,priority,status)
      VALUES ($1,'org_001',$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING
    `, [uuidv4(), t.listing_id, 'usr_em_001', t.title, t.category, t.priority, t.status]);
  }
  console.log('  ✓ maintenance tickets');

  // ── ORG SUBSCRIPTION ──────────────────────────────────────
  await query(`
    INSERT INTO org_subscriptions (id,org_id,plan,status,amount,current_period_start,current_period_end,next_billing_date)
    VALUES ($1,'org_001','growth','active',6000000,NOW(),NOW()+INTERVAL '30 days',NOW()+INTERVAL '30 days')
    ON CONFLICT DO NOTHING
  `, [uuidv4()]);
  console.log('  ✓ org subscription');

  console.log('\n🎉 Seed complete!\n');
  console.log('  Admin:           admin@propati.ng    / Admin1234!');
  console.log('  Landlord:        chidi@propati.ng    / Chidi1234!');
  console.log('  Tenant:          adaeze@propati.ng   / Adaeze1234!');
  console.log('  Agent:           akin@propati.ng     / Akin1234!');
  console.log('  Estate Manager:  taiwo@propati.ng    / Taiwo1234!');
  process.exit(0);
}

seed().catch(err => { console.error('Seed error:', err); process.exit(1); });
