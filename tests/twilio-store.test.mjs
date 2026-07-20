// Tests for services/twilio-store.js — exercises the REAL store with a small
// in-memory Supabase fake and the REAL AES-256-GCM crypto module.
// Run: node tests/twilio-store.test.mjs
import assert from "node:assert";
import crypto from "node:crypto";
import {
  createTwilioStore, normalizeE164, maskPhone, bodyPreview,
} from "../services/twilio-store.js";

process.env.INTEGRATIONS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log("  ✓", name); pass++; } catch (e) { console.log("  ✗", name, "—", e.message); fail++; } }

// ── minimal in-memory Supabase-like fake (only what the store uses) ──────────
function fakeSupabase() {
  const tables = {
    app_integrations: [], twilio_connections: [], twilio_phone_numbers: [],
    tenant_phone_assignments: [], twilio_message_logs: [], twilio_webhook_events: [],
  };
  const uuid = () => crypto.randomUUID();
  function from(name) {
    const t = tables[name];
    const st = { name, filters: [], _order: null, _range: null, _pending: null, _cols: null };
    const api = {
      select(cols) { st._cols = cols; return api; },
      eq(c, v) { st.filters.push([c, v]); return api; },
      order(c, o) { st._order = [c, o?.ascending !== false]; return api; },
      range(a, b) { st._range = [a, b]; return api; },
      limit(n) { st._range = [0, n - 1]; return api; },
      insert(row) { st._pending = { op: "insert", row }; return api; },
      update(row) { st._pending = { op: "update", row }; return api; },
      upsert(row, opts) { st._pending = { op: "upsert", row, onConflict: opts?.onConflict }; return api; },
      delete() { st._pending = { op: "delete" }; return api; },
      _match(r) { return st.filters.every(([c, v]) => r[c] === v); },
      _run() {
        const p = st._pending;
        if (p?.op === "insert") {
          const rows = Array.isArray(p.row) ? p.row : [p.row];
          const created = [];
          for (const r of rows) {
            // simulate unique on twilio_webhook_events(message_sid,event_type,message_status)
            if (name === "twilio_webhook_events") {
              const dup = t.find(x => x.message_sid === r.message_sid && x.event_type === r.event_type && (x.message_status ?? null) === (r.message_status ?? null));
              if (dup) return { data: null, error: { code: "23505", message: "duplicate" } };
            }
            const rec = { id: uuid(), created_at: new Date().toISOString(), ...r };
            t.push(rec); created.push(rec);
          }
          return { data: created, error: null };
        }
        if (p?.op === "update") {
          const affected = t.filter(r => api._match(r));
          affected.forEach(r => Object.assign(r, p.row));
          return { data: affected, error: null };
        }
        if (p?.op === "upsert") {
          const keys = (p.onConflict || "").split(",").map(s => s.trim()).filter(Boolean);
          const rows = Array.isArray(p.row) ? p.row : [p.row];
          const out = [];
          for (const r of rows) {
            let ex = keys.length ? t.find(x => keys.every(k => x[k] === r[k])) : null;
            if (ex) { Object.assign(ex, r); out.push(ex); }
            else { const rec = { id: uuid(), created_at: new Date().toISOString(), ...r }; t.push(rec); out.push(rec); }
          }
          return { data: out, error: null };
        }
        if (p?.op === "delete") {
          for (let i = t.length - 1; i >= 0; i--) if (api._match(t[i])) t.splice(i, 1);
          return { data: [], error: null };
        }
        // plain select
        let rows = t.filter(r => api._match(r));
        if (st._order) rows = rows.sort((a, b) => (a[st._order[0]] > b[st._order[0]] ? 1 : -1) * (st._order[1] ? 1 : -1));
        if (st._range) rows = rows.slice(st._range[0], st._range[1] + 1);
        return { data: rows, error: null };
      },
      maybeSingle() { const r = api._run(); const rows = r.data || []; return Promise.resolve({ data: rows[0] || null, error: r.error }); },
      single() { const r = api._run(); const rows = r.data || []; return Promise.resolve({ data: rows[0] || null, error: r.error }); },
      then(res) { res(api._run()); },
    };
    return api;
  }
  return { from, _tables: tables };
}

const mk = () => createTwilioStore({ supabase: fakeSupabase(), environment: "staging" });

console.log("── twilio-store ──");

await t("normalizeE164: US 10-digit / 11-digit / +prefixed / invalid", () => {
  assert.equal(normalizeE164("(947) 729-2223"), "+19477292223");
  assert.equal(normalizeE164("19477292223"), "+19477292223");
  assert.equal(normalizeE164("+1 385 559 7773"), "+13855597773");
  assert.equal(normalizeE164("abc"), null);
  assert.equal(normalizeE164(""), null);
});

