// routes/admin-twilio.js
// Protected admin API for the Twilio SMS integration (Admin → Apps → Twilio).
// Mounted from index.js; keeps that file from growing. All routes require an
// authenticated admin, a specific rate limiter, and (for state changes) a
// stateless double-submit CSRF token. Secrets NEVER appear in any response.
//
// deps:
//   app, supabase, environment, verifyAdmin, rateLimit,
//   twilioClientFactory(accountSid, authToken) -> twilio client (injected → testable),
//   assertTenantExists(slug) -> Promise<boolean>,
//   auditLog({...}) -> Promise (optional),
//   csrfSecret: string (defaults to JWT_SECRET)

import crypto from "crypto";
import { createTwilioStore, normalizeE164, maskPhone } from "../services/twilio-store.js";

function jerr(res, status, code, message) { return res.status(status).json({ ok: false, error: { code, message } }); }

// Stateless CSRF: token = HMAC(secret, "csrf:"+adminId+":"+email). The browser
// reads it from GET / and echoes it in X-CSRF-Token on state-changing calls. A
// cross-site attacker can neither read the JSON body (CORS) nor forge the HMAC.
function makeCsrf(secret, admin) {
  return crypto.createHmac("sha256", secret)
    .update("csrf:" + (admin?.id || "") + ":" + (admin?.email || ""))
    .digest("base64url");
}

