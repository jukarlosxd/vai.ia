// Tests for auth/integration-crypto.js (AES-256-GCM integration-secret vault).
// Run: node tests/integration-crypto.test.mjs
import assert from "node:assert";
import crypto from "node:crypto";
import {
  getMasterKey, isEncryptionConfigured, encryptSecret, decryptSecret,
  maskSecret, maskAccountSid,
} from "../auth/integration-crypto.js";

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log("  ✓", name); pass++; } catch (e) { console.log("  ✗", name, "—", e.message); fail++; } }

const HEX_KEY = crypto.randomBytes(32).toString("hex");           // 64 hex chars
const B64_KEY = crypto.randomBytes(32).toString("base64");        // 32-byte base64
const envHex = { INTEGRATIONS_ENCRYPTION_KEY: HEX_KEY };
const envB64 = { INTEGRATIONS_ENCRYPTION_KEY: B64_KEY };

console.log("── integration-crypto (AES-256-GCM) ──");

t("getMasterKey accepts 64-hex and 32-byte base64 → 32-byte Buffer", () => {
  assert.equal(getMasterKey(envHex).length, 32);
  assert.equal(getMasterKey(envB64).length, 32);
});

t("getMasterKey fails closed on missing / short / invalid key", () => {
  assert.throws(() => getMasterKey({}));
  assert.throws(() => getMasterKey({ INTEGRATIONS_ENCRYPTION_KEY: "tooshort" }));
  assert.throws(() => getMasterKey({ INTEGRATIONS_ENCRYPTION_KEY: "zz".repeat(32) }));
});

t("isEncryptionConfigured reflects key validity", () => {
  assert.equal(isEncryptionConfigured(envHex), true);
  assert.equal(isEncryptionConfigured({}), false);
});

t("encrypt→decrypt round-trip returns the original secret", () => {
  const secret = "a1b2c3d4e5f6authtoken0000000000ZZ";
  const bundle = encryptSecret(secret, envHex);
  assert.match(bundle, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(decryptSecret(bundle, envHex), secret);
});

t("ciphertext is non-deterministic (random IV per encryption)", () => {
  const s = "same-secret";
  assert.notEqual(encryptSecret(s, envHex), encryptSecret(s, envHex));
});

t("decrypt with the WRONG key throws (fail-closed)", () => {
  const bundle = encryptSecret("token", envHex);
  assert.throws(() => decryptSecret(bundle, envB64));
});

t("tampered ciphertext fails the GCM auth tag → throws", () => {
  const bundle = encryptSecret("token-abc", envHex);
  const parts = bundle.split(".");
  // Flip a character in the ciphertext segment.
  const ct = parts[3];
  parts[3] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
  assert.throws(() => decryptSecret(parts.join("."), envHex));
});

t("malformed bundle / wrong version throws", () => {
  assert.throws(() => decryptSecret("not-a-bundle", envHex));
  assert.throws(() => decryptSecret("v2.a.b.c", envHex));
  assert.throws(() => decryptSecret("v1.only.three", envHex));
});

t("empty plaintext is rejected", () => {
  assert.throws(() => encryptSecret("", envHex));
});

t("maskSecret / maskAccountSid never reveal the full value", () => {
  assert.equal(maskSecret("supersecrettoken", 4), "••••oken");
  const sid = "AC" + "0".repeat(30) + "1234";
  const masked = maskAccountSid(sid);
  assert.ok(masked.startsWith("AC••••"));
  assert.ok(masked.endsWith("1234"));
  assert.ok(!masked.includes("0".repeat(10)), "middle of SID must be hidden");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
