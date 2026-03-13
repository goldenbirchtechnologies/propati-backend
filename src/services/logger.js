// src/services/logger.js — Winston structured logger
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// Custom format: timestamp + level + message + metadata
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Human-readable format for dev console
const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}] ${message}${extras}`;
  })
);

const transports = [];

// Console — always on in dev, errors-only in prod
if (process.env.NODE_ENV !== 'production') {
  transports.push(new winston.transports.Console({ format: devFormat }));
} else {
  transports.push(new winston.transports.Console({
    level: 'error',
    format: devFormat
  }));
}

// Rotating file — all logs, 14-day retention
transports.push(new DailyRotateFile({
  filename: path.join(logsDir, 'propati-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  maxSize: '20m',
  level: 'info',
  format: logFormat,
}));

// Separate error log
transports.push(new DailyRotateFile({
  filename: path.join(logsDir, 'errors-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '30d',
  level: 'error',
  format: logFormat,
}));

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transports,
  // Never crash on logging errors
  exitOnError: false,
});

// ── Specialised log helpers ────────────────────────────────

// Log API requests (called from Morgan stream)
logger.stream = {
  write: (message) => logger.http(message.trim())
};

// Log auth events (login, signup, KYC)
logger.auth = (event, userId, meta = {}) => {
  logger.info(`[AUTH] ${event}`, { userId, ...meta });
};

// Log payment events
logger.payment = (event, txnId, amount, meta = {}) => {
  logger.info(`[PAYMENT] ${event}`, { txnId, amount, ...meta });
};

// Log security events (suspicious activity, failed auth, rate limits)
logger.security = (event, ip, meta = {}) => {
  logger.warn(`[SECURITY] ${event}`, { ip, ...meta });
};

// Log verification workflow events
logger.verify = (event, listingId, layer, meta = {}) => {
  logger.info(`[VERIFY] ${event}`, { listingId, layer, ...meta });
};

// Log data access (admin actions, sensitive queries)
logger.audit = (action, adminId, target, meta = {}) => {
  logger.info(`[AUDIT] ${action}`, { adminId, target, ...meta });
};

module.exports = logger;
