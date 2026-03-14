// src/index.js — PROPATI Backend v2.1 — all routes mounted
require('dotenv').config();
const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const morgan        = require('morgan');
const rateLimit     = require('express-rate-limit');
const slowDown      = require('express-slow-down');
const compression   = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const hpp           = require('hpp');
const path          = require('path');
const logger        = require('./services/logger');
const { migrate }   = require('./db/migrate');
const { checkConnection } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

(async () => {
  try { await migrate(); logger.info('✅ Database ready'); }
  catch (err) {
    logger.error('❌ DB startup failed', { error: err.message });
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }
})();

// ── PAYSTACK WEBHOOK — raw body BEFORE express.json ───────
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc:["'self'"], scriptSrc:["'self'"], styleSrc:["'self'","'unsafe-inline'"], imgSrc:["'self'",'data:','https://res.cloudinary.com'], connectSrc:["'self'"], frameAncestors:["'none'"] } },
  crossOriginResourcePolicy: { policy: 'cross-origin' }, noSniff: true, frameguard: { action: 'deny' },
  hsts: process.env.NODE_ENV==='production' ? { maxAge:31536000, includeSubDomains:true, preload:true } : false,
}));

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_URL_2,
  'https://propati-frontend.vercel.app',
  'http://localhost:5500',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000',
].filter(Boolean);

app.use(cors({
  origin: true, // allow all origins — tighten after launch
  credentials: true, methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-ID'],
}));

const globalLimit = rateLimit({ windowMs:15*60*1000, max:parseInt(process.env.RATE_LIMIT_MAX)||300, standardHeaders:true, legacyHeaders:false, message:{success:false,error:'Too many requests.'} });
const authLimit   = rateLimit({ windowMs:15*60*1000, max:parseInt(process.env.AUTH_RATE_LIMIT_MAX)||10, skipSuccessfulRequests:true, message:{success:false,error:'Too many failed attempts. Locked 15 mins.'} });
const speedLimiter= slowDown({ windowMs:15*60*1000, delayAfter:50, delayMs:(used)=>(used-50)*100 });

app.use('/api', globalLimit);
app.use('/api', speedLimiter);
app.use('/api/auth/login',  authLimit);
app.use('/api/auth/signup', authLimit);
app.use(hpp({ whitelist:['type','area','state','sort'] }));
app.use(mongoSanitize());
app.use(compression());
app.use(express.json({ limit:'10mb' }));
app.use(express.urlencoded({ extended:true, limit:'10mb' }));
app.use((req,res,next) => { req.id = req.headers['x-request-id']||require('uuid').v4().slice(0,8); res.setHeader('X-Request-ID',req.id); next(); });
app.use(morgan(process.env.NODE_ENV==='production'?':remote-addr :method :url :status :res[content-length] - :response-time ms':'dev',{stream:logger.stream}));
if (process.env.NODE_ENV!=='production') app.use('/uploads', express.static(path.join(process.cwd(),'uploads')));

app.get('/health', async (req,res) => {
  const dbOk = await checkConnection().catch(()=>false);
  res.status(dbOk?200:503).json({ status:dbOk?'healthy':'degraded', service:'PROPATI API', version:'2.1.0', environment:process.env.NODE_ENV||'development', database:dbOk?'connected':'disconnected', storage:process.env.CLOUDINARY_CLOUD_NAME?'cloudinary':'local', timestamp:new Date().toISOString() });
});

// ═══════════════ ALL API ROUTES ═══════════════════════════
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/listings',     require('./routes/listings'));
app.use('/api/verification', require('./routes/verification'));
app.use('/api/payments',     require('./routes/payments'));
app.use('/api/agreements',   require('./routes/agreements'));
app.use('/api/users',        require('./routes/users'));
app.use('/api/messages',     require('./routes/messages'));   // ← messaging
app.use('/api/orgs',         require('./routes/orgs'));       // ← estate manager B2B

// ═══════════════ CRON JOBS ════════════════════════════════
const { runRentReminders } = require('./services/notifications');
function scheduleDailyCron(fn, label, hourUTC = 7) {
  const msUntil = () => { const now=new Date(); const next=new Date(now); next.setUTCHours(hourUTC,0,0,0); if(next<=now) next.setUTCDate(next.getUTCDate()+1); return next-now; };
  const go = () => { setTimeout(async()=>{ logger.info(`⏰ Cron: ${label}`); await fn().catch(e=>logger.error(`Cron ${label}`,{error:e.message})); go(); }, msUntil()); };
  go(); logger.info(`📅 Cron: ${label} @ ${hourUTC}:00 UTC daily`);
}
if (process.env.NODE_ENV !== 'test') scheduleDailyCron(runRentReminders, 'Rent reminders', 7);

app.use((req,res) => res.status(404).json({ success:false, error:`Route ${req.method} ${req.path} not found` }));
app.use((err,req,res,next) => {
  logger.error('Unhandled error',{requestId:req.id,method:req.method,path:req.path,error:err.message});
  if (err.message==='Not allowed by CORS') return res.status(403).json({success:false,error:'CORS: Origin not allowed'});
  if (err.name==='MulterError') { if(err.code==='LIMIT_FILE_SIZE') return res.status(413).json({success:false,error:`File too large. Max ${process.env.MAX_FILE_SIZE_MB||10}MB`}); return res.status(400).json({success:false,error:err.message}); }
  res.status(err.status||500).json({ success:false, error:process.env.NODE_ENV==='production'?'Something went wrong.':err.message, requestId:req.id });
});

app.listen(PORT, () => logger.info(`🚀 PROPATI API v2.1`, { port:PORT, env:process.env.NODE_ENV||'development' }));
process.on('SIGTERM', () => { logger.info('SIGTERM — shutting down'); process.exit(0); });
process.on('unhandledRejection', (r) => logger.error('Unhandled rejection',{reason:String(r)}));
process.on('uncaughtException', (e) => { logger.error('Uncaught exception',{error:e.message,stack:e.stack}); process.exit(1); });

module.exports = app;
