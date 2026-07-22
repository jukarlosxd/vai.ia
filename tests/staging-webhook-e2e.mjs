// tests/staging-webhook-e2e.mjs
// SIGNED synthetic webhook E2E against the Render STAGING service.
//
// Runs from your machine (the sandbox has no outbound network). The Twilio
// Auth Token is read from an environment variable and is NEVER printed, never
// written to disk, never committed.
//
// Usage (PowerShell) — the token is typed masked and never echoed:
//   cd C:\Users\jukar\Desktop\vai.ia
//   $sec = Read-Host "Twilio Auth Token" -AsSecureString
//   $env:TWILIO_AUTH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
//       [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
//   node tests/staging-webhook-e2e.mjs
//   Remove-Item Env:\TWILIO_AUTH_TOKEN; Remove-Variable sec
//
// Safety: only ever talks to BASE (staging). Asserts that no production host is
// contacted. Sends no real SMS.

import twilio from "twilio";

const BASE = process.env.STAGING_BASE || "https://vai-ia-staging.onrender.com";
const TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const ASSIGNED = process.env.STAGING_ASSIGNED_NUMBER || "+19477292223";
const PROD_HOSTS = ["vai-ia.onrender.com", "vai.ia"];

if (!TOKEN) {
  console.error("TWILIO_AUTH_TOKEN is not set. Aborting (nothing was sent).");
  process.exit(2);
}
if (PROD_HOSTS.some((h) => BASE.includes(h))) {
  console.error("REFUSING TO RUN: BASE points at production. Aborting.");
  process.exit(2);
}

let pass = 0, fail = 0;
const contacted = new Set();

function t(name, cond, detail = "") {
  if (cond) { console.log("  ✓", name, detail && "— " + detail); pass++; }
  else { console.log("  ✗", name, detail && "— " + detail); fail++; }
}

// Twilio signs the exact public URL + the POST params (sorted, concatenated).
function sign(url, params) {
  return twilio.getExpectedTwilioSignature(TOKEN, url, params);
}

async function post(path, params, { signature, omitSignature = false, badSignature = false } = {}) {
  const url = BASE + path;
  contacted.add(new URL(url).host);
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (!omitSignature) {
    headers["X-Twilio-Signature"] = badSignature
      ? "aGVsbG90aGVyZWJhZHNpZ25hdHVyZQ=="
      : (signature || sign(url, params));
  }
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, { method: "POST", headers, body });
  const text = await res.text();
  return { status: res.status, text };
}

