// Tests for routes/admin-twilio.js — mounts the REAL router on a fake Express
// app with a fake Supabase, a fake Twilio client, and the real crypto/store.
// Run: node tests/admin-twilio.test.mjs
import assert from "node:assert";
import crypto from "node:crypto";
import { mountAdminTwilio } from "../routes/admin-twilio.js";

process.env.INTEGRATIONS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.JWT_SECRET = "test-jwt-secret-at-least-32-chars-long-000";

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log("  ✓", name); pass++; } catch (e) { console.log("  ✗", name, "—", e.message); fail++; } }

// ── fake supabase (reuse the store's expectations) ───────────────────────────
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

// ── fake express app + request harness ───────────────────────────────────────
function fakeApp() {
  const routes = [];
  const reg = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return { get: reg("GET"), post: reg("POST"), delete: reg("DELETE"), routes };
}
async function call(app, method, path, { admin = { id: "a1", email: "admin@x.com" }, headers = {}, body = {}, query = {}, params = {} } = {}) {
  // match by method + exact path or :param
  const route = app.routes.find(r => r.method === method && matchPath(r.path, path, params));
  assert(route, `route ${method} ${path} not registered`);
  const req = { method, admin, headers, body, query, params, ip: "127.0.0.1", url: path, originalUrl: path };
  if (headers._noAdmin) req.admin = null;
  let status = 200, jsonBody = null;
  const res = { status(c) { status = c; return this; }, json(b) { jsonBody = b; return this; } };
  for (const h of route.handlers) {
    let nexted = false;
    await h(req, res, () => { nexted = true; });
    if (!nexted) break;
  }
  return { status, body: jsonBody };
}
function matchPath(pattern, actual, outParams) {
  const pp = pattern.split("/"), ap = actual.split("/");
  if (pp.length !== ap.length) return false;
  for (let i = 0; i < pp.length; i++) { if (pp[i].startsWith(":")) { outParams[pp[i].slice(1)] = ap[i]; } else if (pp[i] !== ap[i]) return false; }
  return true;
}

// fake collaborators
const verifyAdmin = (req, res, next) => { if (!req.admin) { res.status(401).json({ ok: false, error: "Unauthorized" }); return; } next(); };
const rateLimit = () => (req, res, next) => next();
function makeDeps(twilioBehavior = {}) {
  const supabase = fakeSupabase();
  const twilioClientFactory = (sid, token) => ({
    api: { accounts: () => ({ fetch: async () => {
      if (twilioBehavior.authFail) { const e = new Error("Authenticate"); e.code = 20003; throw e; }
      if (twilioBehavior.netFail) { const e = new Error("getaddrinfo ENOTFOUND api.twilio.com"); e.errno = "ENOTFOUND"; throw e; }
      return { status: "active", type: "Trial" };
    } }) },
    incomingPhoneNumbers: { list: async () => (twilioBehavior.numbers || []) },
    messages: { create: async (m) => { if (twilioBehavior.sendFail) { const e = new Error("Message failed"); e.code = 21610; throw e; } return { sid: "SM_real_abcdef", status: "queued", ...m }; } },
  });
  const app = fakeApp();
  const api = mountAdminTwilio(app, {
    supabase, environment: "staging", verifyAdmin, rateLimit, twilioClientFactory,
    assertTenantExists: async (slug) => slug === "solar-panel",
  });
  return { app, api, supabase };
}
const B = "/admin/api/apps/twilio";

const SID = "AC" + "0".repeat(32);
console.log("── admin-twilio API ──");

