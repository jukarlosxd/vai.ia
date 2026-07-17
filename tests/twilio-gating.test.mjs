// D3 — Twilio channel gating.
// This test imports and exercises the REAL function used by index.js
// (resolveTwilioConfiguration in auth/runtime-config.js). No logic is copied.
import assert from "node:assert";
import { resolveTwilioConfiguration } from "../auth/runtime-config.js";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "—", e.message); fail++; }
}

console.log("── D3 Twilio gating (real function) ──");

t("1. TWILIO_ENABLED=false sin credenciales → deshabilitado, server permitido", () => {
  const c = resolveTwilioConfiguration({ NODE_ENV: "production", TWILIO_ENABLED: "false" });
  assert.equal(c.enabled, false);
  assert.equal(c.valid, true);
  assert.deepEqual(c.errors, []);
});

t("2. variable no definida y cero credenciales → deshabilitado", () => {
  const c = resolveTwilioConfiguration({ NODE_ENV: "production" });
  assert.equal(c.enabled, false);
  assert.equal(c.valid, true);
});

t("3. variable no definida y config completa → habilitado", () => {
  const c = resolveTwilioConfiguration({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" });
  assert.equal(c.enabled, true);
  assert.equal(c.valid, true);
});

t("4. TWILIO_ENABLED=true y config incompleta → error", () => {
  const c = resolveTwilioConfiguration({ TWILIO_ENABLED: "true" });
  assert.equal(c.enabled, true);
  assert.equal(c.valid, false);
  assert.equal(c.errors.length, 2);
});

t("4b. TWILIO_ENABLED=true, falta solo el token → un error", () => {
  const c = resolveTwilioConfiguration({ TWILIO_ENABLED: "TRUE", TWILIO_ACCOUNT_SID: "AC1" });
  assert.equal(c.enabled, true);
  assert.equal(c.valid, false);
  assert.equal(c.errors.length, 1);
});

t("5. TWILIO_ENABLED=true y config completa → habilitado, válido", () => {
  const c = resolveTwilioConfiguration({ TWILIO_ENABLED: "true", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" });
  assert.equal(c.enabled, true);
  assert.equal(c.valid, true);
  assert.deepEqual(c.errors, []);
});

t("6. valor inválido 'yes' → inválido explícito (no adivina)", () => {
  const c = resolveTwilioConfiguration({ TWILIO_ENABLED: "yes", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" });
  assert.equal(c.enabled, false);
  assert.equal(c.valid, false);
  assert.equal(c.errors.length, 1);
});

t("6b. valor inválido '1abc' → inválido", () => {
  const c = resolveTwilioConfiguration({ TWILIO_ENABLED: "1abc" });
  assert.equal(c.valid, false);
});

t("6c. solo espacios → tratado como no definido (deduce de credenciales)", () => {
  const c = resolveTwilioConfiguration({ TWILIO_ENABLED: "   ", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" });
  assert.equal(c.enabled, true);
  assert.equal(c.valid, true);
});

t("6d. credencial en blanco no cuenta (sin placeholder)", () => {
  const c = resolveTwilioConfiguration({ TWILIO_ENABLED: "true", TWILIO_ACCOUNT_SID: "  ", TWILIO_AUTH_TOKEN: "" });
  assert.equal(c.valid, false);
  assert.equal(c.errors.length, 2);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
