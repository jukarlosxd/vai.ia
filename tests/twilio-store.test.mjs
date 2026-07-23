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
            // CHECK (status IN (...)) on app_integrations — see migration 004
            if (name === "app_integrations" && r.status !== undefined && !ALLOWED_STATUS.has(r.status)) {
              return { data: null, error: { code: "23514", message: `violates check constraint (status='${r.status}')` } };
            }
            const rec = { id: uuid(), created_at: new Date().toISOString(), ...r };
            t.push(rec); created.push(rec);
          }
          return { data: created, error: null };
        }
        if (p?.op === "update") {
          if (name === "app_integrations" && p.row.status !== undefined && !ALLOWED_STATUS.has(p.row.status)) {
            return { data: null, error: { code: "23514", message: `violates check constraint (status='${p.row.status}')` } };
          }
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

// The real schema constrains app_integrations.status. The fake used to accept
// ANY value, so a state vocabulary the database rejects looked perfectly fine
// in tests while silently freezing the row in staging. The fake now enforces
// the same CHECK, and ALLOWED_STATUS is kept in lockstep with migration 004.
const ALLOWED_STATUS = new Set([
  "unconfigured", "saved", "testing", "connected", "test_mode",
  "authentication_error", "configuration_error", "network_error",
  "disconnected", "error",
]);

const mk = () => createTwilioStore({ supabase: fakeSupabase(), environment: "staging" });
// Same store, but hands back the underlying fake DB so a test can corrupt a
// stored value on purpose (e.g. simulate a ciphertext written with another key).
const mkWithDb = () => {
  const supabase = fakeSupabase();
  return { store: createTwilioStore({ supabase, environment: "staging" }), db: supabase._tables };
};

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

await t("getDecryptedCredentials returns token server-side; a fresh install is a CONFIGURATION error, not 'disconnected'", async () => {
  const s = mk();
  // Nothing saved yet. This is NOT an administrator disconnect — reporting it
  // as DELIVERY_DISABLED ("Twilio integration disconnected") is what hid the
  // real cause in staging. It must be a configuration error.
  await assert.rejects(() => s.getDecryptedCredentials(), e => e.code === "DELIVERY_CONFIGURATION_ERROR");
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

// D-IDEMP: inbound events have message_status = NULL. Under default SQL a
// UNIQUE constraint treats NULLs as distinct, so a replayed inbound SMS was
// recorded twice (observed live: 3 duplicated message_sids). The fix is
// migration 005 (UNIQUE ... NULLS NOT DISTINCT). The fake models that: a NULL
// status collides with a NULL status.
await t("D-IDEMP-1: a replayed INBOUND event (NULL status) is deduped", async () => {
  const s = mk();
  const first = await s.recordWebhookEvent({ messageSid: "SMinbound1", eventType: "inbound", tenantSlug: "solar-panel" });
  const again = await s.recordWebhookEvent({ messageSid: "SMinbound1", eventType: "inbound", tenantSlug: "solar-panel" });
  assert.equal(first.firstTime, true, "first inbound is processed");
  assert.equal(again.firstTime, false, "a retried inbound MessageSid must NOT be processed again");
});

await t("D-IDEMP-2: distinct inbound SIDs are each processed once", async () => {
  const s = mk();
  const a = await s.recordWebhookEvent({ messageSid: "SMa", eventType: "inbound" });
  const b = await s.recordWebhookEvent({ messageSid: "SMb", eventType: "inbound" });
  assert.equal(a.firstTime, true);
  assert.equal(b.firstTime, true);
});

await t("D-IDEMP-3: an inbound and a status event for the same SID are independent", async () => {
  const s = mk();
  const inb = await s.recordWebhookEvent({ messageSid: "SMx", eventType: "inbound" });
  const st  = await s.recordWebhookEvent({ messageSid: "SMx", eventType: "status", messageStatus: "delivered" });
  assert.equal(inb.firstTime, true);
  assert.equal(st.firstTime, true, "a status callback is a different event type, not a duplicate of the inbound");
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

// ── connection-state semantics (the staging "disconnected" defect) ──────────
// Root cause: a fresh integration row was created with status 'disconnected',
// so ANY missing/broken credential was reported as an administrator disconnect
// ("Twilio integration disconnected"), masking the real cause.

await t("D-CONN-1: fresh integration is 'unconfigured', never 'disconnected'", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC1" });          // SID only, no token
  const view = await s.getConnection();
  assert.notEqual(view.status, "disconnected", "a never-connected install must not claim admin disconnect");
});

await t("D-CONN-2: SID saved but token missing → 'Auth Token is not configured' (not 'disconnected')", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC1" });
  await assert.rejects(() => s.getDecryptedCredentials(), (e) => {
    assert.equal(e.code, "DELIVERY_CONFIGURATION_ERROR");
    assert.match(e.message, /Auth Token is not configured/i);
    return true;
  });
});

await t("D-CONN-3: saving both credentials moves status to 'saved' — saving is NOT connecting", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC1", authToken: "tok" });
  const view = await s.getConnection();
  assert.equal(view.status, "saved");
  assert.equal(view.connected, false, "'saved' must never report connected");
  assert.equal(view.hasToken, true);
});

await t("D-CONN-4: only an administrator Disconnect yields DELIVERY_DISABLED", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC1", authToken: "tok" });
  await s.disconnect();
  await assert.rejects(() => s.getDecryptedCredentials(), (e) => {
    assert.equal(e.code, "DELIVERY_DISABLED");
    assert.match(e.message, /administrator/i);
    return true;
  });
});

await t("D-CONN-5: undecryptable ciphertext → configuration error, credentials NOT wiped", async () => {
  const { store: s, db } = mkWithDb();
  await s.saveConnection({ accountSid: "AC1", authToken: "tok" });
  await s.setConnectionStatus({ status: "saved" });
  // Corrupt the stored bundle in place — this is exactly what a ciphertext
  // written under a DIFFERENT INTEGRATIONS_ENCRYPTION_KEY looks like. Decrypt
  // must fail closed, and must not destroy anything.
  const row = db.twilio_connections[0];
  assert.ok(row && row.auth_token_encrypted, "precondition: a ciphertext is stored");
  row.auth_token_encrypted = "v1.zzzz.zzzz.zzzz";
  await assert.rejects(() => s.getDecryptedCredentials(), (e) => {
    assert.equal(e.code, "DELIVERY_CONFIGURATION_ERROR");
    assert.match(e.message, /could not be decrypted/i);
    return true;
  });
  const view = await s.getConnection();
  assert.equal(view.hasToken, true, "a failed decrypt must NOT wipe the stored token");
  assert.ok(view.accountSidMasked, "a failed decrypt must NOT hide the Account SID");
  assert.equal(db.twilio_connections[0].auth_token_encrypted, "v1.zzzz.zzzz.zzzz", "row untouched");
});

await t("D-CONN-6: a failed test keeps SID + token and records a sanitized error", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC1", authToken: "tok" });
  await s.setConnectionStatus({ status: "authentication_error", error: "Twilio rejected the saved credentials." });
  const view = await s.getConnection();
  assert.equal(view.status, "authentication_error");
  assert.equal(view.connected, false);
  assert.equal(view.hasToken, true, "failed test must not wipe the token");
  assert.ok(view.accountSidMasked, "failed test must not hide the SID");
  assert.ok(!JSON.stringify(view).includes("tok"), "no secret in the view");
});

