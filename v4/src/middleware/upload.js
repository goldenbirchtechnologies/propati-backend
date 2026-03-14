// src/middleware/upload.js — Multer memory storage + Cloudinary v2 stream upload
// No multer-storage-cloudinary dependency needed
'use strict';
const multer    = require('multer');
const cloudinary = require('cloudinary').v2;
const logger    = require('../services/logger');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const FOLDER = process.env.CLOUDINARY_FOLDER || 'propati';
const maxFileMB  = parseInt(process.env.MAX_FILE_SIZE_MB  || '10');
const maxVideoMB = parseInt(process.env.MAX_VIDEO_SIZE_MB || '100');

function isCloudinaryConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    !process.env.CLOUDINARY_CLOUD_NAME.includes('your_cloud') &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

// ── File filters ───────────────────────────────────────────
const imageFilter = (req, file, cb) => {
  if (['image/jpeg','image/png','image/webp'].includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only JPEG, PNG, WebP images allowed'));
};
const docFilter = (req, file, cb) => {
  if (['application/pdf','image/jpeg','image/png'].includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only PDF, JPEG, PNG documents allowed'));
};
const videoFilter = (req, file, cb) => {
  if (['video/mp4','video/quicktime','video/webm'].includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only MP4, MOV, WebM videos allowed'));
};

// ── All uploads use memory storage ────────────────────────
// We stream the buffer to Cloudinary manually after multer parses the form
const uploadImages   = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxFileMB  * 1024 * 1024 }, fileFilter: imageFilter });
const uploadDocument = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxFileMB  * 1024 * 1024 }, fileFilter: docFilter  });
const uploadVideo    = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxVideoMB * 1024 * 1024 }, fileFilter: videoFilter });
const uploadAny      = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxFileMB  * 1024 * 1024 } });

// ── Upload a buffer to Cloudinary ─────────────────────────
// Returns { secure_url, public_id } or throws
function uploadToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    if (!isCloudinaryConfigured()) {
      // Dev fallback — return a placeholder URL
      logger.warn('Cloudinary not configured — returning placeholder URL');
      return resolve({
        secure_url: `https://via.placeholder.com/800x600?text=propati-dev`,
        public_id:  `dev-${Date.now()}`,
      });
    }

    const defaults = {
      folder:        `${FOLDER}/${options.subfolder || 'misc'}`,
      resource_type: options.resource_type || 'image',
      public_id:     `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    if (options.resource_type === 'image') {
      defaults.transformation = [{ quality: 'auto:good', fetch_format: 'auto' }];
    }

    const uploadOptions = { ...defaults, ...options };
    delete uploadOptions.subfolder; // not a cloudinary param

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (err, result) => {
      if (err) { logger.error('Cloudinary upload error', { error: err.message }); return reject(err); }
      resolve(result);
    });
    stream.end(buffer);
  });
}

// ── Delete a file from Cloudinary ─────────────────────────
async function deleteFile(publicId, resourceType = 'image') {
  if (!isCloudinaryConfigured() || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    logger.info('Cloudinary file deleted', { publicId });
  } catch (err) {
    logger.error('Failed to delete Cloudinary file', { publicId, error: err.message });
  }
}

// ── Get URL from uploaded file ─────────────────────────────
function getFileUrl(file) {
  if (!file) return null;
  if (file.path && file.path.startsWith('http')) return file.path;
  if (file.filename) return `/uploads/${file.filename}`;
  return null;
}

module.exports = {
  uploadImages,
  uploadDocument,
  uploadVideo,
  uploadAny,
  uploadToCloudinary,
  deleteFile,
  getFileUrl,
  isCloudinaryConfigured,
};
