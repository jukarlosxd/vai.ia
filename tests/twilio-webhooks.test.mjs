// Tests for routes/twilio-webhooks.js — signed inbound + status callbacks.
// Uses the REAL Twilio SDK to generate valid X-Twilio-Signature values and the
// real store/crypto with an in-memory Supabase fake.
// Run: node tests/twilio-webhooks.test.mjs
import assert from "node:assert";
import crypto from "node:crypto";
import twilio from "twilio";
import { createTwilioStore } from "../services/twilio-store.js";
import { mountTwilioWebhooks, buildPublicWebhookUrl } from "../routes/twilio-webhooks.js";

process.env.INTEGRATIONS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log("  ✓", name); pass++; } catch (e) { console.log("  ✗", name, "—", e.message); fail++; } }

function fakeSupabase() {
  const tables = { app_integrations: [], twilio_connections: [], twilio_phone_numbers: [], tenant_phone_assignments: [], twilio_message_logs: [], twilio_webhook_events: [] };
  const uuid = () => crypto.randomUUID();
  function from(name) {
    const t = tables[name]; const st = { filters: [], _order: null, _range: null, _pending: null };
    const api = {
      select() { return api; }, eq(c, v) { st.filters.push([c, v]); return api; },
      order(c, o) { st._order = [c, o?.ascending !== false]; return api; }, range(a, b) { st._range = [a, b]; return api; }, limit(n) { st._range = [0, n - 1]; return api; },
      insert(r) { st._pending = { op: "insert", row: r }; return api; }, update(r) { st._pending = { op: "update", row: r }; return api; },
      upsert(r, o) { st._pending = { op: "upsert", row: r, onConflict: o?.onConflict }; return api; }, delete() { st._pending = { op: "delete" }; return api; },
      _match(r) { return st.filters.every(([c, v]) => r[c] === v); },
      _run() {
        const p = st._pending;
        if (p?.op === "insert") { const rows = Array.isArray(p.row) ? p.row : [p.row]; const out = []; for (const r of rows) { if (name === "twilio_webhook_events") { const d = t.find(x => x.message_sid === r.message_sid && x.event_type === r.event_type && (x.message_status ?? null) === (r.message_status ?? null)); if (d) return { data: null, error: { code: "23505" } }; } const rec = { id: uuid(), created_at: new Date().toISOString(), ...r }; t.push(rec); out.push(rec); } return { data: out, error: null }; }
        if (p?.op === "update") { const a = t.filter(r => api._match(r)); a.forEach(r => Object.assign(r, p.row)); return { data: a, error: null }; }
        if (p?.op === "upsert") { const keys = (p.onConflict || "").split(",").map(s => s.trim()).filter(Boolean); const rows = Array.isArray(p.row) ? p.row : [p.row]; const out = []; for (const r of rows) { let ex = keys.length ? t.find(x => keys.every(k => x[k] === r[k])) : null; if (ex) { Object.assign(ex, r); out.push(ex); } else { const rec = { id: uuid(), created_at: new Date().toISOString(), ...r }; t.push(rec); out.push(rec); } } return { data: out, error: null }; }
        if (p?.op === "delete") { for (let i = t.length - 1; i >= 0; i--) if (api._match(t[i])) t.splice(i, 1); return { data: [], error: null }; }
        let rows = t.filter(r => api._match(r)); if (st._order) rows = rows.sort((a, b) => (a[st._order[0]] > b[st._order[0]] ? 1 : -1) * (st._order[1] ? 1 : -1)); if (st._range) rows = rows.slice(st._range[0], st._range[1] + 1); return { data: rows, error: null };
      },
      maybeSingle() { const r = api._run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
      single() { const r = api._run(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
      then(res) { res(api._run()); },
    };
    return api;
  }
  return { from, _tables: tables };
}

// fake express app that records routes; call() runs the middleware chain.
function fakeApp() { const routes = []; return { post: (p, ...h) => routes.push({ p, h }), routes }; }
async function post(app, path, { headers = {}, body = {} } = {}) {
  const route = app.routes.find(r => r.p === path); assert(route, `route ${path} not mounted`);
  const req = { method: "POST", headers, body, originalUrl: path, url: path, ip: "1.1.1.1", secure: false };
  let status = 200, sent = null, type = null;
  const res = { status(c) { status = c; return this; }, type(tp) { type = tp; return this; }, send(b) { sent = b; return this; }, end() { sent = ""; return this; } };
  for (const h of route.h) { let nx = false; await h(req, res, () => { nx = true; }); if (!nx) break; }
  return { status, body: sent, type };
}

const AUTH_TOKEN = "webhook-test-auth-token-123";
const PUBLIC = "https://vai-ia-staging-twilio.onrender.com";
const NUMBER = "+19477292223";

async function setup({ smsEnabled = true } = {}) {
  const supabase = fakeSupabase();
  const store = createTwilioStore({ supabase, environment: "staging" });
  await store.saveConnection({ accountSid: "AC" + "0".repeat(32), authToken: AUTH_TOKEN, defaultFromNumber: NUMBER, testMode: true });
  await store.setConnectionStatus({ status: "test_mode" });
  await store.assignNumber({ tenantSlug: "solar-panel", phoneNumber: NUMBER, smsEnabled, mode: "test" },
    { assertTenantExists: async () => true, assertNumberSmsCapable: async () => true });
  const receptionistCalls = [], deliverCalls = [];
  const app = fakeApp();
  mountTwilioWebhooks(app, {
    store, twilioSdk: twilio, rateLimit: () => (req, res, next) => next(),
    runReceptionist: async (a) => { receptionistCalls.push(a); return "Gracias por tu mensaje."; },
    smsDeliver: async (a) => { deliverCalls.push(a); return { ok: true, code: "DELIVERY_QUEUED", simulated: true }; },
    environment: "staging", publicBaseUrl: PUBLIC,
  });
  return { app, store, receptionistCalls, deliverCalls, supabase };
}

function signedHeaders(path, params) {
  const url = PUBLIC + path;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return { "x-twilio-signature": sig, "x-forwarded-proto": "https", "x-forwarded-host": "vai-ia-staging-twilio.onrender.com" };
}
const IN = "/webhooks/twilio/sms/incoming";
const STAT = "/webhooks/twilio/sms/status";

console.log("── twilio-webhooks ──");

await t("buildPublicWebhookUrl is proxy-aware (https + forwarded host, not localhost)", () => {
  const req = { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.onrender.com", host: "localhost:3100" }, originalUrl: "/webhooks/twilio/sms/incoming" };
  assert.equal(buildPublicWebhookUrl(req), "https://app.onrender.com/webhooks/twilio/sms/incoming");
});

await t("inbound: valid signature → accepted; tenant resolved by To; receptionist+reply once", async () => {
  const { app, receptionistCalls, deliverCalls } = await setup();
  const params = { To: NUMBER, From: "+13855597773", MessageSid: "SM_in_1", Body: "hola" };
  const r = await post(app, IN, { headers: signedHeaders(IN, params), body: params });
  assert.equal(r.status, 200);
  assert.equal(receptionistCalls.length, 1);
  assert.equal(receptionistCalls[0].slug, "solar-panel");   // tenant from To, not payload
  assert.equal(deliverCalls.length, 1);
  assert.equal(deliverCalls[0].to, "+13855597773");         // reply goes to sender
});

await t("inbound: invalid signature → 403", async () => {
  const { app, receptionistCalls } = await setup();
  const params = { To: NUMBER, From: "+13855597773", MessageSid: "SM_bad", Body: "x" };
  const r = await post(app, IN, { headers: { "x-twilio-signature": "WRONG", "x-forwarded-proto": "https", "x-forwarded-host": "vai-ia-staging-twilio.onrender.com" }, body: params });
  assert.equal(r.status, 403);
  assert.equal(receptionistCalls.length, 0);
});

await t("inbound: missing signature → 403", async () => {
  const { app } = await setup();
  const params = { To: NUMBER, From: "+13855597773", MessageSid: "SM_ns", Body: "x" };
  const r = await post(app, IN, { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "vai-ia-staging-twilio.onrender.com" }, body: params });
  assert.equal(r.status, 403);
});

await t("inbound: unknown To (unassigned) → safe 200, no processing", async () => {
  const { app, receptionistCalls } = await setup();
  const params = { To: "+15550009999", From: "+13855597773", MessageSid: "SM_unk", Body: "x" };
  const r = await post(app, IN, { headers: signedHeaders(IN, params), body: params });
  assert.equal(r.status, 200);
  assert.equal(receptionistCalls.length, 0);
});

await t("inbound: repeated MessageSid → idempotent (receptionist + reply once only)", async () => {
  const { app, receptionistCalls, deliverCalls } = await setup();
  const params = { To: NUMBER, From: "+13855597773", MessageSid: "SM_dup", Body: "hola" };
  const h = signedHeaders(IN, params);
  await post(app, IN, { headers: h, body: params });
  await post(app, IN, { headers: h, body: params });
  assert.equal(receptionistCalls.length, 1);
  assert.equal(deliverCalls.length, 1);
});

await t("inbound: SMS disabled for tenant → stored but no auto-reply", async () => {
  const { app, receptionistCalls, deliverCalls } = await setup({ smsEnabled: false });
  const params = { To: NUMBER, From: "+13855597773", MessageSid: "SM_off", Body: "x" };
  const r = await post(app, IN, { headers: signedHeaders(IN, params), body: params });
  assert.equal(r.status, 200);
  assert.equal(deliverCalls.length, 0);   // no outbound when disabled
});

await t("status: valid signature updates the matching message; sanitized error stored", async () => {
  const { app, store } = await setup();
  const from = NUMBER, to = "+13855597773";
  await store.logMessage({ tenantSlug: "solar-panel", direction: "outbound", from, to, body: "hi", status: "queued", sid: "SM_out_1" });
  const params = { MessageSid: "SM_out_1", MessageStatus: "delivered" };
  const r = await post(app, STAT, { headers: signedHeaders(STAT, params), body: params });
  assert.equal(r.status, 200);
  const logs = await store.listMessages({ tenantSlug: "solar-panel" });
  assert.equal(logs.find(l => l.preview === "hi").status, "delivered");

  const failParams = { MessageSid: "SM_out_1", MessageStatus: "failed", ErrorCode: "30006" };
  await post(app, STAT, { headers: signedHeaders(STAT, failParams), body: failParams });
  const logs2 = await store.listMessages({ tenantSlug: "solar-panel" });
  const row = logs2.find(l => l.preview === "hi");
  assert.equal(row.status, "failed");
  assert.ok(row.errorMessage && row.errorMessage.includes("30006"));
  assert.ok(!/raw|payload|password/i.test(JSON.stringify(row)), "no raw payload leaked");
});

await t("status: invalid signature → 403; unknown sid → safe 200 (no new message)", async () => {
  const { app, store } = await setup();
  const bad = await post(app, STAT, { headers: { "x-twilio-signature": "NOPE" }, body: { MessageSid: "SMx", MessageStatus: "sent" } });
  assert.equal(bad.status, 403);
  const params = { MessageSid: "SM_ghost", MessageStatus: "sent" };
  const ok = await post(app, STAT, { headers: signedHeaders(STAT, params), body: params });
  assert.equal(ok.status, 200);
  const logs = await store.listMessages({});
  assert.equal(logs.length, 0);   // no message created by a status callback
});

await t("status: repeated callback is idempotent (no duplicate processing)", async () => {
  const { app, store } = await setup();
  await store.logMessage({ tenantSlug: "solar-panel", direction: "outbound", from: NUMBER, to: "+13855597773", body: "hi", status: "queued", sid: "SM_r" });
  const params = { MessageSid: "SM_r", MessageStatus: "sent" };
  const h = signedHeaders(STAT, params);
  const a = await post(app, STAT, { headers: h, body: params });
  const b = await post(app, STAT, { headers: h, body: params });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const logs = await store.listMessages({ tenantSlug: "solar-panel" });
  assert.equal(logs.length, 1);   // still one message
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
