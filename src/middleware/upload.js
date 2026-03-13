// src/middleware/upload.js — Cloudinary cloud storage (replaces local disk)
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const logger = require('../services/logger');

// Configure Cloudinary
cloudinary.config({
  cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
  api_key:     process.env.CLOUDINARY_API_KEY,
  api_secret:  process.env.CLOUDINARY_API_SECRET,
});

const FOLDER = process.env.CLOUDINARY_FOLDER || 'propati';

// ── Check if Cloudinary is configured ─────────────────────
function isCloudinaryConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    !process.env.CLOUDINARY_CLOUD_NAME.includes('your_cloud') &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

// ── Cloudinary storage factories ──────────────────────────
function makeCloudinaryStorage(subfolder, allowedFormats, resourceType = 'image') {
  return new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
      folder:       `${FOLDER}/${subfolder}`,
      allowed_formats: allowedFormats,
      resource_type: resourceType,
      // Generate a clean filename
      public_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // Auto quality and format optimization
      transformation: resourceType === 'image'
        ? [{ quality: 'auto:good', fetch_format: 'auto' }]
        : undefined,
    }),
  });
}

// ── Fallback: memory storage for dev without Cloudinary ───
const memoryStorage = multer.memoryStorage();

// ── File filter factories ─────────────────────────────────
const imageFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only JPEG, PNG, WebP images allowed'));
};

const docFilter = (req, file, cb) => {
  const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only PDF, JPEG, PNG documents allowed'));
};

const videoFilter = (req, file, cb) => {
  const allowed = ['video/mp4', 'video/quicktime', 'video/webm'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only MP4, MOV, WebM videos allowed'));
};

const maxFileMB = parseInt(process.env.MAX_FILE_SIZE_MB || '10');
const maxVideoMB = parseInt(process.env.MAX_VIDEO_SIZE_MB || '100');

// ── Export multer instances ────────────────────────────────
let uploadImages, uploadDocument, uploadVideo;

if (isCloudinaryConfigured()) {
  logger.info('☁️  Cloudinary storage configured');

  uploadImages = multer({
    storage: makeCloudinaryStorage('images', ['jpg', 'png', 'webp'], 'image'),
    limits: { fileSize: maxFileMB * 1024 * 1024 },
    fileFilter: imageFilter,
  });

  uploadDocument = multer({
    storage: makeCloudinaryStorage('documents', ['pdf', 'jpg', 'png'], 'raw'),
    limits: { fileSize: maxFileMB * 1024 * 1024 },
    fileFilter: docFilter,
  });

  uploadVideo = multer({
    storage: makeCloudinaryStorage('videos', ['mp4', 'mov', 'webm'], 'video'),
    limits: { fileSize: maxVideoMB * 1024 * 1024 },
    fileFilter: videoFilter,
  });
} else {
  logger.warn('⚠️  Cloudinary not configured — using memory storage (dev mode). Files will NOT persist across restarts.');

  const fallback = (filter, sizeMB) => multer({
    storage: memoryStorage,
    limits: { fileSize: sizeMB * 1024 * 1024 },
    fileFilter: filter,
  });

  uploadImages   = fallback(imageFilter, maxFileMB);
  uploadDocument = fallback(docFilter, maxFileMB);
  uploadVideo    = fallback(videoFilter, maxVideoMB);
}

// ── Helper: delete a file from Cloudinary ─────────────────
async function deleteFile(publicId, resourceType = 'image') {
  if (!isCloudinaryConfigured() || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    logger.info('Cloudinary file deleted', { publicId });
  } catch (err) {
    logger.error('Failed to delete Cloudinary file', { publicId, error: err.message });
  }
}

// ── Helper: get URL from uploaded file (works for both modes) ──
function getFileUrl(file) {
  if (!file) return null;
  // Cloudinary upload — path contains the secure URL
  if (file.path && file.path.startsWith('http')) return file.path;
  // Multer local/memory — construct URL
  if (file.filename) return `/uploads/${file.filename}`;
  return null;
}

function getPublicId(file) {
  if (!file) return null;
  return file.filename || null; // Cloudinary sets this as the public_id
}

module.exports = {
  uploadImages,
  uploadDocument,
  uploadVideo,
  deleteFile,
  getFileUrl,
  getPublicId,
  isCloudinaryConfigured,
};