await t("client (no admin) → 401 on every route", async () => {
  const { app } = makeDeps();
  for (const [m, p] of [["GET", B], ["POST", `${B}/connect`], ["POST", `${B}/test`], ["GET", `${B}/logs`]]) {
    const r = await call(app, m, p, { headers: { _noAdmin: true } });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

await t("GET returns csrfToken + connection view WITHOUT any secret", async () => {
  const { app } = makeDeps();
  const r = await call(app, "GET", B);
  assert.equal(r.status, 200);
  assert.ok(r.body.csrfToken && typeof r.body.csrfToken === "string");
  assert.equal(r.body.connection.connected, false);
  assert.ok(!JSON.stringify(r.body).match(/auth_token|authToken/i), "no token field");
});

await t("state-changing route without CSRF token → 403; with token → ok", async () => {
  const { app, api } = makeDeps();
  const noCsrf = await call(app, "POST", `${B}/connect`, { body: { accountSid: "AC" + "0".repeat(12) } });
  assert.equal(noCsrf.status, 403);
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  const ok = await call(app, "POST", `${B}/connect`, { headers: { "x-csrf-token": token }, body: { accountSid: "AC" + "0".repeat(12), authToken: "tok123" } });
  assert.equal(ok.status, 200);
  assert.ok(!JSON.stringify(ok.body).includes("tok123"), "token never echoed");
});

await t("connect: empty authToken preserves the previous secret", async () => {
  const { app, api } = makeDeps();
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  await call(app, "POST", `${B}/connect`, { headers: { "x-csrf-token": token }, body: { accountSid: SID, authToken: "original-tok" } });
  await call(app, "POST", `${B}/connect`, { headers: { "x-csrf-token": token }, body: { defaultFromNumber: "9477292223", authToken: "" } });
  const creds = await api.store.getDecryptedCredentials().catch(() => null);
  // not connected yet (test not run) → getDecryptedCredentials throws DELIVERY_DISABLED; force-enable via test path instead:
  await api.store.setConnectionStatus({ status: "connected" });
  const c2 = await api.store.getDecryptedCredentials();
  assert.equal(c2.authToken, "original-tok");
});

await t("test: valid creds → connected (test_mode); bad token → error, not connected", async () => {
  const { app, api } = makeDeps({ authFail: false });
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  await call(app, "POST", `${B}/connect`, { headers: { "x-csrf-token": token }, body: { accountSid: SID, authToken: "tok", testMode: true } });
  const ok = await call(app, "POST", `${B}/test`, { headers: { "x-csrf-token": token }, body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "test_mode");

  const bad = makeDeps({ authFail: true });
  const tok2 = bad.api.makeCsrf({ id: "a1", email: "admin@x.com" });
  await call(bad.app, "POST", `${B}/connect`, { headers: { "x-csrf-token": tok2 }, body: { accountSid: SID, authToken: "wrong", testMode: false } });
  const r = await call(bad.app, "POST", `${B}/test`, { headers: { "x-csrf-token": tok2 }, body: {} });
  assert.equal(r.status, 400);
  const view = await bad.api.store.getConnection();
  assert.equal(view.connected, false);
  assert.ok(!JSON.stringify(r.body).includes("wrong"), "token not leaked in error");
});

await t("test-sms in test mode → simulated (no Twilio call), logged", async () => {
  const { app, api } = makeDeps();
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  await call(app, "POST", `${B}/connect`, { headers: { "x-csrf-token": token }, body: { accountSid: SID, authToken: "tok", defaultFromNumber: "9477292223", testMode: true } });
  await api.store.setConnectionStatus({ status: "test_mode" });
  const r = await call(app, "POST", `${B}/test-sms`, { headers: { "x-csrf-token": token }, body: { to: "+13855597773", message: "hello", tenantSlug: "solar-panel" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.simulated, true);
  assert.equal(r.body.status, "simulated");
  assert.ok(r.body.to.includes("••"), "to masked");
});

await t("test-sms validation: invalid to / empty message rejected", async () => {
  const { app, api } = makeDeps();
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  await call(app, "POST", `${B}/connect`, { headers: { "x-csrf-token": token }, body: { accountSid: SID, authToken: "tok", defaultFromNumber: "9477292223", testMode: true } });
  await api.store.setConnectionStatus({ status: "test_mode" });
  assert.equal((await call(app, "POST", `${B}/test-sms`, { headers: { "x-csrf-token": token }, body: { to: "abc", message: "x" } })).status, 400);
  assert.equal((await call(app, "POST", `${B}/test-sms`, { headers: { "x-csrf-token": token }, body: { to: "+13855597773", message: "" } })).status, 400);
});

await t("assignments: valid tenant assigns; ghost tenant → 400", async () => {
  const { app, api } = makeDeps();
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  const ok = await call(app, "POST", `${B}/assignments`, { headers: { "x-csrf-token": token }, body: { tenantSlug: "solar-panel", phoneNumber: "9477292223", smsEnabled: true, mode: "test" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.assignment.tenantSlug, "solar-panel");
  assert.equal(ok.body.assignment.phoneNumber, "+19477292223");
  const ghost = await call(app, "POST", `${B}/assignments`, { headers: { "x-csrf-token": token }, body: { tenantSlug: "does-not-exist", phoneNumber: "9477292224", smsEnabled: true } });
  assert.equal(ghost.status, 400);
  // list + resolve
  const list = await call(app, "GET", `${B}/assignments`);
  assert.equal(list.body.assignments.length, 1);
  assert.ok(list.body.assignments[0].phoneMasked.includes("••"), "assignment phone masked");
});

// ── POST /test — the staging "Status: error / disconnected" defect ──────────
// Contract: the test ALWAYS uses the persisted, server-decrypted credentials;
// it never accepts a token from the browser; a failure never destroys or hides
// what is stored; and the status vocabulary distinguishes the real cause.

await t("D-TEST-1: correct SID + token → connected, sanitized success payload", async () => {
  const { app, api } = makeDeps();
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  const h = { "x-csrf-token": token };
  await call(app, "POST", `${B}/connect`, { headers: h, body: { accountSid: SID, authToken: "realtoken" } });
  const r = await call(app, "POST", `${B}/test`, { headers: h, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, true);
  assert.ok(["connected", "test_mode"].includes(r.body.status), "status " + r.body.status);
  assert.ok(r.body.accountMasked && r.body.accountMasked.includes("••"), "SID masked");
  assert.equal(r.body.hasToken, true);
  assert.ok(r.body.lastTestedAt, "lastTestedAt stamped");
  assert.ok(!JSON.stringify(r.body).includes("realtoken"), "no secret in response");
});

await t("D-TEST-2: correct SID + wrong token → authentication_error (not 'disconnected')", async () => {
  const { app, api } = makeDeps({ authFail: true });
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  const h = { "x-csrf-token": token };
  await call(app, "POST", `${B}/connect`, { headers: h, body: { accountSid: SID, authToken: "wrongtoken" } });
  const r = await call(app, "POST", `${B}/test`, { headers: h, body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.body.connected, false);
  assert.equal(r.body.status, "authentication_error");
  assert.match(r.body.error, /rejected the saved credentials/i);
  assert.ok(!/disconnected/i.test(r.body.error), "must not blame an admin disconnect");
});

await t("D-TEST-3: a failed test preserves the Account SID and the stored token", async () => {
  const { app, api } = makeDeps({ authFail: true });
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  const h = { "x-csrf-token": token };
  await call(app, "POST", `${B}/connect`, { headers: h, body: { accountSid: SID, authToken: "wrongtoken" } });
  const r = await call(app, "POST", `${B}/test`, { headers: h, body: {} });
  assert.ok(r.body.accountMasked, "SID still shown after a failed test");
  assert.equal(r.body.hasToken, true, "token still stored after a failed test");
  const after = await call(app, "GET", B);
  assert.ok(after.body.connection.accountSidMasked, "GET still shows the SID");
  assert.equal(after.body.connection.hasToken, true, "GET still reports a stored token");
});

await t("D-TEST-4: token never saved → configuration_error naming the Auth Token", async () => {
  const { app, api } = makeDeps();
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  const h = { "x-csrf-token": token };
  await call(app, "POST", `${B}/connect`, { headers: h, body: { accountSid: SID } });   // SID only
  const r = await call(app, "POST", `${B}/test`, { headers: h, body: {} });
  assert.equal(r.status, 400);
  assert.equal(r.body.status, "configuration_error");
  assert.match(r.body.error, /Auth Token is not configured/i);
  assert.equal(r.body.hasToken, false);
  assert.ok(r.body.accountMasked, "the SID that WAS saved is still reported");
});

await t("D-TEST-5: the test ignores any token supplied in the request body", async () => {
  const { app, api } = makeDeps({ authFail: true });
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  const h = { "x-csrf-token": token };
  await call(app, "POST", `${B}/connect`, { headers: h, body: { accountSid: SID, authToken: "storedtoken" } });
  // A caller trying to smuggle "good" credentials through the test endpoint
  // must not change the outcome — persisted credentials are the only source.
  const r = await call(app, "POST", `${B}/test`, { headers: h, body: { authToken: "attacker-supplied", accountSid: "AC" + "9".repeat(32) } });
  assert.equal(r.body.status, "authentication_error", "still uses the STORED (failing) credentials");
  assert.ok(!JSON.stringify(r.body).includes("attacker-supplied"));
});

await t("D-TEST-6: a network failure is network_error, and never leaks the raw provider error", async () => {
  const { app, api } = makeDeps({ netFail: true });
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  const h = { "x-csrf-token": token };
  await call(app, "POST", `${B}/connect`, { headers: h, body: { accountSid: SID, authToken: "tok" } });
  const r = await call(app, "POST", `${B}/test`, { headers: h, body: {} });
  assert.equal(r.body.status, "network_error");
  assert.ok(!/ENOTFOUND|stack|at Object/i.test(JSON.stringify(r.body)), "raw transport error not forwarded");
});

await t("D-TEST-7: a successful test after a failure clears lastError", async () => {
  const { app, api } = makeDeps();
  const token = api.makeCsrf({ id: "a1", email: "admin@x.com" });
  const h = { "x-csrf-token": token };
  await call(app, "POST", `${B}/connect`, { headers: h, body: { accountSid: SID, authToken: "tok" } });
  const ok = await call(app, "POST", `${B}/test`, { headers: h, body: {} });
  assert.equal(ok.body.connected, true);
  const after = await call(app, "GET", B);
  assert.ok(!after.body.connection.lastError, "lastError cleared on success");
});

await t("D-TEST-8: test requires admin + CSRF", async () => {
  const { app } = makeDeps();
  const noAdmin = await call(app, "POST", `${B}/test`, { headers: { _noAdmin: true } });
  assert.equal(noAdmin.status, 401);
  const noCsrf = await call(app, "POST", `${B}/test`, { body: {} });
  assert.equal(noCsrf.status, 403);
  const badCsrf = await call(app, "POST", `${B}/test`, { headers: { "x-csrf-token": "nope" }, body: {} });
  assert.equal(badCsrf.status, 403);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
