// auth/integration-crypto.js
// Authenticated encryption (AES-256-GCM) for third-party integration secrets
// (e.g. the Twilio Auth Token). Secrets are NEVER stored in plaintext.
//
// KEY MANAGEMENT
//   * The 32-byte master key lives ONLY in the environment variable
//     INTEGRATIONS_ENCRYPTION_KEY (staging: .env.staging + Render env).
//   * Accepted encodings: 64 hex chars, or base64 / base64url that decodes to
//     exactly 32 bytes. Anything else is rejected (fail-closed).
//   * The key is NEVER persisted to the database, returned to the browser,
//     committed to git, or logged. It is NOT the JWT_SECRET.
//
// CIPHERTEXT FORMAT (self-describing, versioned):
//     v1.<iv_b64url>.<tag_b64url>.<ciphertext_b64url>
//   - iv: 12 random bytes (GCM nonce), unique per encryption
//   - tag: 16-byte GCM authentication tag (integrity/authenticity)
//   A decryption failure (wrong key, tampering, bad format) THROWS — callers
//   must treat that as "integration unavailable", never as empty/None.

import crypto from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;   // 96-bit nonce recommended for GCM
const TAG_LEN = 16;  // 128-bit auth tag
const VERSION = "v1";

// Parse & validate the master key into a 32-byte Buffer. Throws (fail-closed)
// if the env var is missing or not exactly 32 bytes.
export function getMasterKey(env = process.env) {
  const raw = (env.INTEGRATIONS_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    throw new Error("INTEGRATIONS_ENCRYPTION_KEY is not set (required to encrypt integration secrets).");
  }
  let buf = null;
  // Try hex first (64 chars), then base64 / base64url.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    try { buf = Buffer.from(raw, "base64"); } catch { buf = null; }
  }
  if (!buf || buf.length !== 32) {
    throw new Error("INTEGRATIONS_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or 32-byte base64).");
  }
  return buf;
}

// Returns true when a valid key is configured (no throw) — for health checks.
export function isEncryptionConfigured(env = process.env) {
  try { getMasterKey(env); return true; } catch { return false; }
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// Encrypt a UTF-8 string secret. Returns the self-describing bundle string.
export function encryptSecret(plaintext, env = process.env) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret: plaintext must be a non-empty string");
  }
  const key = getMasterKey(env);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${b64url(iv)}.${b64url(tag)}.${b64url(ct)}`;
}

// Decrypt a bundle produced by encryptSecret. Throws on any tamper/format/key
// error (fail-closed) — never returns partial or empty plaintext silently.
export function decryptSecret(bundle, env = process.env) {
  if (typeof bundle !== "string") throw new Error("decryptSecret: bundle must be a string");
  const parts = bundle.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("decryptSecret: unrecognized ciphertext format");
  }
  const key = getMasterKey(env);
  const iv = fromB64url(parts[1]);
  const tag = fromB64url(parts[2]);
  const ct = fromB64url(parts[3]);
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error("decryptSecret: invalid iv/tag length");
  }
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  // .final() throws if the GCM tag does not verify (tampering / wrong key).
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// Mask a secret for safe display (never the full value). Keeps only the last
// `visible` characters, e.g. maskSecret("AC0123...cdef") -> "••••cdef".
export function maskSecret(value, visible = 4) {
  const s = String(value || "");
  if (!s) return "";
  const tail = s.slice(-visible);
  return "••••" + tail;
}

// Convenience for a masked Account SID label like "AC••••1234".
export function maskAccountSid(sid) {
  const s = String(sid || "");
  if (s.length <= 6) return maskSecret(s);
  return s.slice(0, 2) + "••••" + s.slice(-4);
}