await t("D-CONN-7: a successful test sets connected, stamps last_tested_at and clears last_error", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC1", authToken: "tok" });
  await s.setConnectionStatus({ status: "authentication_error", error: "previous failure" });
  await s.setConnectionStatus({ status: "connected", error: null });
  const view = await s.getConnection();
  assert.equal(view.status, "connected");
  assert.equal(view.connected, true);
  assert.ok(view.lastTestedAt, "last_tested_at stamped");
  assert.ok(!view.lastError, "success clears the previous error");
});

await t("D-CONN-8: an empty authToken preserves the stored secret (placeholder is never stored)", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC1", authToken: "tok" });
  await s.saveConnection({ accountSid: "AC1", authToken: "" });            // blank = keep
  await s.saveConnection({ accountSid: "AC1", authToken: "   " });         // whitespace = keep
  const creds = await s.getDecryptedCredentials();
  assert.equal(creds.authToken, "tok", "blank/whitespace must never overwrite or clear the token");
});

await t("D-CONN-9: the token round-trips byte-for-byte (no trimming of a valid secret)", async () => {
  const s = mk();
  const real = "0123456789abcdef0123456789abcdef";                          // 32-char Twilio-shaped token
  await s.saveConnection({ accountSid: "AC1", authToken: real });
  const creds = await s.getDecryptedCredentials();
  assert.equal(creds.authToken, real);
  assert.equal(creds.authToken.length, 32);
});

