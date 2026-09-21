/**
 * Application-level encryption for data at rest.
 *
 * Everything sensitive the app persists (chat titles, message bodies, digest
 * payloads, daily summaries, ingest-token labels, usernames, rate-limit keys)
 * is encrypted before it is written and decrypted after it is read. A stolen
 * database file or a Turso dump therefore reveals only opaque ciphertext.
 *
 * This is deliberately a plain `.mjs` module -- like digestCore.mjs -- so the
 * same byte-for-byte implementation is shared by the Next.js app (through
 * src/lib/queries.ts) and the standalone box-side worker
 * (scripts/digest-worker.mjs). Do NOT make this depend on `server-only` or any
 * Next.js import.
 *
 * Key management:
 *   ENCRYPTION_KEY  base64 (or 64-char hex) 32-byte key. This is the key that
 *                   protects all data at rest. It must be identical on Vercel
 *                   and on the box (the worker) or the two will not be able to
 *                   read each other's rows.
 *   Fallback: when ENCRYPTION_KEY is unset, a key is derived from
 *   SESSION_SECRET with scrypt so existing deployments keep working. Set a
 *   dedicated ENCRYPTION_KEY in production -- and never change it, or all
 *   previously encrypted data becomes unreadable.
 *
 * Two sealing modes are used:
 *   encrypt()             random 12-byte IV, AES-256-GCM. Non-deterministic,
 *                         so identical plaintexts produce different ciphertext.
 *                         Used for free-text content.
 *   encryptDeterministic() fixed IV derived from HMAC(key, plaintext). Same
 *                         plaintext always yields the same ciphertext, which is
 *                         required for columns that are looked up or deduped by
 *                         equality (usernames, external ids, rate-limit keys).
 *                         It leaks equality only, which is inherent to the
 *                         lookup; the plaintext itself stays hidden.
 *
 * Both modes are authenticated (GCM tag): tampering with a stored value makes
 * decryption throw rather than silently returning corrupt data.
 */
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const RANDOM_PREFIX = 'enc:v1:';
const DETERMINISTIC_PREFIX = 'encd:v1:';
const KEY_SALT = 'bleep-ai-db-encryption-v1';

/** @type {Buffer | null} */
let cachedKey = null;

function resolveKey() {
  const raw = (process.env.ENCRYPTION_KEY || '').trim();
  if (raw) {
    let key;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      key = Buffer.from(raw, 'hex');
    } else {
      key = Buffer.from(raw, 'base64');
    }
    if (key.length !== KEY_BYTES) {
      throw new Error(
        'ENCRYPTION_KEY must be a 32-byte key encoded as base64 or 64-char hex'
      );
    }
    return key;
  }

  const secret = (process.env.SESSION_SECRET || '').trim();
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ENCRYPTION_KEY is required in production (or set SESSION_SECRET to derive one)'
      );
    }
    return crypto.scryptSync('dev-insecure-secret-change-me', KEY_SALT, KEY_BYTES);
  }

  if (!resolveKey.warned) {
    resolveKey.warned = true;
    console.warn(
      '[crypto] ENCRYPTION_KEY is not set; deriving a key from SESSION_SECRET. ' +
        'Set a dedicated ENCRYPTION_KEY for production.'
    );
  }
  return crypto.scryptSync(secret, KEY_SALT, KEY_BYTES);
}

function getKey() {
  if (!cachedKey) cachedKey = resolveKey();
  return cachedKey;
}

/**
 * AES-256-GCM seal with an explicit IV. Returns base64(iv || tag || ciphertext).
 * @param {string} plaintext
 * @param {Buffer} iv
 * @returns {string}
 */
function seal(plaintext, iv) {
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * @param {string} b64
 * @returns {string}
 */
function open(b64) {
  const data = Buffer.from(b64, 'base64');
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = data.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8'
  );
}

/**
 * Encrypt free-text content with a random IV. Empty strings pass through
 * unchanged so absent values stay NULL/empty in the database.
 * @param {string} value
 * @returns {string}
 */
export function encrypt(value) {
  if (value === null || value === undefined || value === '') {
    return /** @type {string} */ (value);
  }
  return RANDOM_PREFIX + seal(String(value), crypto.randomBytes(IV_BYTES));
}

/**
 * Deterministically encrypt a value that must remain equality-searchable.
 * @param {string | null | undefined} value
 * @returns {string | null | undefined}
 */
export function encryptDeterministic(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (text === '') return '';
  const iv = crypto
    .createHmac('sha256', getKey())
    .update(DETERMINISTIC_PREFIX + text)
    .digest()
    .subarray(0, IV_BYTES);
  return DETERMINISTIC_PREFIX + seal(text, iv);
}

/**
 * Decrypt a value produced by encrypt() or encryptDeterministic(). Values that
 * carry neither prefix are returned untouched, which keeps rows written before
 * encryption was introduced (legacy plaintext) readable.
 * @param {string | null | undefined} value
 * @returns {string | null | undefined}
 */
export function decrypt(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (text.startsWith(RANDOM_PREFIX)) {
    return open(text.slice(RANDOM_PREFIX.length));
  }
  if (text.startsWith(DETERMINISTIC_PREFIX)) {
    return open(text.slice(DETERMINISTIC_PREFIX.length));
  }
  return text;
}

/**
 * True when a stored value is already encrypted by this module.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEncrypted(value) {
  if (value === null || value === undefined) return false;
  const text = String(value);
  return (
    text.startsWith(RANDOM_PREFIX) || text.startsWith(DETERMINISTIC_PREFIX)
  );
}

/**
 * Normalize a username the same way everywhere so deterministic lookups match:
 * trimmed and lowercased.
 * @param {string} username
 * @returns {string}
 */
export function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

/**
 * The sealed form of a username, used for the UNIQUE lookup column. Encrypting
 * the normalized form keeps login case-insensitive while hiding the name.
 * @param {string} username
 * @returns {string}
 */
export function sealUsername(username) {
  return /** @type {string} */ (encryptDeterministic(normalizeUsername(username)));
}