export function mountAdminTwilio(app, deps) {
  const {
    supabase, environment = "staging", verifyAdmin, rateLimit,
    twilioClientFactory, assertTenantExists, auditLog = async () => {},
    csrfSecret = process.env.JWT_SECRET,
  } = deps;

  const store = createTwilioStore({ supabase, environment });

  const limiter = rateLimit({
    windowMs: 60 * 1000, max: 40,
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => jerr(res, 429, "RATE_LIMITED", "Too many requests. Please slow down."),
  });

  const csrfGuard = (req, res, next) => {
    const t = req.headers["x-csrf-token"];
    if (!t || t !== makeCsrf(csrfSecret, req.admin)) return jerr(res, 403, "CSRF", "invalid or missing CSRF token");
    next();
  };
  // Same-origin defense-in-depth for state changes.
  const sameOrigin = (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      try { if (new URL(origin).host !== host) return jerr(res, 403, "CSRF", "cross-origin request rejected"); }
      catch { return jerr(res, 403, "CSRF", "bad origin"); }
    }
    next();
  };
  const audit = (req, action, meta = {}) =>
    auditLog({ actor: req.admin?.email, area: "twilio", action, environment, ...meta }).catch(() => {});

  const base = "/admin/api/apps/twilio";
  const V = verifyAdmin;
  const guards = [V, limiter];
  const writeGuards = [V, limiter, sameOrigin, csrfGuard];

  // ── GET connection status (+ CSRF token for the page) ──────────────────────
  app.get(base, ...guards, async (req, res) => {
    try {
      const conn = await store.getConnection();
      res.json({ ok: true, environment, csrfToken: makeCsrf(csrfSecret, req.admin), connection: conn });
    } catch (e) { console.error("[TWILIO-API] get:", e.message); jerr(res, 500, "INTERNAL_ERROR", "could not load integration"); }
  });

  // ── Save/update credentials + config (encrypted; empty secret preserved) ───
  app.post(`${base}/connect`, ...writeGuards, async (req, res) => {
    try {
      const b = req.body || {};
      if (b.accountSid !== undefined && b.accountSid && !/^AC[0-9a-zA-Z]{10,}$/.test(String(b.accountSid).trim())) {
        return jerr(res, 400, "VALIDATION_ERROR", "Account SID format looks invalid");
      }
      if (b.defaultFromNumber && !normalizeE164(b.defaultFromNumber)) {
        return jerr(res, 400, "VALIDATION_ERROR", "default from number is not a valid phone number");
      }
      const view = await store.saveConnection({
        accountSid: b.accountSid, authToken: b.authToken, apiKeySid: b.apiKeySid, apiKeySecret: b.apiKeySecret,
        messagingServiceSid: b.messagingServiceSid, defaultFromNumber: b.defaultFromNumber,
        smsEnabled: b.smsEnabled, inboundEnabled: b.inboundEnabled,
        statusCallbacksEnabled: b.statusCallbacksEnabled, testMode: b.testMode,
      });
      await audit(req, "connect_saved");
      res.json({ ok: true, connection: view });   // view carries NO secret
    } catch (e) { console.error("[TWILIO-API] connect:", e.message); jerr(res, 500, "INTERNAL_ERROR", "could not save connection"); }
  });

  // ── Test connection against the Twilio API ─────────────────────────────────
  app.post(`${base}/test`, ...writeGuards, async (req, res) => {
    try {
      // The test NEVER takes credentials from the request body — it always uses
      // the persisted, server-side-decrypted connection.
      let creds;
      try { creds = await store.getDecryptedCredentials(); }
      catch (e) {
        // A local problem (missing/undecryptable credentials) or an explicit
        // admin disconnect. Either way: never wipe what is stored.
        const status = e.code === "DELIVERY_DISABLED" ? "disconnected" : "configuration_error";
        await store.setConnectionStatus({ status, error: safeMsg(e) });
        const view = await store.getConnection();
        return res.status(400).json({
          ok: false, connected: false, status,
          accountMasked: view.accountSidMasked || null,
          hasToken: !!view.hasToken,
          lastTestedAt: view.lastTestedAt || null,
          error: safeMsg(e),
        });
      }
      try {
        const client = twilioClientFactory(creds.accountSid, creds.authToken);
        const acct = await client.api.accounts(creds.accountSid).fetch();
        const status = creds.testMode ? "test_mode" : "connected";
        await store.setConnectionStatus({ status, error: null });
        await audit(req, "connection_tested", { result: "ok" });
        const view = await store.getConnection();
        res.json({
          ok: true, connected: true, status,
          accountMasked: view.accountSidMasked || null,
          hasToken: !!view.hasToken,
          lastTestedAt: view.lastTestedAt || null,
          accountStatus: acct?.status || "active", accountType: acct?.type || null,
        });
      } catch (e) {
        const { status, message } = classifyTwilioFailure(e);
        await store.setConnectionStatus({ status, error: message });
        await audit(req, "connection_tested", { result: "fail" });
        const view = await store.getConnection();
        res.status(400).json({
          ok: false, connected: false, status,
          accountMasked: view.accountSidMasked || null,   // a failed test never hides the SID
          hasToken: !!view.hasToken,                      // …and never wipes the token
          lastTestedAt: view.lastTestedAt || null,
          error: message,
        });
      }
    } catch (e) { console.error("[TWILIO-API] test:", e.message); jerr(res, 500, "INTERNAL_ERROR", "test failed"); }
  });

  // ── Disconnect (keeps history/logs; wipes usable secrets) ──────────────────
  app.post(`${base}/disconnect`, ...writeGuards, async (req, res) => {
    try { await store.disconnect(); await audit(req, "disconnected"); res.json({ ok: true }); }
    catch (e) { console.error("[TWILIO-API] disconnect:", e.message); jerr(res, 500, "INTERNAL_ERROR", "could not disconnect"); }
  });

  // ── List numbers from Twilio (safe fields only) + cache to DB ──────────────
  app.get(`${base}/numbers`, ...guards, async (req, res) => {
    try {
      let creds;
      try { creds = await store.getDecryptedCredentials(); }
      catch (e) { return jerr(res, 400, e.code || "DELIVERY_CONFIGURATION_ERROR", safeMsg(e)); }
      const client = twilioClientFactory(creds.accountSid, creds.authToken);
      const list = await client.incomingPhoneNumbers.list({ limit: 50 });
      const numbers = (list || []).map(n => ({
        phoneNumber: n.phoneNumber, phoneMasked: maskPhone(n.phoneNumber),
        friendlyName: n.friendlyName,
        smsCapable: !!n.capabilities?.sms, mmsCapable: !!n.capabilities?.mms, voiceCapable: !!n.capabilities?.voice,
        status: n.status || "in-use",
      }));
      await store.saveNumbers(numbers.map(n => ({ phoneNumber: n.phoneNumber, friendlyName: n.friendlyName, smsCapable: n.smsCapable, voiceCapable: n.voiceCapable })));
      res.json({ ok: true, numbers });
    } catch (e) { console.error("[TWILIO-API] numbers:", e.message); jerr(res, 400, "TWILIO_ERROR", safeTwilioError(e)); }
  });

  // ── Send a test SMS (simulated in test mode; real only when explicitly live)
  app.post(`${base}/test-sms`, ...writeGuards, async (req, res) => {
    try {
      const b = req.body || {};
      const to = normalizeE164(b.to);
      if (!to) return jerr(res, 400, "VALIDATION_ERROR", "invalid destination number");
      const body = String(b.message || "").trim();
      if (!body) return jerr(res, 400, "VALIDATION_ERROR", "message is empty");
      if (body.length > 480) return jerr(res, 400, "VALIDATION_ERROR", "message too long (max 480)");
      const tenantSlug = b.tenantSlug ? String(b.tenantSlug) : "platform";

      const conn = await store.getConnection();
      if (!conn.connected) return jerr(res, 400, "DELIVERY_CONFIGURATION_ERROR", "Twilio integration is not connected");
      if (!conn.smsEnabled) return jerr(res, 400, "DELIVERY_DISABLED", "SMS is disabled for this connection");

      const from = normalizeE164(b.from) || conn.defaultFromNumber;
      if (!from) return jerr(res, 400, "VALIDATION_ERROR", "no From number configured");

      // TEST MODE (or explicit simulate) → do NOT hit Twilio; record 'simulated'.
      if (conn.testMode || b.simulate) {
        const id = await store.logMessage({ tenantSlug, direction: "outbound", from, to, body, status: "simulated", sid: "SM_SIMULATED_" + crypto.randomBytes(6).toString("hex") });
        await audit(req, "test_sms_simulated", { to: maskPhone(to) });
        return res.json({ ok: true, simulated: true, status: "simulated", to: maskPhone(to), logId: id });
      }

      // REAL send.
      let creds;
      try { creds = await store.getDecryptedCredentials(); }
      catch (e) { return jerr(res, 400, e.code || "DELIVERY_CONFIGURATION_ERROR", safeMsg(e)); }
      const client = twilioClientFactory(creds.accountSid, creds.authToken);
      const statusCallback = b.statusCallback || undefined;
      let msg;
      try { msg = await client.messages.create({ from, to, body, ...(statusCallback ? { statusCallback } : {}) }); }
      catch (e) {
        const em = safeTwilioError(e);
        await store.logMessage({ tenantSlug, direction: "outbound", from, to, body, status: "failed", errorCode: e?.code ? String(e.code) : null, errorMessage: em });
        return jerr(res, 400, "DELIVERY_FAILED", em);
      }
      await store.logMessage({ tenantSlug, direction: "outbound", from, to, body, status: msg.status || "queued", sid: msg.sid });
      await audit(req, "test_sms_sent", { to: maskPhone(to), sid: mask(msg.sid) });
      // Never claim delivered here — only accepted/queued until a status callback.
      res.json({ ok: true, simulated: false, status: msg.status || "queued", to: maskPhone(to), sid: mask(msg.sid) });
    } catch (e) { console.error("[TWILIO-API] test-sms:", e.message); jerr(res, 500, "INTERNAL_ERROR", "send failed"); }
  });

  // ── Message logs (filters + pagination; masked) ────────────────────────────
  app.get(`${base}/logs`, ...guards, async (req, res) => {
    try {
      const q = req.query || {};
      const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 100);
      const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
      const rows = await store.listMessages({
        tenantSlug: q.tenant || null, direction: q.direction || null, status: q.status || null, limit, offset,
      });
      res.json({ ok: true, logs: rows, page: { limit, offset } });
    } catch (e) { console.error("[TWILIO-API] logs:", e.message); jerr(res, 500, "INTERNAL_ERROR", "could not load logs"); }
  });

  // ── Tenant phone assignments ───────────────────────────────────────────────
  app.get(`${base}/assignments`, ...guards, async (req, res) => {
    try { res.json({ ok: true, assignments: await store.listAssignments() }); }
    catch (e) { console.error("[TWILIO-API] assignments:", e.message); jerr(res, 500, "INTERNAL_ERROR", "could not load assignments"); }
  });

  app.post(`${base}/assignments`, ...writeGuards, async (req, res) => {
    try {
      const b = req.body || {};
      const a = await store.assignNumber(
        { tenantSlug: b.tenantSlug, phoneNumber: b.phoneNumber, messagingServiceSid: b.messagingServiceSid,
          smsEnabled: b.smsEnabled, voiceEnabled: b.voiceEnabled, mode: b.mode, status: b.status },
        { assertTenantExists, assertNumberSmsCapable: async (e164) => {
            const nums = await store.listNumbers();
            const known = nums.find(n => n.phoneNumber === e164);
            return known ? known.smsCapable !== false : true; // if unknown to cache, allow (Twilio enforces)
          } });
      await audit(req, "assignment_created", { tenant: b.tenantSlug, number: maskPhone(b.phoneNumber) });
      res.json({ ok: true, assignment: a });
    } catch (e) {
      if (e.code === "VALIDATION_ERROR") return jerr(res, 400, "VALIDATION_ERROR", e.message);
      console.error("[TWILIO-API] assign:", e.message); jerr(res, 500, "INTERNAL_ERROR", "assignment failed");
    }
  });

  app.delete(`${base}/assignments/:id`, ...writeGuards, async (req, res) => {
    try {
      if (!/^[0-9a-fA-F-]{36}$/.test(req.params.id || "")) return jerr(res, 400, "VALIDATION_ERROR", "invalid id");
      await store.deleteAssignment(req.params.id);
      await audit(req, "assignment_deleted", { id: req.params.id });
      res.json({ ok: true });
    } catch (e) { console.error("[TWILIO-API] del-assign:", e.message); jerr(res, 500, "INTERNAL_ERROR", "delete failed"); }
  });

  console.log("[TWILIO-API] admin routes mounted at /admin/api/apps/twilio/*");
  return { store, makeCsrf: (admin) => makeCsrf(csrfSecret, admin) };
}