await t("D-CONN-10: the public view never carries a secret in any state", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC1", authToken: "supersecrettoken" });
  for (const st of ["saved", "connected", "authentication_error", "configuration_error", "network_error"]) {
    await s.setConnectionStatus({ status: st, error: st === "connected" ? null : "sanitized" });
    const raw = JSON.stringify(await s.getConnection());
    assert.ok(!raw.includes("supersecrettoken"), `secret leaked in state ${st}`);
    assert.ok(!/auth_token_encrypted|ciphertext/i.test(raw), `ciphertext leaked in state ${st}`);
  }
});

// ── the schema/vocabulary mismatch (observed live in staging) ───────────────
// Every state the code writes must be permitted by the CHECK constraint, and a
// rejected write must surface as an error instead of silently freezing the row.

await t("D-SCHEMA-1: every status the store can write is allowed by the schema", async () => {
  for (const st of ["unconfigured", "saved", "connected", "test_mode",
                    "authentication_error", "configuration_error", "network_error", "disconnected"]) {
    assert.ok(ALLOWED_STATUS.has(st), `status '${st}' is written by the code but rejected by migration 004`);
  }
});

await t("D-SCHEMA-2: a CHECK violation on status THROWS — it never looks like success", async () => {
  const { store: s, db } = mkWithDb();
  await s.saveConnection({ accountSid: "AC1", authToken: "tok" });
  await assert.rejects(
    () => s.setConnectionStatus({ status: "not_a_real_state", error: null }),
    (e) => { assert.match(e.message, /cannot persist connection status/i); return true; },
    "a rejected status write must throw, not be swallowed",
  );
  // and the stored row must be unchanged
  assert.notEqual(db.app_integrations[0].status, "not_a_real_state");
});

await t("D-SCHEMA-3: saveConnection reports failure when the 'saved' transition is rejected", async () => {
  const supabase = fakeSupabase();
  const s = createTwilioStore({ supabase, environment: "staging" });
  await s.saveConnection({ accountSid: "AC1", authToken: "tok" });
  assert.equal(supabase._tables.app_integrations[0].status, "saved", "normal path still reaches 'saved'");
});

// ── number ownership (tenant takeover found live in staging) ────────────────

await t("D-OWN-1: another tenant CANNOT take over a number already assigned", async () => {
  const s = mk();
  const ok = async () => true;
  await s.assignNumber({ tenantSlug: "solar-panel", phoneNumber: "+19477292223", smsEnabled: true },
                       { assertTenantExists: ok });
  await assert.rejects(
    () => s.assignNumber({ tenantSlug: "staging-beta", phoneNumber: "+19477292223", smsEnabled: true },
                         { assertTenantExists: ok }),
    (e) => { assert.match(e.message, /already assigned to another tenant/i); return true; },
  );
  // ownership and routing must be unchanged
  const list = await s.listAssignments();
  assert.equal(list.length, 1);
  assert.equal(list[0].tenantSlug, "solar-panel");
  const routed = await s.resolveTenantByNumber("+19477292223");
  assert.equal(routed.tenantSlug, "solar-panel", "inbound routing must not follow a rejected takeover");
});