await t("maskPhone hides the middle; bodyPreview truncates", () => {
  assert.equal(maskPhone("+19477292223"), "+••••23");
  assert.ok(!maskPhone("+19477292223").includes("7729"));
  assert.equal(bodyPreview("x".repeat(200)).length, 80);
});

await t("saveConnection encrypts token; getConnection NEVER exposes it", async () => {
  const s = mk();
  const view = await s.saveConnection({ accountSid: "AC" + "0".repeat(30) + "1234", authToken: "supersecrettoken", defaultFromNumber: "9477292223" });
  assert.equal(view.hasToken, true);
  assert.ok(view.accountSidMasked.startsWith("AC••••"));
  assert.ok(!("authToken" in view) && !("auth_token" in view) && !("auth_token_encrypted" in view), "no token field in public view");
  assert.equal(view.defaultFromNumber, "+19477292223");
  assert.ok(!JSON.stringify(view).includes("supersecrettoken"), "plaintext token must never appear");
});

await t("empty authToken on update PRESERVES the existing secret", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC1", authToken: "tok-original" });
  await s.saveConnection({ defaultFromNumber: "9477292223", authToken: "" }); // empty → keep
  const creds = await (async () => { await s.setConnectionStatus({ status: "connected" }); return s.getDecryptedCredentials(); })();
  assert.equal(creds.authToken, "tok-original");
});

await t("getDecryptedCredentials returns token server-side; throws DELIVERY_DISABLED when off", async () => {
  const s = mk();
  await assert.rejects(() => s.getDecryptedCredentials(), e => e.code === "DELIVERY_DISABLED");
  await s.saveConnection({ accountSid: "AC1", authToken: "tok" });
  await s.setConnectionStatus({ status: "connected" });
  const creds = await s.getDecryptedCredentials();
  assert.equal(creds.authToken, "tok");
  assert.equal(creds.accountSid, "AC1");
});

await t("disconnect wipes the token and disables", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC1", authToken: "tok" });
  await s.setConnectionStatus({ status: "connected" });
  await s.disconnect();
  const view = await s.getConnection();
  assert.equal(view.connected, false);
  assert.equal(view.hasToken, false);
  await assert.rejects(() => s.getDecryptedCredentials(), e => e.code === "DELIVERY_DISABLED");
});

await t("assignNumber validates tenant + SMS capability; resolveTenantByNumber routes by To", async () => {
  const s = mk();
  await assert.rejects(() => s.assignNumber({ tenantSlug: "ghost", phoneNumber: "9477292223", smsEnabled: true },
    { assertTenantExists: async () => false }), e => e.code === "VALIDATION_ERROR");
  const a = await s.assignNumber({ tenantSlug: "solar-panel", phoneNumber: "(947) 729-2223", smsEnabled: true, mode: "test" },
    { assertTenantExists: async () => true, assertNumberSmsCapable: async () => true });
  assert.equal(a.tenantSlug, "solar-panel");
  assert.equal(a.phoneNumber, "+19477292223");
  const routed = await s.resolveTenantByNumber("+1 (947) 729-2223");
  assert.equal(routed.tenantSlug, "solar-panel");
  const send = await s.resolveSendConfigByTenant("solar-panel");
  assert.equal(send.phoneNumber, "+19477292223");
});

await t("recordWebhookEvent is idempotent (duplicate sid/type/status → no-op)", async () => {
  const s = mk();
  const first = await s.recordWebhookEvent({ messageSid: "SM123", eventType: "status", messageStatus: "delivered" });
  const again = await s.recordWebhookEvent({ messageSid: "SM123", eventType: "status", messageStatus: "delivered" });
  assert.equal(first.firstTime, true);
  assert.equal(again.firstTime, false);
});

await t("logMessage + updateMessageStatus + listMessages (SID masked, phones masked)", async () => {
  const s = mk();
  await s.logMessage({ tenantSlug: "solar-panel", direction: "outbound", from: "+19477292223", to: "+13855597773", body: "hi", status: "queued", sid: "SM_abcdef123456" });
  await s.updateMessageStatus({ sid: "SM_abcdef123456", status: "sent" });
  const list = await s.listMessages({ tenantSlug: "solar-panel" });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "sent");
  assert.ok(list[0].to.includes("••"), "phone masked");
  assert.ok(!JSON.stringify(list[0]).includes("SM_abcdef123456"), "full SID never exposed");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
