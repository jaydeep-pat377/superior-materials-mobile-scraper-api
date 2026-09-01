/**
 * S3 Storage Client (with local filesystem fallback for development)
 *
 * When S3_BUCKET is configured -> uses AWS S3 (production).
 * When S3_BUCKET is NOT set    -> falls back to local file storage under
 *   public/uploads/ (development). Files are served via Express static middleware.
 *
 * Config (env):
 *   S3_BUCKET            - target bucket (required for S3 mode)
 *   S3_REGION            - bucket region (falls back to AWS_REGION / us-east-1)
 *   S3_PUBLIC_BASE_URL   - optional base for public URLs (e.g. a CloudFront domain)
 *   STORAGE_TIMEOUT_MS   - per-operation timeout (default 30000)
 */

let S3Client, PutObjectCommand, DeleteObjectCommand;
try {
  ({ S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
} catch (_) {
  // @aws-sdk/client-s3 is optional — local storage fallback will be used
}

const fs = require('fs');
const path = require('path');

const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1';
const S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL;
const STORAGE_TIMEOUT_MS = parseInt(process.env.STORAGE_TIMEOUT_MS) || 30000;

const SCRAPED_ORDERS_BUCKET = 'scraped-orders';
const AVATARS_BUCKET = 'avatars';
const CHAT_FILES_BUCKET = 'chat-files';

// Local uploads directory (used when S3 is not configured)
const LOCAL_UPLOADS_DIR = path.join(__dirname, '..', '..', '..', 'public', 'uploads');
const USE_LOCAL_STORAGE = !S3_BUCKET;

let s3 = null;
if (S3_BUCKET && S3Client) {
  s3 = new S3Client({ region: S3_REGION });
} else {
  // Create local uploads directory for development
  fs.mkdirSync(path.join(LOCAL_UPLOADS_DIR, AVATARS_BUCKET), { recursive: true });
  fs.mkdirSync(path.join(LOCAL_UPLOADS_DIR, SCRAPED_ORDERS_BUCKET), { recursive: true });
  fs.mkdirSync(path.join(LOCAL_UPLOADS_DIR, CHAT_FILES_BUCKET), { recursive: true });
  if (!S3_BUCKET) {
    console.warn('S3_BUCKET not configured - using local file storage (public/uploads/)');
  }
}

function localUrlFor(key) {
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}/uploads/${key}`;
}

function publicUrlFor(key) {
  if (S3_PUBLIC_BASE_URL) {
    return `${S3_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`;
  }
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

function withTimeout(promise, timeoutMs, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Upload JSON data (scraped-orders prefix).
 */
async function uploadToStorage(fileName, data, timeoutMs = STORAGE_TIMEOUT_MS) {
  const key = `${SCRAPED_ORDERS_BUCKET}/${fileName}`;

  if (USE_LOCAL_STORAGE) {
    const filePath = path.join(LOCAL_UPLOADS_DIR, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return { path: key, publicUrl: localUrlFor(key) };
  }

  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');

  try {
    await withTimeout(
      s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: 'application/json'
      })),
      timeoutMs,
      'Storage upload'
    );
  } catch (error) {
    if (error.message && error.message.includes('timeout')) {
      console.error(`S3 storage upload timed out after ${timeoutMs}ms`);
    }
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return { path: key, publicUrl: publicUrlFor(key) };
}

/**
 * Upload an avatar image (avatars prefix).
 */
async function uploadAvatarToStorage(userId, fileBuffer, mimeType, originalName) {
  const ext = originalName.split('.').pop().toLowerCase();
  const key = `${AVATARS_BUCKET}/${userId}/avatar_${Date.now()}.${ext}`;

  if (USE_LOCAL_STORAGE) {
    const filePath = path.join(LOCAL_UPLOADS_DIR, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, fileBuffer);
    return { path: key, publicUrl: localUrlFor(key) };
  }

  try {
    await withTimeout(
      s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType
      })),
      STORAGE_TIMEOUT_MS,
      'Avatar upload'
    );
  } catch (error) {
    throw new Error(`Avatar upload failed: ${error.message}`);
  }

  return { path: key, publicUrl: publicUrlFor(key) };
}

/**
 * Delete an avatar from S3 (or local filesystem).
 */
async function deleteAvatarFromStorage(filePath) {
  const key = filePath.startsWith(`${AVATARS_BUCKET}/`)
    ? filePath
    : `${AVATARS_BUCKET}/${filePath}`;

  if (USE_LOCAL_STORAGE) {
    try {
      const localPath = path.join(LOCAL_UPLOADS_DIR, key);
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } catch (error) {
      console.warn('Failed to delete local avatar:', error.message);
    }
    return;
  }

  try {
    await withTimeout(
      s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })),
      STORAGE_TIMEOUT_MS,
      'Avatar delete'
    );
  } catch (error) {
    console.warn('Failed to delete old avatar from S3:', error.message);
  }
}

/**
 * Upload a chat file (image/audio).
 */
async function uploadChatFile(orderId, fileBuffer, mimeType, originalName) {
  const ext = originalName.split('.').pop().toLowerCase();
  const key = `${CHAT_FILES_BUCKET}/${orderId}/${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;

  if (USE_LOCAL_STORAGE) {
    const filePath = path.join(LOCAL_UPLOADS_DIR, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, fileBuffer);
    return { path: key, publicUrl: localUrlFor(key) };
  }

  try {
    await withTimeout(
      s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType
      })),
      STORAGE_TIMEOUT_MS,
      'Chat file upload'
    );
  } catch (error) {
    throw new Error(`Chat file upload failed: ${error.message}`);
  }

  return { path: key, publicUrl: publicUrlFor(key) };
}

module.exports = {
  s3,
  SCRAPED_ORDERS_BUCKET,
  AVATARS_BUCKET,
  CHAT_FILES_BUCKET,
  uploadToStorage,
  uploadAvatarToStorage,
  deleteAvatarFromStorage,
  uploadChatFile,
  STORAGE_TIMEOUT_MS
};
