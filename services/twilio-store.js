// services/twilio-store.js
// Central storage/business layer for the manageable Twilio SMS integration.
// All Supabase access goes through the SERVICE ROLE (injected) and is ALWAYS
// scoped by `environment` (staging/production kept separate). Secrets are stored
// only as AES-256-GCM ciphertext (auth/integration-crypto.js) and the decrypted
// Auth Token is returned ONLY by getSendClient()/getDecryptedCredentials(),
// which are for server-side use and must never reach a route response or the UI.
//
// Design: a factory createTwilioStore({ supabase, environment, crypto })
// so it is fully unit-testable with a fake Supabase client and a fixed key.

import * as defaultCrypto from "../auth/integration-crypto.js";

// ─── pure helpers (exported for reuse + unit tests) ─────────────────────────

// Normalize a phone number to E.164 (+<country><national>). Returns null when
// the input can't be safely normalized. Assumes US (+1) for 10-digit inputs.
export function normalizeE164(input, defaultCountry = "1") {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  const hadPlus = s.startsWith("+");
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  let e164;
  if (hadPlus) {
    e164 = "+" + digits;
  } else if (digits.length === 10) {
    e164 = "+" + defaultCountry + digits;        // bare US 10-digit
  } else if (digits.length === 11 && digits.startsWith("1")) {
    e164 = "+" + digits;                          // 1XXXXXXXXXX
  } else {
    e164 = "+" + digits;                          // assume already country-prefixed
  }
  // E.164: + followed by 8..15 digits.
  if (!/^\+\d{8,15}$/.test(e164)) return null;
  return e164;
}

// Mask a phone for display: keep a leading "+" and the LAST 2 digits only,
// hide everything else (area code + middle). Country-code length is ambiguous,
// so we do not try to reveal it.
export function maskPhone(e164) {
  const s = String(e164 || "");
  if (!s) return "";
  const plus = s.startsWith("+") ? "+" : "";
  const digits = s.replace(/\D/g, "");
  if (digits.length <= 2) return plus + "••";
  return plus + "••••" + digits.slice(-2);
}

// Truncate a message body for list previews (full text lives in sms_messages).
export function bodyPreview(text, max = 80) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ─── store factory ─────────────────────────────────────────────────────────

