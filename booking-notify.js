// booking-notify.js
// Shared booking-confirmation handling with SMTP-aware fallback.
// Imported by index.js (production) AND the test suite, so both exercise the
// SAME code path.
//
// The public receptionist defaults to a DOUBLE OPT-IN: it stores a pending
// booking and e-mails a confirmation link; the appointment is materialized
// (confirmed) only when the customer clicks that link.
//
// A confirmation e-mail that cannot be delivered must NEVER silently promote a
// pending booking into a confirmed appointment — that would confirm bookings the
// customer never approved. Behaviour:
//
//   mode = "required" (DEFAULT): if e-mail is unconfigured or the send fails,
//     KEEP the pending booking and its token, record delivery status
//     "notification_failed", create NO appointment, and tell the customer the
//     request was registered but the confirmation link could not be sent (a
//     later retry is allowed). Never claim the appointment is confirmed.
//
//   mode = "none" (EXPLICIT per-tenant, or BOOKING_CONFIRMATION_MODE=none): the
//     tenant allows booking without confirmation, so the appointment is created
//     and confirmed by that allowed flow; an e-mail failure then only affects the
//     notification. SMTP being unconfigured is NOT, by itself, a signal that
//     confirmation is optional — only explicit configuration is.
//
// Idempotency is keyed on a STABLE booking-attempt identity
// (booking_request_id | idempotency_key | token | id), never on recipient+start,
// so two different bookings by the same customer at the same time do not collide
// and a retry of the same attempt does not duplicate.
//
// Injected collaborators (no hidden I/O; fully unit-testable):
//   smtpReady: boolean
//   sendMail({ to, subject, text, html }) -> Promise           (may reject)
//   loadAppointments(slug) -> Promise<Array>
//   saveAppointments(slug, list) -> Promise
//   savePending(slug, pending) -> Promise                       (optional)
//   deletePending(token) -> Promise                             (optional)
//   randomToken() -> string                                     (optional)

// Confirmation policy. Default is the safe double opt-in; only an EXPLICIT
// "none" turns it off. An unset/unknown value is treated as "required".
export function bookingConfirmationMode(env = {}, cfg = {}) {
  const raw = (
    cfg.booking_confirmation_mode ??
    (cfg.vars && cfg.vars.booking_confirmation_mode) ??
    env.BOOKING_CONFIRMATION_MODE ??
    ""
  ).toString().trim().toLowerCase();
  return raw === "none" ? "none" : "required";
}

function attemptIdentity(pending) {
  return pending.booking_request_id || pending.idempotency_key || pending.token || pending.id || null;
}

// Allowed delivery states. "pending" = not yet attempted; "sent" = delivered;
// "notification_failed" = attempted but could not deliver; "not_required" = the
// tenant does not need a confirmation e-mail (mode "none" with SMTP off).
export const DELIVERY_STATES = ["pending", "sent", "notification_failed", "not_required"];

// Read side: normalize a raw pending_bookings row into delivery fields with
// backward-compatible defaults, so OLD rows lacking these columns still work.
export function readDeliveryFields(row = {}) {
  // Accept both the Supabase column names (snake_case) and the JSON-fallback
  // pending object shape (camelCase); OLD rows lacking either → safe defaults.
  const s = row.delivery_status ?? row.deliveryStatus;
  const attempts = row.delivery_attempts ?? row.deliveryAttempts;
  return {
    deliveryStatus:        DELIVERY_STATES.includes(s) ? s : "pending",
    deliveryAttempts:      Number.isInteger(attempts) ? attempts : 0,
    lastDeliveryAttemptAt: row.last_delivery_attempt_at ?? row.lastDeliveryAttemptAt ?? null,
    deliveryErrorCode:     row.delivery_error_code ?? row.deliveryErrorCode ?? null,
  };
}

