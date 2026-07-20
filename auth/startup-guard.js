// auth/startup-guard.js
// Pure startup secret validation, extracted so it can be unit-tested without
// importing index.js (which would start the server). Returns an array of
// human-readable errors (empty = OK).
import { getMasterKey } from "./integration-crypto.js";
import { resolveTwilioConfiguration } from "./runtime-config.js";

export function computeSecretErrors(env = process.env) {
  const errors = [];

  // JWT_SECRET: required, >= 32 chars, not a known-weak value.
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) errors.push("JWT_SECRET is not set.");
  else if (jwtSecret.length < 32) errors.push(`JWT_SECRET is too short (${jwtSecret.length} chars). Minimum 32 required.`);
  else if (["changeme", "secret", "password", "123456", "jwt_secret"].includes(jwtSecret.toLowerCase())) errors.push("JWT_SECRET is set to a known-weak value.");

  // ADMIN_TOKEN: required, >= 32 chars, not weak.
  const adminToken = env.ADMIN_TOKEN;
  if (!adminToken) errors.push("ADMIN_TOKEN is not set.");
  else if (adminToken.length < 32) errors.push(`ADMIN_TOKEN is too short (${adminToken.length} chars). Minimum 32 required.`);
  else if (["devtoken", "admin", "token", "secret"].includes(adminToken.toLowerCase())) errors.push("ADMIN_TOKEN is set to a known-weak value.");

  // Supabase + Groq: always required (never weakened).
  if (!env.SUPABASE_URL)         errors.push("SUPABASE_URL is not set.");
  if (!env.SUPABASE_SERVICE_KEY) errors.push("SUPABASE_SERVICE_KEY is not set.");
  if (!env.GROQ_API_KEY)         errors.push("GROQ_API_KEY is not set.");

  // INTEGRATIONS_ENCRYPTION_KEY: REQUIRED. Missing or wrong length (not exactly
  // 32 bytes) is a hard startup failure — otherwise stored integration secrets
  // could never be decrypted.
  if (!(env.INTEGRATIONS_ENCRYPTION_KEY || "").trim()) {
    errors.push("INTEGRATIONS_ENCRYPTION_KEY is not set (required to encrypt integration secrets).");
  } else {
    try { getMasterKey(env); }
    catch (e) { errors.push("INTEGRATIONS_ENCRYPTION_KEY is invalid: " + e.message); }
  }

  // TWILIO is OPTIONAL at startup. Credentials are managed per-tenant via the
  // encrypted DB connection (Admin → Apps → Twilio), so "disconnected",
  // "unconfigured" and "disabled" are all valid startup states.
  // resolveTwilioConfiguration only reports an error when TWILIO_ENABLED is
  // explicitly "true" with a partial/ambiguous config — a genuine misconfig.
  const tw = resolveTwilioConfiguration(env);
  for (const e of tw.errors) errors.push(e);

  return errors;
}