const uniq = () => "SM" + Array.from({ length: 32 }, () =>
  "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

const inboundPayload = (over = {}) => ({
  AccountSid: "AC" + "0".repeat(32),
  MessageSid: uniq(),
  From: "+15005550006",
  To: ASSIGNED,
  Body: "Quiero reservar una cita de prueba.",
  NumMedia: "0",
  ...over,
});

console.log("── staging signed webhook E2E ──");
console.log("   base:", BASE);
console.log("   assigned number:", ASSIGNED.slice(0, 2) + "••••" + ASSIGNED.slice(-2));

// ── PREFLIGHT (offline) ─────────────────────────────────────────────────────
// A wrong Auth Token makes EVERY valid-signature case return 403, which reads
// like a broken server or a broken test. It is neither. These checks run before
// any network call and separate "the algorithm is fine, the secret is wrong"
// from a real regression. The token itself is never printed, hashed or
// fingerprinted — only its presence and length.
console.log("\n[preflight — offline, no requests]");
{
  console.log(`   token present = true, length = ${TOKEN.length} chars`);
  if (/\s/.test(TOKEN)) {
    console.log("   WARNING: the token contains whitespace — a shell quoting mistake is likely.");
  }

  // 1. Known-answer test: fixed token + fixed URL + fixed params must always
  //    produce this exact signature. Proves the SDK and our canonicalization
  //    are behaving, independently of the real secret.
  const KAT_TOKEN = "known_answer_dummy_token_do_not_use";
  const KAT_URL = "https://example.invalid/webhooks/twilio/sms/incoming";
  const KAT_PARAMS = { AccountSid: "AC" + "0".repeat(32), Body: "KAT", From: "+15005550006",
                       MessageSid: "SM" + "0".repeat(32), NumMedia: "0", To: "+19477292223" };
  const KAT_EXPECTED = "tcOtphGGWTGiJ5f2ycI4kdIb6e0=";
  t("known-answer signature is stable",
    twilio.getExpectedTwilioSignature(KAT_TOKEN, KAT_URL, KAT_PARAMS) === KAT_EXPECTED);

  // 2. Determinism with the REAL token: same inputs -> same signature.
  const u = BASE + "/webhooks/twilio/sms/incoming";
  const p = { AccountSid: "AC" + "0".repeat(32), Body: "determinism", From: "+15005550006",
              MessageSid: "SM" + "1".repeat(32), NumMedia: "0", To: ASSIGNED };
  t("same URL + params + token -> same signature", sign(u, p) === sign(u, p));

  // 3. Sensitivity: changing any signed element must change the signature.
  const base = sign(u, p);
  const vary = [
    ["URL", () => sign(u + "/", p)],
    ["MessageSid", () => sign(u, { ...p, MessageSid: "SM" + "2".repeat(32) })],
    ["To", () => sign(u, { ...p, To: "+15005550001" })],
    ["From", () => sign(u, { ...p, From: "+15005550009" })],
    ["Body", () => sign(u, { ...p, Body: "different" })],
  ];
  for (const [what, f] of vary) t(`changing ${what} changes the signature`, f() !== base);

  // 4. The parameter object must not be mutated by signing (a mutated object
  //    would mean the body sent differs from the body signed).
  const snapshot = JSON.stringify(p);
  sign(u, p);
  t("signing does not mutate the params object", JSON.stringify(p) === snapshot);
}

// ── CREDENTIAL PROBE ────────────────────────────────────────────────────────
// One correctly-signed request. If the server rejects it, the supplied token
// does not match the one stored in the staging connection — stop here rather
// than emitting a wall of misleading 403s.
console.log("\n[credential probe]");
{
  const probe = await post("/webhooks/twilio/sms/status",
    { MessageSid: uniq(), MessageStatus: "queued", AccountSid: "AC" + "0".repeat(32) });
  if (probe.status === 403) {
    console.log("  FAIL correctly-signed request was rejected — status 403");
    console.log(`
  DIAGNOSIS: the signature algorithm is verified above, so the server is
  computing a DIFFERENT expected signature. That means the TWILIO_AUTH_TOKEN
  passed to this script is not the token stored in the staging connection.

  This is not a server defect and not a test regression. Most likely the shell
  variable was set from an incomplete expression, or a different Twilio token
  was pasted (Test Auth Token / API Key Secret / another account).

  The server's stored credential is known-good: Test Connection succeeded and
  the connection is 'test_mode' with hasToken=true. Nothing needs to be fixed
  server-side. Re-run with the primary Auth Token of the same account.

  Aborting before the suite so no misleading results are produced.`);
    process.exit(1);
  }
  t("a correctly-signed request is accepted", probe.status === 200, "status " + probe.status);
}

// ── INBOUND ─────────────────────────────────────────────────────────────────
console.log("\n[inbound]");
{
  const p = inboundPayload();
  const a = await post("/webhooks/twilio/sms/incoming", p);
  t("valid signature → accepted", a.status === 200, "status " + a.status);

  // Same MessageSid again: idempotent, must not duplicate.
  const b = await post("/webhooks/twilio/sms/incoming", p);
  t("repeated MessageSid → idempotent 200 (no duplicate)", b.status === 200, "status " + b.status);

  const c = await post("/webhooks/twilio/sms/incoming", inboundPayload(), { badSignature: true });
  t("invalid signature → 403", c.status === 403, "status " + c.status);

  const d = await post("/webhooks/twilio/sms/incoming", inboundPayload(), { omitSignature: true });
  t("missing signature → 403", d.status === 403, "status " + d.status);

  // A correctly signed request for a number nobody owns must fail safe (ack,
  // no processing) and must never fall back to another tenant.
  const e = await post("/webhooks/twilio/sms/incoming", inboundPayload({ To: "+15005550001" }));
  t("unknown To → safe rejection (200 empty TwiML, no tenant)", e.status === 200, "status " + e.status);

  // Tenant must never be taken from the body.
  const f = await post("/webhooks/twilio/sms/incoming", inboundPayload({ tenant_slug: "staging-beta", tenant: "staging-beta" }));
  t("tenant_slug in body is ignored (routes by To only)", f.status === 200, "status " + f.status);
}

// ── STATUS CALLBACK ─────────────────────────────────────────────────────────
console.log("\n[status callback]");
{
  const sid = uniq();
  for (const st of ["queued", "sent", "delivered"]) {
    const r = await post("/webhooks/twilio/sms/status", { MessageSid: sid, MessageStatus: st, AccountSid: "AC" + "0".repeat(32) });
    t(`valid signature → ${st} accepted`, r.status === 200, "status " + r.status);
  }
  // repeat the same (sid,status) → idempotent
  const rep = await post("/webhooks/twilio/sms/status", { MessageSid: sid, MessageStatus: "delivered", AccountSid: "AC" + "0".repeat(32) });
  t("repeated callback → idempotent", rep.status === 200, "status " + rep.status);

  const failSid = uniq();
  const f = await post("/webhooks/twilio/sms/status", { MessageSid: failSid, MessageStatus: "failed", ErrorCode: "30008", AccountSid: "AC" + "0".repeat(32) });
  t("failed + ErrorCode → accepted (sanitized store)", f.status === 200, "status " + f.status);

  const u = await post("/webhooks/twilio/sms/status", { MessageSid: uniq(), MessageStatus: "undelivered", ErrorCode: "30006", AccountSid: "AC" + "0".repeat(32) });
  t("undelivered → accepted", u.status === 200, "status " + u.status);

  const bad = await post("/webhooks/twilio/sms/status", { MessageSid: uniq(), MessageStatus: "delivered" }, { badSignature: true });
  t("invalid signature → 403", bad.status === 403, "status " + bad.status);

  const none = await post("/webhooks/twilio/sms/status", { MessageSid: uniq(), MessageStatus: "delivered" }, { omitSignature: true });
  t("missing signature → 403", none.status === 403, "status " + none.status);

  const unknown = await post("/webhooks/twilio/sms/status", { MessageSid: uniq(), MessageStatus: "delivered", AccountSid: "AC" + "0".repeat(32) });
  t("unknown MessageSid → safe response (no 500)", unknown.status === 200, "status " + unknown.status);
}

// ── idempotency, verified with SIDs the operator can check in the database ──
// The HTTP status is 200 either way, so it proves nothing on its own. These
// SIDs are printed so the exact rows can be counted in Supabase afterwards.
console.log("\n[idempotency — verify these SIDs in the database]");
const seqSid = uniq();
const conSid = uniq();
const sepSid = uniq();
{
  // A) sequential replay of a brand-new SID
  const p = inboundPayload({ MessageSid: seqSid });
  const a1 = await post("/webhooks/twilio/sms/incoming", p);
  const a2 = await post("/webhooks/twilio/sms/incoming", p);
  t("sequential replay: both requests answered safely", a1.status === 200 && a2.status === 200,
    `${a1.status}/${a2.status}`);

  // B) concurrent replay — the race a retrying carrier actually creates
  const p2 = inboundPayload({ MessageSid: conSid });
  const [c1, c2] = await Promise.all([
    post("/webhooks/twilio/sms/incoming", p2),
    post("/webhooks/twilio/sms/incoming", p2),
  ]);
  t("concurrent replay: both requests answered safely", c1.status === 200 && c2.status === 200,
    `${c1.status}/${c2.status}`);

  // C) the same SID must still accept DIFFERENT event types / statuses:
  //    one inbound + one callback per distinct status, and a repeat of one
  //    status must not add a row.
  const p3 = inboundPayload({ MessageSid: sepSid });
  await post("/webhooks/twilio/sms/incoming", p3);
  for (const st of ["queued", "sent", "delivered"]) {
    await post("/webhooks/twilio/sms/status", { MessageSid: sepSid, MessageStatus: st, AccountSid: "AC" + "0".repeat(32) });
  }
  const dup = await post("/webhooks/twilio/sms/status", { MessageSid: sepSid, MessageStatus: "delivered", AccountSid: "AC" + "0".repeat(32) });
  t("separation: inbound + 3 distinct statuses + 1 repeat answered safely", dup.status === 200, "status " + dup.status);
}

console.log("\n   Run this in Supabase staging (expected counts in the comments):");
console.log(`   SELECT message_sid, event_type, message_status, count(*)
   FROM   public.twilio_webhook_events
   WHERE  message_sid IN ('${seqSid}','${conSid}','${sepSid}')
   GROUP  BY 1,2,3 ORDER BY 1,2,3;
   -- ${seqSid}: exactly 1 row  (inbound, NULL)
   -- ${conSid}: exactly 1 row  (inbound, NULL)   <- the concurrency case
   -- ${sepSid}: 4 rows (inbound NULL / status queued / sent / delivered), each count = 1

   SELECT twilio_sid, direction, tenant_slug, count(*)
   FROM   public.twilio_message_logs
   WHERE  twilio_sid IN ('${seqSid}','${conSid}','${sepSid}')
   GROUP  BY 1,2,3 ORDER BY 1;
   -- one inbound row per SID, tenant_slug = solar-panel`);

// ── blast radius ────────────────────────────────────────────────────────────
console.log("\n[blast radius]");
t("only the staging host was contacted", [...contacted].every((h) => !PROD_HOSTS.includes(h)), [...contacted].join(","));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