// Write side: map a pending object to the DB columns. delivery_error_code is a
// short machine CODE only — never a raw provider message/secret (hard-capped).
export function writeDeliveryFields(pending = {}) {
  const status = DELIVERY_STATES.includes(pending.deliveryStatus) ? pending.deliveryStatus : "pending";
  return {
    delivery_status:          status,
    delivery_attempts:        Number.isInteger(pending.deliveryAttempts) ? pending.deliveryAttempts : 0,
    last_delivery_attempt_at: pending.lastDeliveryAttemptAt ?? null,
    delivery_error_code:      pending.deliveryErrorCode ? String(pending.deliveryErrorCode).slice(0, 40) : null,
  };
}

export async function handleBookingConfirmation(deps, { slug, pending, isES = true, mode = "required" }) {
  const { smtpReady, sendMail } = deps;

  // 1) Attempt the confirmation e-mail — only if SMTP is actually configured.
  let emailSent = false, attempted = false;
  if (smtpReady) {
    attempted = true;
    try {
      await sendMail({ to: pending.email, subject: pending.subject, text: pending.text, html: pending.html });
      emailSent = true;
    } catch (e) {
      // Only a short machine code is ever recorded — never the raw provider text.
      console.error("[BOOKING] confirmation e-mail failed:", e?.message || e);
    }
  }
  const nowISO = new Date().toISOString();
  // A notification is always attempted in "required" mode (the confirmation link
  // is mandatory), so it counts even when SMTP is disabled. In "none" mode a
  // notification is only attempted when SMTP is actually configured.
  const attempts = (pending.deliveryAttempts ?? 0) + ((mode === "required" || smtpReady) ? 1 : 0);

  // 2) CONFIRMATION-OPTIONAL tenant → create + confirm the appointment now
  //    (idempotent). An e-mail failure only affects the notification.
  if (mode === "none") {
    const { persisted } = await persistConfirmedOnce(deps, slug, pending);
    if (pending.token && deps.deletePending) { try { await deps.deletePending(pending.token); } catch { /* best-effort */ } }
    // not_required: tenant needs no confirmation e-mail and none was attempted.
    const deliveryStatus = emailSent ? "sent" : (attempted ? "notification_failed" : "not_required");
    return {
      mode: "none",
      appointmentCreated: true,
      appointmentConfirmed: true,
      persisted,
      emailSent,
      deliveryStatus,
      deliveryAttempts: attempts,
      appointmentError: deliveryStatus === "notification_failed" ? "NOTIFICATION_FAILED" : null,
      reply: emailSent
        ? (isES ? "¡Listo! Tu cita quedó confirmada ✅ y te envié la confirmación por correo."
                : "Done! Your appointment is confirmed ✅ and I've emailed you the details.")
        : (isES ? "Tu cita quedó confirmada ✅. No pudimos enviarte el correo de confirmación, pero tu reserva está registrada."
                : "Your appointment is confirmed ✅. We couldn't email the confirmation, but your booking is saved."),
    };
  }

  // 3) CONFIRMATION-REQUIRED (default double opt-in).
  if (emailSent) {
    // Appointment stays pending; it materializes only via the /confirm link.
    // Record delivery = sent on the retained pending (idempotent upsert by token).
    if (deps.savePending) {
      try {
        await deps.savePending(slug, { ...pending, deliveryStatus: "sent", deliveryAttempts: attempts, lastDeliveryAttemptAt: nowISO, deliveryErrorCode: null });
      } catch (e) { console.error("[BOOKING] could not mark sent:", e?.message || e); }
    }
    return {
      mode: "required",
      appointmentCreated: false,
      appointmentConfirmed: false,
      emailSent: true,
      deliveryStatus: "sent",
      deliveryAttempts: attempts,
      appointmentError: "PENDING_CONFIRMATION",
      reply: isES
        ? "Perfecto ✅ Te envié el correo para confirmar. Revisa tu inbox y toca **Confirmar cita**."
        : "Perfect ✅ I sent the confirmation email. Check your inbox and tap **Confirm appointment**.",
    };
  }

  // 3b) E-mail could not be delivered under required confirmation:
  //     keep the pending booking + token, record notification_failed, create NO
  //     appointment, allow a later retry, and never claim confirmation.
  const errorCode = smtpReady ? "SEND_FAILED" : "SMTP_DISABLED";
  if (deps.savePending) {
    try {
      await deps.savePending(slug, { ...pending, deliveryStatus: "notification_failed", deliveryAttempts: attempts, lastDeliveryAttemptAt: nowISO, deliveryErrorCode: errorCode });
    } catch (e) { console.error("[BOOKING] could not mark notification_failed:", e?.message || e); }
  }
  return {
    mode: "required",
    appointmentCreated: false,
    appointmentConfirmed: false,
    emailSent: false,
    deliveryStatus: "notification_failed",
    deliveryAttempts: attempts,
    deliveryErrorCode: errorCode,
    retryable: true,
    pendingRetained: true,
    appointmentError: "NOTIFICATION_FAILED",
    reply: isES
      ? "Tu solicitud de cita quedó registrada, pero no pudimos enviarte el enlace de confirmación en este momento. Intentaremos reenviarlo pronto; tu cita aún no está confirmada."
      : "Your booking request was saved, but we couldn't send the confirmation link right now. We'll try again shortly; your appointment is not confirmed yet.",
  };
}