// helpers — always return safe, secret-free messages
function mask(v, n = 4) { const s = String(v || ""); return s ? "••••" + s.slice(-n) : null; }
function safeMsg(e) { return (e && e.message ? String(e.message) : "error").slice(0, 160); }
// Map a Twilio SDK / transport failure onto our status vocabulary and a
// sanitized, actionable message. The raw provider error is NEVER forwarded:
// it can echo request details, and its wording changes between SDK versions.
export function classifyTwilioFailure(e) {
  const code = Number(e?.code) || 0;
  const httpStatus = Number(e?.status) || 0;
  const sysErr = String(e?.errno || e?.cause?.code || e?.code || "");

  // 20003 = authenticate failed; 20404 on the account resource means the SID
  // does not belong to these credentials. Both are credential problems.
  if (code === 20003 || code === 20005 || httpStatus === 401 || httpStatus === 403) {
    return { status: "authentication_error", message: "Twilio rejected the saved credentials." };
  }
  if (code === 20404 || httpStatus === 404) {
    return { status: "authentication_error", message: "Twilio could not find this account for the saved credentials." };
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ABORT/i.test(sysErr) || httpStatus >= 500) {
    return { status: "network_error", message: "Could not reach Twilio. Try again." };
  }
  return { status: "network_error", message: "The Twilio request failed. Try again." };
}

function safeTwilioError(e) {
  // Twilio errors have .code + .message; expose only a short, non-sensitive form.
  const code = e?.code ? ` (code ${e.code})` : "";
  const m = (e?.message || "Twilio request failed").split("\n")[0].slice(0, 160);
  return m + code;
}

export { makeCsrf };
