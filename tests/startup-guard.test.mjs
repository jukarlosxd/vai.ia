// Tests for auth/startup-guard.js computeSecretErrors().
// Run: node tests/startup-guard.test.mjs
import assert from "node:assert";
import crypto from "node:crypto";
import { computeSecretErrors } from "../auth/startup-guard.js";

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log("  ✓", name); pass++; } catch (e) { console.log("  ✗", name, "—", e.message); fail++; } }

const KEY = crypto.randomBytes(32).toString("hex");
const base = () => ({
  JWT_SECRET: "x".repeat(40),
  ADMIN_TOKEN: "y".repeat(40),
  SUPABASE_URL: "https://ref.supabase.co",
  SUPABASE_SERVICE_KEY: "svc",
  GROQ_API_KEY: "gsk_test",
  INTEGRATIONS_ENCRYPTION_KEY: KEY,
});
const has = (errs, needle) => errs.some(e => e.toLowerCase().includes(needle.toLowerCase()));

console.log("── startup-guard ──");

t("valid env (32-byte key, no Twilio) → no errors; app starts", () => {
  assert.deepEqual(computeSecretErrors(base()), []);
});

t("INTEGRATIONS_ENCRYPTION_KEY missing → startup fails", () => {
  const e = base(); delete e.INTEGRATIONS_ENCRYPTION_KEY;
  assert.ok(has(computeSecretErrors(e), "INTEGRATIONS_ENCRYPTION_KEY is not set"));
});

t("INTEGRATIONS_ENCRYPTION_KEY too short/invalid → startup fails", () => {
  assert.ok(has(computeSecretErrors({ ...base(), INTEGRATIONS_ENCRYPTION_KEY: "tooshort" }), "invalid"));
});

t("Twilio env ABSENT → no Twilio error (optional)", () => {
  const errs = computeSecretErrors(base());
  assert.ok(!errs.some(e => /twilio/i.test(e)));
});

t("Twilio env PRESENT + complete (enabled) → no error", () => {
  const errs = computeSecretErrors({ ...base(), TWILIO_ENABLED: "true", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" });
  assert.ok(!errs.some(e => /twilio/i.test(e)), errs.join("|"));
});

t("Twilio enabled but PARTIAL → a Twilio error is reported (genuine misconfig)", () => {
  const errs = computeSecretErrors({ ...base(), TWILIO_ENABLED: "true", TWILIO_ACCOUNT_SID: "AC1" });
  assert.ok(errs.some(e => /twilio/i.test(e)));
});

t("app can start with NO Twilio integration connected (only ENC key needed)", () => {
  // No TWILIO_* at all, ENC key present → clean start.
  assert.deepEqual(computeSecretErrors(base()), []);
});

t("core secrets never weakened: missing JWT / SUPABASE / GROQ all reported", () => {
  const e = base(); delete e.JWT_SECRET; delete e.SUPABASE_SERVICE_KEY; delete e.GROQ_API_KEY;
  const errs = computeSecretErrors(e);
  assert.ok(has(errs, "JWT_SECRET") && has(errs, "SUPABASE_SERVICE_KEY") && has(errs, "GROQ_API_KEY"));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
