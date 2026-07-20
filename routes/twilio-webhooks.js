// routes/twilio-webhooks.js
// Signed inbound-SMS and status-callback webhooks for the managed Twilio
// integration. Mounted from index.js. Reuses the central store for connection
// credentials, tenant routing, message logging and idempotency.
//
// SECURITY:
//   * Every request's X-Twilio-Signature is validated against the connection's
//     decrypted Auth Token, using the EXACT public URL Twilio called
//     (reconstructed from X-Forwarded-Proto / X-Forwarded-Host, honoring the
//     Render HTTPS proxy — never http://localhost).
//   * The tenant is resolved ONLY from the receiving number (To) — never from a
//     tenant field in the payload.
//   * Idempotent by MessageSid (a retried delivery is a safe no-op).
//   * Internal errors are never leaked in the TwiML response.
//
// deps: { app, store, twilioSdk, runReceptionist({slug,from,body})->Promise<string>,
//         smsDeliver({tenantSlug,to,body})->Promise, rateLimit, environment }

const EMPTY_TWIML = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>";

// Reconstruct the exact public URL Twilio used (proxy-aware). Twilio computes
// the signature over THIS string, so a mismatch (e.g. http vs https, internal
// host) causes false rejections.
export function buildPublicWebhookUrl(req, override) {
  if (override) return override.replace(/\/$/, "") + (req.originalUrl || req.url || "");
  const xfProto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = xfProto || (req.secure ? "https" : "http");
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}${req.originalUrl || req.url || ""}`;
}

function xml(res, status, body = EMPTY_TWIML) {
  return res.status(status).type("text/xml").send(body);
}

export function mountTwilioWebhooks(app, deps) {
  const {
    store, twilioSdk, runReceptionist, smsDeliver, rateLimit,
    environment = "staging",
    // Optional fixed public base (e.g. the Render staging URL). When set, the
    // signature URL is built from it + originalUrl (robust behind proxies).
    publicBaseUrl = process.env.PUBLIC_BASE_URL || null,
  } = deps;

  const limiter = rateLimit({
    windowMs: 60 * 1000, max: 120,   // generous: Twilio retries legitimately
    standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => xml(res, 429),
  });

  async function verifySignature(req) {
    let creds;
    try { creds = await store.getDecryptedCredentials(); } catch { return { ok: false, reason: "not_configured" }; }
    const url = buildPublicWebhookUrl(req, publicBaseUrl);
    const sig = req.headers["x-twilio-signature"];
    if (!sig) return { ok: false, reason: "missing_signature" };
    const valid = twilioSdk.validateRequest(creds.authToken, sig, url, req.body || {});
    return valid ? { ok: true, creds } : { ok: false, reason: "invalid_signature" };
  }

  // ── Inbound SMS ────────────────────────────────────────────────────────────
  app.post("/webhooks/twilio/sms/incoming", limiter, async (req, res) => {
    try {
      const p = req.body || {};
      const sig = await verifySignature(req);
      if (!sig.ok) return xml(res, 403);   // missing/invalid signature or unconfigured

      const to = p.To, from = p.From, sid = p.MessageSid, body = String(p.Body || "");
      if (!sid || !to) return xml(res, 200);   // malformed → ack, do nothing

      // Route strictly by receiving number.
      const assign = await store.resolveTenantByNumber(to);
      if (!assign) { console.warn("[TWILIO-WH] inbound to unassigned number"); return xml(res, 200); }

      // Idempotency: a retried MessageSid is a no-op.
      const ev = await store.recordWebhookEvent({ messageSid: sid, eventType: "inbound", tenantSlug: assign.tenantSlug });
      if (!ev.firstTime) return xml(res, 200);

      // Persist inbound.
      await store.logMessage({ tenantSlug: assign.tenantSlug, direction: "inbound", from, to, body, status: "received", sid });

      // Hand to the tenant's PUBLIC AI Receptionist (NOT the internal Business
      // Assistant). Generate a reply and send it back via the managed sender
      // (simulated in test mode). Failures are logged, not leaked.
      if (assign.smsEnabled) {
        let reply = "";
        try { reply = await runReceptionist({ slug: assign.tenantSlug, from, body }); } catch (e) { console.error("[TWILIO-WH] receptionist:", e.message); }
        if (reply && reply.trim()) {
          try { await smsDeliver({ tenantSlug: assign.tenantSlug, to: from, body: reply.trim() }); }
          catch (e) { console.error("[TWILIO-WH] reply send:", e.message); }
        }
      }
      // We send the reply via the REST API (to control logging), so ack empty TwiML.
      return xml(res, 200);
    } catch (e) { console.error("[TWILIO-WH] incoming error:", e.message); return xml(res, 200); }
  });

  // ── Status callback (outbound delivery updates) ────────────────────────────
  app.post("/webhooks/twilio/sms/status", limiter, async (req, res) => {
    try {
      const p = req.body || {};
      const sig = await verifySignature(req);
      if (!sig.ok) return res.status(403).type("text/xml").send(EMPTY_TWIML);

      const sid = p.MessageSid, status = p.MessageStatus;
      if (!sid || !status) return res.status(200).end();

      // Idempotent by (sid, status). updateMessageStatus is scoped to this sid
      // (globally unique) within the environment — it cannot touch another
      // tenant's message.
      const ev = await store.recordWebhookEvent({ messageSid: sid, eventType: "status", messageStatus: status });
      if (!ev.firstTime) return res.status(200).end();

      const errorCode = p.ErrorCode ? String(p.ErrorCode) : null;
      const errorMessage = errorCode ? ("Carrier/Twilio error " + errorCode) : null;   // sanitized (no raw payload)
      await store.updateMessageStatus({ sid, status, errorCode, errorMessage });
      return res.status(200).end();
    } catch (e) { console.error("[TWILIO-WH] status error:", e.message); return res.status(200).end(); }
  });

  console.log("[TWILIO-WH] webhooks mounted at /webhooks/twilio/sms/{incoming,status}");
}