export function createTwilioStore({ supabase, environment = "staging", crypto = defaultCrypto } = {}) {
  if (!supabase) throw new Error("createTwilioStore: supabase (service role) is required");
  const ENV = environment === "production" ? "production" : "staging";

  // Load the platform-scope integration + its twilio_connections row.
  async function _loadIntegrationRow() {
    const { data, error } = await supabase
      .from("app_integrations")
      .select("*")
      .eq("provider", "twilio").eq("scope", "platform").eq("environment", ENV)
      .maybeSingle();
    if (error) throw new Error("twilio-store: cannot read integration");
    return data || null;
  }
  async function _loadConnectionRow(integrationId) {
    const { data, error } = await supabase
      .from("twilio_connections").select("*").eq("integration_id", integrationId).maybeSingle();
    if (error) throw new Error("twilio-store: cannot read connection");
    return data || null;
  }

  // PUBLIC connection view — SAFE for API/UI. NEVER includes decrypted secrets.
  async function getConnection() {
    const integ = await _loadIntegrationRow();
    if (!integ) {
      return { connected: false, status: "disconnected", environment: ENV, hasToken: false };
    }
    const conn = await _loadConnectionRow(integ.id);
    return {
      // "connected" = usable: a verified live connection OR a verified test-mode
      // connection (test-mode still sends, as simulated).
      connected: integ.enabled && (integ.status === "connected" || integ.status === "test_mode"),
      status: integ.status,
      environment: ENV,
      lastTestedAt: integ.last_tested_at,
      lastError: integ.last_error || null,
      accountSidMasked: conn?.account_sid ? crypto.maskAccountSid(conn.account_sid) : null,
      hasToken: !!conn?.auth_token_encrypted,
      apiKeySid: conn?.api_key_sid || null,
      hasApiKeySecret: !!conn?.api_key_secret_encrypted,
      messagingServiceSid: conn?.messaging_service_sid || null,
      defaultFromNumber: conn?.default_from_number || null,
      smsEnabled: conn?.sms_enabled ?? true,
      inboundEnabled: conn?.inbound_enabled ?? true,
      statusCallbacksEnabled: conn?.status_callbacks_enabled ?? true,
      testMode: conn?.test_mode ?? true,
    };
  }

  // Save/update the connection. `authToken`/`apiKeySecret` are encrypted here.
  // KEY RULE: an empty/undefined secret PRESERVES the existing stored secret —
  // it is only replaced when a new non-empty value is supplied.
  async function saveConnection(input = {}) {
    const nowISO = new Date().toISOString();
    let integ = await _loadIntegrationRow();
    if (!integ) {
      const { data, error } = await supabase.from("app_integrations")
        .insert({ provider: "twilio", scope: "platform", tenant_slug: null, environment: ENV,
                  enabled: false, status: "unconfigured", updated_at: nowISO })
        .select().single();
      if (error) throw new Error("twilio-store: cannot create integration");
      integ = data;
    }
    const existing = await _loadConnectionRow(integ.id);

    const row = { integration_id: integ.id, updated_at: nowISO };
    if (input.accountSid !== undefined) row.account_sid = String(input.accountSid).trim() || null;
    if (input.apiKeySid !== undefined) row.api_key_sid = String(input.apiKeySid).trim() || null;
    if (input.messagingServiceSid !== undefined) row.messaging_service_sid = String(input.messagingServiceSid).trim() || null;
    if (input.defaultFromNumber !== undefined) row.default_from_number = normalizeE164(input.defaultFromNumber);
    if (input.smsEnabled !== undefined) row.sms_enabled = !!input.smsEnabled;
    if (input.inboundEnabled !== undefined) row.inbound_enabled = !!input.inboundEnabled;
    if (input.statusCallbacksEnabled !== undefined) row.status_callbacks_enabled = !!input.statusCallbacksEnabled;
    if (input.testMode !== undefined) row.test_mode = !!input.testMode;

    // Secrets: encrypt only when a non-empty new value is provided; otherwise keep.
    const newToken = (input.authToken ?? "").toString().trim();
    if (newToken) row.auth_token_encrypted = crypto.encryptSecret(newToken);
    const newApiSecret = (input.apiKeySecret ?? "").toString().trim();
    if (newApiSecret) row.api_key_secret_encrypted = crypto.encryptSecret(newApiSecret);

    if (existing) {
      const { error } = await supabase.from("twilio_connections").update(row).eq("integration_id", integ.id);
      if (error) throw new Error("twilio-store: cannot update connection");
    } else {
      const { error } = await supabase.from("twilio_connections").insert(row);
      if (error) throw new Error("twilio-store: cannot insert connection");
    }

    // Saving is NOT connecting. When both credentials are now present we move
    // the integration out of 'unconfigured'/'disconnected'/<error> into
    // 'saved' — a state that means "stored, not yet verified". Only a
    // successful Test Connection may set 'connected'/'test_mode', and only an
    // administrator's Disconnect may set 'disconnected'.
    const after = await _loadConnectionRow(integ.id);
    const complete = !!(after?.account_sid && after?.auth_token_encrypted);
    if (complete && integ.status !== "connected" && integ.status !== "test_mode") {
      await supabase.from("app_integrations")
        .update({ status: "saved", enabled: false, last_error: null, updated_at: nowISO })
        .eq("id", integ.id);
    }
    return getConnection();
  }

  // Record the outcome of a Test Connection call (safe error message only).
  async function setConnectionStatus({ status, error = null, testMode = null }) {
    const integ = await _loadIntegrationRow();
    if (!integ) return;
    const ok = status === "connected" || status === "test_mode";
    const patch = {
      status, enabled: ok,
      last_tested_at: new Date().toISOString(),
      last_error: ok ? null : (error || null),      // success always clears the previous error
      updated_at: new Date().toISOString(),
    };
    await supabase.from("app_integrations").update(patch).eq("id", integ.id);
  }

  // Disconnect: disable + wipe usable secrets (leave a tombstone status).
  async function disconnect() {
    const integ = await _loadIntegrationRow();
    if (!integ) return;
    await supabase.from("twilio_connections")
      .update({ auth_token_encrypted: null, api_key_secret_encrypted: null, sms_enabled: false, updated_at: new Date().toISOString() })
      .eq("integration_id", integ.id);
    await supabase.from("app_integrations")
      .update({ enabled: false, status: "disconnected", updated_at: new Date().toISOString() })
      .eq("id", integ.id);
  }

  // SERVER-ONLY: decrypted credentials for building a Twilio client. Never
  // return this shape from a route. Throws if not configured / decrypt fails.
  async function getDecryptedCredentials() {
    const integ = await _loadIntegrationRow();
    if (!integ) throw makeErr("DELIVERY_CONFIGURATION_ERROR", "Twilio is not configured yet.");

    // DELIVERY_DISABLED means "an administrator turned this off" — it is NEVER
    // used to describe a missing or broken credential. Deciding this from the
    // integration status alone was the bug: a fresh row is 'unconfigured' /
    // 'disconnected' by construction, so every missing-token case reported
    // "Twilio integration disconnected" and hid the real cause.
    if (integ.status === "disconnected") {
      throw makeErr("DELIVERY_DISABLED", "Twilio was disconnected by an administrator.");
    }

    const conn = await _loadConnectionRow(integ.id);
    // We deliberately do NOT require integ.enabled here, so a freshly-saved
    // connection can be TESTED before it is marked connected. Each missing
    // piece gets its own precise, sanitized message.
    if (!conn || (!conn.account_sid && !conn.auth_token_encrypted)) {
      throw makeErr("DELIVERY_CONFIGURATION_ERROR", "Twilio is not configured yet.");
    }
    if (!conn.account_sid) {
      throw makeErr("DELIVERY_CONFIGURATION_ERROR", "Twilio Account SID is not configured.");
    }
    if (!conn.auth_token_encrypted) {
      throw makeErr("DELIVERY_CONFIGURATION_ERROR", "Twilio Auth Token is not configured.");
    }
    let authToken;
    try { authToken = crypto.decryptSecret(conn.auth_token_encrypted); }
    catch {
      throw makeErr("DELIVERY_CONFIGURATION_ERROR",
        "The stored Twilio credentials could not be decrypted. Save the connection again.");
    }
    if (!authToken) {
      throw makeErr("DELIVERY_CONFIGURATION_ERROR", "Twilio Auth Token is not configured.");
    }
    return { accountSid: conn.account_sid, authToken, testMode: conn.test_mode, smsEnabled: conn.sms_enabled };
  }

  // ── phone numbers & assignments ──────────────────────────────────────────
  async function saveNumbers(numbers = []) {
    for (const n of numbers) {
      const e164 = normalizeE164(n.phoneNumber);
      if (!e164) continue;
      await supabase.from("twilio_phone_numbers").upsert({
        phone_number: e164, friendly_name: n.friendlyName || null,
        sms_capable: n.smsCapable !== false, voice_capable: !!n.voiceCapable,
        source: n.source || "purchased", environment: ENV,
      }, { onConflict: "phone_number,environment" });
    }
    return listNumbers();
  }
  async function listNumbers() {
    const { data, error } = await supabase.from("twilio_phone_numbers")
      .select("*").eq("environment", ENV).order("phone_number");
    if (error) throw new Error("twilio-store: cannot list numbers");
    return (data || []).map(r => ({
      phoneNumber: r.phone_number, phoneMasked: maskPhone(r.phone_number),
      friendlyName: r.friendly_name, smsCapable: r.sms_capable, voiceCapable: r.voice_capable, source: r.source,
    }));
  }

  async function listAssignments() {
    const { data, error } = await supabase.from("tenant_phone_assignments")
      .select("*").eq("environment", ENV).order("created_at", { ascending: false });
    if (error) throw new Error("twilio-store: cannot list assignments");
    return (data || []).map(_assignmentView);
  }
  function _assignmentView(r) {
    return {
      id: r.id, tenantSlug: r.tenant_slug, phoneNumber: r.phone_number, phoneMasked: maskPhone(r.phone_number),
      messagingServiceSid: r.messaging_service_sid, smsEnabled: r.sms_enabled, voiceEnabled: r.voice_enabled,
      mode: r.mode, status: r.status, lastMessageAt: r.last_message_at, environment: r.environment,
    };
  }

  // Create/replace an assignment. Enforces: number capability + one-tenant-per-
  // number-per-env (unique). `validateTenant`/`numberCapable` injected by caller.
  async function assignNumber(input, { assertTenantExists, assertNumberSmsCapable } = {}) {
    const e164 = normalizeE164(input.phoneNumber);
    if (!e164) throw makeErr("VALIDATION_ERROR", "invalid phone number");
    if (!input.tenantSlug) throw makeErr("VALIDATION_ERROR", "tenantSlug required");
    if (assertTenantExists) { const ok = await assertTenantExists(input.tenantSlug); if (!ok) throw makeErr("VALIDATION_ERROR", "tenant does not exist"); }
    if (input.smsEnabled && assertNumberSmsCapable) { const ok = await assertNumberSmsCapable(e164); if (!ok) throw makeErr("VALIDATION_ERROR", "number is not SMS-capable"); }
    const row = {
      tenant_slug: input.tenantSlug, phone_number: e164,
      messaging_service_sid: input.messagingServiceSid || null,
      sms_enabled: input.smsEnabled !== false, voice_enabled: !!input.voiceEnabled,
      mode: input.mode === "live" ? "live" : "test",
      status: input.status === "disabled" ? "disabled" : "active",
      environment: ENV, updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from("tenant_phone_assignments")
      .upsert(row, { onConflict: "phone_number,environment" }).select().single();
    if (error) throw makeErr("VALIDATION_ERROR", "assignment failed (duplicate/incompatible)");
    return _assignmentView(data);
  }
  async function deleteAssignment(id) {
    const { error } = await supabase.from("tenant_phone_assignments").delete().eq("id", id).eq("environment", ENV);
    if (error) throw new Error("twilio-store: cannot delete assignment");
    return { ok: true };
  }

  // Routing: receiving number → tenant assignment (the ONLY trusted routing key).
  async function resolveTenantByNumber(toNumber) {
    const e164 = normalizeE164(toNumber);
    if (!e164) return null;
    const { data, error } = await supabase.from("tenant_phone_assignments")
      .select("*").eq("phone_number", e164).eq("environment", ENV).eq("status", "active").maybeSingle();
    if (error) throw new Error("twilio-store: cannot resolve tenant by number");
    return data ? _assignmentView(data) : null;
  }
  // tenant → its active sending assignment (for outbound).
  async function resolveSendConfigByTenant(tenantSlug) {
    const { data, error } = await supabase.from("tenant_phone_assignments")
      .select("*").eq("tenant_slug", tenantSlug).eq("environment", ENV).eq("status", "active").eq("sms_enabled", true)
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (error) throw new Error("twilio-store: cannot resolve send config");
    return data ? _assignmentView(data) : null;
  }

  // ── message logs & webhook idempotency ───────────────────────────────────
  async function logMessage(m) {
    const row = {
      tenant_slug: m.tenantSlug, direction: m.direction,
      from_number: m.from || null, to_number: m.to || null,
      body_preview: bodyPreview(m.body), status: m.status || "queued",
      twilio_sid: m.sid || null, error_code: m.errorCode || null, error_message: m.errorMessage || null,
      environment: ENV, updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from("twilio_message_logs").insert(row).select().single();
    if (error) throw new Error("twilio-store: cannot log message");
    return data.id;
  }
  async function updateMessageStatus({ sid, status, errorCode = null, errorMessage = null }) {
    if (!sid) return { updated: 0 };
    const { error } = await supabase.from("twilio_message_logs")
      .update({ status, error_code: errorCode, error_message: errorMessage, updated_at: new Date().toISOString() })
      .eq("twilio_sid", sid).eq("environment", ENV);
    if (error) throw new Error("twilio-store: cannot update message status");
    return { updated: 1 };
  }
  async function listMessages({ tenantSlug = null, direction = null, status = null, limit = 50, offset = 0 } = {}) {
    let q = supabase.from("twilio_message_logs").select("*").eq("environment", ENV);
    if (tenantSlug) q = q.eq("tenant_slug", tenantSlug);
    if (direction) q = q.eq("direction", direction);
    if (status) q = q.eq("status", status);
    q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    const { data, error } = await q;
    if (error) throw new Error("twilio-store: cannot list messages");
    return (data || []).map(r => ({
      id: r.id, createdAt: r.created_at, tenantSlug: r.tenant_slug, direction: r.direction,
      from: maskPhone(r.from_number), to: maskPhone(r.to_number), status: r.status,
      preview: r.body_preview, sid: r.twilio_sid ? crypto.maskSecret(r.twilio_sid, 4) : null,
      errorCode: r.error_code, errorMessage: r.error_message, environment: r.environment,
    }));
  }

  // Idempotent webhook event: returns { firstTime: boolean }. A duplicate
  // (same sid/type/status) is a no-op so Twilio retries never double-process.
  async function recordWebhookEvent({ messageSid, eventType, messageStatus = null, tenantSlug = null }) {
    if (!messageSid) return { firstTime: false, reason: "no_sid" };
    const { error } = await supabase.from("twilio_webhook_events").insert({
      message_sid: messageSid, event_type: eventType, message_status: messageStatus,
      tenant_slug: tenantSlug, environment: ENV,
    });
    if (error) {
      // Unique violation = already processed → not first time.
      if (error.code === "23505") return { firstTime: false, reason: "duplicate" };
      throw new Error("twilio-store: cannot record webhook event");
    }
    return { firstTime: true };
  }

  return {
    environment: ENV,
    getConnection, saveConnection, setConnectionStatus, disconnect, getDecryptedCredentials,
    saveNumbers, listNumbers,
    listAssignments, assignNumber, deleteAssignment, resolveTenantByNumber, resolveSendConfigByTenant,
    logMessage, updateMessageStatus, listMessages, recordWebhookEvent,
  };
}

function makeErr(code, message) { const e = new Error(message); e.code = code; return e; }