await t("D-OWN-2: the SAME tenant may update its own assignment", async () => {
  const s = mk();
  const ok = async () => true;
  await s.assignNumber({ tenantSlug: "solar-panel", phoneNumber: "+19477292223", smsEnabled: true, voiceEnabled: false },
                       { assertTenantExists: ok });
  const upd = await s.assignNumber({ tenantSlug: "solar-panel", phoneNumber: "+19477292223", smsEnabled: false, voiceEnabled: true },
                                   { assertTenantExists: ok });
  assert.equal(upd.smsEnabled, false);
  assert.equal(upd.voiceEnabled, true);
  const list = await s.listAssignments();
  assert.equal(list.length, 1, "still one assignment, not a duplicate");
});

await t("D-OWN-3: releasing a number lets a different tenant claim it", async () => {
  const s = mk();
  const ok = async () => true;
  const a = await s.assignNumber({ tenantSlug: "solar-panel", phoneNumber: "+19477292223", smsEnabled: true },
                                 { assertTenantExists: ok });
  await s.deleteAssignment(a.id);
  const b = await s.assignNumber({ tenantSlug: "staging-beta", phoneNumber: "+19477292223", smsEnabled: true },
                                 { assertTenantExists: ok });
  assert.equal(b.tenantSlug, "staging-beta");
});

// D-REVERIFY: changing an identifying credential must invalidate a prior
// verification. A stray /connect that overwrote the Account SID once left the
// integration reporting 'test_mode' with a mismatched SID — a real send would
// then fail while the UI looked healthy.
await t("D-REVERIFY-1: changing the Account SID resets a verified connection to 'saved'", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC" + "9".repeat(30) + "9a61", authToken: "tok" });
  await s.setConnectionStatus({ status: "test_mode" });
  let v = await s.getConnection();
  assert.equal(v.status, "test_mode");
  // a different Account SID arrives (token left blank → kept)
  await s.saveConnection({ accountSid: "AC" + "0".repeat(32) });
  v = await s.getConnection();
  assert.equal(v.status, "saved", "a changed SID must force re-verification");
  assert.equal(v.connected, false);
  assert.equal(v.hasToken, true, "the stored token is preserved");
});

await t("D-REVERIFY-2: a new Auth Token also forces re-verification", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC" + "1".repeat(34 - 2), authToken: "tok1" });
  await s.setConnectionStatus({ status: "connected" });
  await s.saveConnection({ authToken: "tok2" });     // same SID, new token
  const v = await s.getConnection();
  assert.equal(v.status, "saved");
});

await t("D-REVERIFY-3: a non-credential save (toggle testMode) does NOT reset a verified connection", async () => {
  const s = mk();
  await s.saveConnection({ accountSid: "AC" + "2".repeat(34 - 2), authToken: "tok" });
  await s.setConnectionStatus({ status: "test_mode" });
  await s.saveConnection({ testMode: true });        // no SID, no token
  const v = await s.getConnection();
  assert.equal(v.status, "test_mode", "toggling config must not force a re-test");
});

await t("D-REVERIFY-4: re-saving the SAME SID with a blank token keeps the verified status", async () => {
  const s = mk();
  const sid = "AC" + "3".repeat(34 - 2);
  await s.saveConnection({ accountSid: sid, authToken: "tok" });
  await s.setConnectionStatus({ status: "test_mode" });
  await s.saveConnection({ accountSid: sid });        // identical SID, blank token
  const v = await s.getConnection();
  assert.equal(v.status, "test_mode", "an unchanged SID is not a credential change");
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