// Retry the confirmation notification for an existing pending booking.
// Reusable + safe: keyed on the stable token, never creates another pending,
// never regenerates the token, never confirms the appointment, and never
// re-sends after a successful delivery (no duplicate e-mails). Fails safe.
export async function retryBookingNotification(deps, { token, buildEmail } = {}) {
  const { loadPending, savePending, smtpReady, sendMail } = deps;
  if (!token) return { ok: false, reason: "no_token" };
  const pending = await loadPending(token);
  if (!pending) return { ok: false, reason: "not_found" };

  const current = readDeliveryFields(pending);
  // Already delivered → do NOT re-send (no duplicate e-mail), no state change.
  if (current.deliveryStatus === "sent") {
    return { ok: true, alreadySent: true, deliveryStatus: "sent", deliveryAttempts: current.deliveryAttempts, token };
  }

  const mail = buildEmail ? buildEmail(pending)
    : { subject: pending.subject, text: pending.text, html: pending.html };

  let emailSent = false, errorCode = null;
  if (smtpReady) {
    try { await sendMail({ to: pending.email, ...mail }); emailSent = true; }
    catch (e) { errorCode = "SEND_FAILED"; console.error("[BOOKING] retry send failed:", e?.message || e); }
  } else {
    errorCode = "SMTP_DISABLED";
  }

  const attempts = current.deliveryAttempts + 1;
  const status = emailSent ? "sent" : "notification_failed";
  const slug = pending.slug || pending.tenant_slug;
  try {
    // Upsert by the SAME token — never a new pending, never a new token.
    await savePending(slug, { ...pending, deliveryStatus: status, deliveryAttempts: attempts, lastDeliveryAttemptAt: new Date().toISOString(), deliveryErrorCode: errorCode });
  } catch (e) {
    console.error("[BOOKING] retry could not persist status:", e?.message || e);
    return { ok: false, reason: "persist_failed" };
  }

  return { ok: emailSent, deliveryStatus: status, deliveryAttempts: attempts, deliveryErrorCode: errorCode, token };
}

// Persist a confirmed appointment at most once, keyed on the stable booking
// attempt identity (never recipient+start).
async function persistConfirmedOnce(deps, slug, pending) {
  const { loadAppointments, saveAppointments, randomToken } = deps;
  const attemptId = attemptIdentity(pending);
  const list = await loadAppointments(slug);
  const duplicate = list.some(a =>
    (pending.id && a.id === pending.id) ||
    (attemptId && a.booking_attempt_id && a.booking_attempt_id === attemptId));
  if (duplicate) return { persisted: false };

  list.push({
    id: pending.id,
    booking_attempt_id: attemptId,
    title: pending.service || "Appointment",
    service: pending.service || "",
    customer_name: pending.customer_name || "",
    client_name: pending.customer_name || "",
    start: pending.start,
    end: pending.end,
    email: pending.email || null,
    phone: pending.phone || null,
    notes: pending.notes || "",
    confirmed: true,
    cancel_token: pending.cancel_token || (randomToken ? randomToken() : ""),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await saveAppointments(slug, list);
  return { persisted: true };
}
