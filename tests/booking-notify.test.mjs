// Tests for the shared booking-confirmation helper (booking-notify.js).
// Exercises the REAL functions used by index.js — no logic is copied.
//
// Core invariant: a communication (SMTP) failure must NEVER promote a pending
// booking into a CONFIRMED appointment when confirmation is required. Only an
// explicit "none" mode books without confirmation.
//
// Run: node tests/booking-notify.test.mjs
import assert from "node:assert";
import {
  handleBookingConfirmation,
  bookingConfirmationMode,
  retryBookingNotification,
  readDeliveryFields,
  writeDeliveryFields,
} from "../booking-notify.js";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "—", e.message); fail++; }
}

// In-memory harness: real functions, fake collaborators.
function makeDeps({ smtpReady, sendMailImpl } = {}) {
  const store = { demo: [] };
  const pendings = {};
  const calls = { sendMail: 0, saveAppointments: 0, savePending: [], deletePending: [] };
  const deps = {
    smtpReady,
    sendMail: async (m) => { calls.sendMail++; if (sendMailImpl) return sendMailImpl(m); return { ok: true }; },
    loadAppointments: async (slug) => (store[slug] ? [...store[slug]] : []),
    saveAppointments: async (slug, list) => { calls.saveAppointments++; store[slug] = [...list]; },
    savePending: async (slug, p) => { calls.savePending.push(p); pendings[p.token] = p; },
    deletePending: async (token) => { calls.deletePending.push(token); delete pendings[token]; },
    randomToken: () => "tok-fixed",
  };
  return { deps, store, pendings, calls };
}

const pending = (over = {}) => ({
  token: "pt1", id: "appt_1", booking_request_id: "req-1",
  customer_name: "Ana", service: "Corte",
  email: "ana@test.com", phone: "8010000001",
  start: "2026-08-01T22:00:00.000Z", end: "2026-08-01T22:30:00.000Z",
  notes: "", subject: "Confirma", text: "t", html: "<b>h</b>", ...over,
});

console.log("── booking-notify (confirmation policy + SMTP fallback) ──");

await t("Modo por defecto = required; solo 'none' explícito lo desactiva; SMTP no lo decide", () => {
  assert.equal(bookingConfirmationMode({}, {}), "required");
  assert.equal(bookingConfirmationMode({ BOOKING_CONFIRMATION_MODE: "none" }, {}), "none");
  assert.equal(bookingConfirmationMode({}, { vars: { booking_confirmation_mode: "NONE" } }), "none");
  assert.equal(bookingConfirmationMode({}, { booking_confirmation_mode: "required" }), "required");
  assert.equal(bookingConfirmationMode({ BOOKING_CONFIRMATION_MODE: "" }, {}), "required");
  assert.equal(bookingConfirmationMode({ BOOKING_CONFIRMATION_MODE: "sí" }, {}), "required"); // unknown -> required
});

await t("1) Confirmación obligatoria + SMTP exitoso → pending, email enviado, cita NO confirmada aún", async () => {
  const { deps, store, calls } = makeDeps({ smtpReady: true });
  const r = await handleBookingConfirmation(deps, { slug: "demo", pending: pending(), isES: true, mode: "required" });
  assert.equal(r.emailSent, true);
  assert.equal(r.appointmentCreated, false);
  assert.equal(r.appointmentConfirmed, false);
  assert.equal(r.appointmentError, "PENDING_CONFIRMATION");
  assert.equal(calls.sendMail, 1);
  assert.equal(store.demo.length, 0);           // materializes only via the /confirm link
  assert.equal(calls.deletePending.length, 0);  // token kept until the link is used
});

await t("2) Confirmación obligatoria + SMTP deshabilitado → pending permanece, SIN cita confirmada, notification_failed", async () => {
  const { deps, store, calls } = makeDeps({ smtpReady: false });
  const r = await handleBookingConfirmation(deps, { slug: "demo", pending: pending(), isES: true, mode: "required" });
  assert.equal(r.emailSent, false);
  assert.equal(r.appointmentCreated, false);
  assert.equal(r.appointmentConfirmed, false);
  assert.equal(r.deliveryStatus, "notification_failed");
  assert.equal(r.retryable, true);
  assert.equal(store.demo.length, 0);           // NO confirmed appointment created
  assert.equal(calls.deletePending.length, 0);  // pending token NOT deleted
  assert.equal(calls.savePending.length, 1);    // delivery status recorded on the retained pending
  assert.equal(calls.savePending[0].deliveryStatus, "notification_failed");
  assert(/no está confirmad|no.*confirmad/i.test(r.reply), "reply must state the appointment is NOT confirmed: " + r.reply);
});

await t("3) Confirmación obligatoria + SMTP lanza → mismo comportamiento, retry permitido", async () => {
  const { deps, store, calls } = makeDeps({ smtpReady: true, sendMailImpl: () => { throw new Error("smtp 554 rejected"); } });
  const r = await handleBookingConfirmation(deps, { slug: "demo", pending: pending(), isES: false, mode: "required" });
  assert.equal(r.emailSent, false);
  assert.equal(r.appointmentCreated, false);
  assert.equal(r.appointmentConfirmed, false);
  assert.equal(r.deliveryStatus, "notification_failed");
  assert.equal(r.retryable, true);
  assert.equal(calls.sendMail, 1);              // attempted once, failed, did not throw
  assert.equal(store.demo.length, 0);
  assert.equal(calls.deletePending.length, 0);
  assert(/not confirmed/i.test(r.reply), "reply must state the appointment is NOT confirmed: " + r.reply);
});

await t("4) Confirmación opcional (mode=none) + SMTP deshabilitado → cita confirmada, notificación no requerida", async () => {
  const { deps, store } = makeDeps({ smtpReady: false });
  const r = await handleBookingConfirmation(deps, { slug: "demo", pending: pending(), isES: true, mode: "none" });
  assert.equal(r.appointmentCreated, true);
  assert.equal(r.appointmentConfirmed, true);
  assert.equal(r.emailSent, false);
  assert.equal(r.deliveryStatus, "not_required");     // SMTP off + no-confirmation tenant → not required
  assert.equal(r.appointmentError, null);
  assert.equal(store.demo.length, 1);
  assert.equal(store.demo[0].confirmed, true);
  assert(/confirmad|confirmed/i.test(r.reply), "none-mode reply should state the booking is confirmed");
});

await t("4c) Confirmación opcional (mode=none) + SMTP lanza → cita confirmada, notification_failed", async () => {
  const { deps, store } = makeDeps({ smtpReady: true, sendMailImpl: () => { throw new Error("network"); } });
  const r = await handleBookingConfirmation(deps, { slug: "demo", pending: pending(), isES: true, mode: "none" });
  assert.equal(r.appointmentConfirmed, true);
  assert.equal(r.deliveryStatus, "notification_failed");
  assert.equal(r.appointmentError, "NOTIFICATION_FAILED");
  assert.equal(store.demo.length, 1);
});

await t("4b) Confirmación opcional (mode=none) + SMTP exitoso → confirmada + email enviado", async () => {
  const { deps, store, calls } = makeDeps({ smtpReady: true });
  const r = await handleBookingConfirmation(deps, { slug: "demo", pending: pending(), isES: true, mode: "none" });
  assert.equal(r.appointmentConfirmed, true);
  assert.equal(r.emailSent, true);
  assert.equal(store.demo.length, 1);
  assert.equal(calls.deletePending.length, 1); // pending link retired after direct booking
});

await t("5) Retry del MISMO booking request (mode=none) → no duplica", async () => {
  const { deps, store } = makeDeps({ smtpReady: false });
  const p = pending();
  const r1 = await handleBookingConfirmation(deps, { slug: "demo", pending: p, isES: true, mode: "none" });
  const r2 = await handleBookingConfirmation(deps, { slug: "demo", pending: p, isES: true, mode: "none" });
  assert.equal(r1.persisted, true);
  assert.equal(r2.persisted, false);   // same stable identity → deduped
  assert.equal(store.demo.length, 1);
});

await t("6) Dos solicitudes DISTINTAS, mismo cliente y hora (mode=none) → no colisionan", async () => {
  const { deps, store } = makeDeps({ smtpReady: false });
  const p1 = pending({ id: "appt_1", token: "pt1", booking_request_id: "req-1" });
  const p2 = pending({ id: "appt_2", token: "pt2", booking_request_id: "req-2" }); // same email + start
  await handleBookingConfirmation(deps, { slug: "demo", pending: p1, isES: true, mode: "none" });
  await handleBookingConfirmation(deps, { slug: "demo", pending: p2, isES: true, mode: "none" });
  assert.equal(store.demo.length, 2, "distinct attempts must NOT be merged by a weak recipient+time dedup");
});

// ── TEST GROUP: delivery-status tracking + safe retry ────────────────────────
// A faithful round-trip harness: savePending maps to DB columns via
// writeDeliveryFields (snake_case, like index.js) and loadPending maps back via
// readDeliveryFields (like mapPendingRow), so tests exercise the real mapping.
{
  function deliveryDeps({ smtpReady, sendMailImpl } = {}) {
    const store = { demo: [] };   // appointments
    const rows = {};              // token -> DB-shaped pending_bookings row
    const calls = { sendMail: 0, savePending: 0 };
    const deps = {
      smtpReady,
      sendMail: async (m) => { calls.sendMail++; if (sendMailImpl) return sendMailImpl(m); return { ok: true }; },
      loadAppointments: async (slug) => (store[slug] ? [...store[slug]] : []),
      saveAppointments: async (slug, list) => { store[slug] = [...list]; },
      deletePending: async (token) => { delete rows[token]; },
      randomToken: () => "tok-fixed",
      savePending: async (slug, p) => {
        calls.savePending++;
        rows[p.token] = {
          ...(rows[p.token] || {}),
          token: p.token, tenant_slug: slug, email: p.email,
          subject: p.subject, text: p.text, html: p.html,
          appt_id: p.id, customer_name: p.customer_name, service: p.service,
          start_at: p.start, end_at: p.end,
          ...writeDeliveryFields(p),   // snake_case, exactly like index.js
        };
      },
      loadPending: async (token) => {
        const r = rows[token];
        if (!r) return null;
        return {
          token: r.token, slug: r.tenant_slug, email: r.email,
          subject: r.subject, text: r.text, html: r.html,
          id: r.appt_id, customer_name: r.customer_name, service: r.service,
          start: r.start_at, end: r.end_at,
          ...readDeliveryFields(r),   // camelCase, exactly like mapPendingRow
        };
      },
    };
    return { deps, store, rows, calls };
  }
  const p = (over = {}) => ({
    token: "pt1", id: "appt_1", booking_request_id: "req-1",
    customer_name: "Ana", service: "Corte", email: "ana@test.com", phone: "8010000001",
    start: "2026-08-01T22:00:00.000Z", end: "2026-08-01T22:30:00.000Z",
    subject: "Confirma", text: "t", html: "<b>h</b>", ...over,
  });

  console.log("\n── delivery-status tracking + retry ──");

  await t("1) Fila antigua sin columnas nuevas → defaults seguros al leer", () => {
    const d = readDeliveryFields({ token: "old", tenant_slug: "demo" });
    assert.equal(d.deliveryStatus, "pending");
    assert.equal(d.deliveryAttempts, 0);
    assert.equal(d.lastDeliveryAttemptAt, null);
    assert.equal(d.deliveryErrorCode, null);
  });

  await t("2) Pending nuevo (sin campos de entrega) → se escribe como 'pending', 0 intentos", () => {
    const w = writeDeliveryFields(p());
    assert.equal(w.delivery_status, "pending");
    assert.equal(w.delivery_attempts, 0);
    assert.equal(w.last_delivery_attempt_at, null);
    assert.equal(w.delivery_error_code, null);
  });

  await t("3) required + SMTP exitoso → delivery_status='sent'", async () => {
    const { deps, rows } = deliveryDeps({ smtpReady: true });
    const r = await handleBookingConfirmation(deps, { slug: "demo", pending: p(), isES: true, mode: "required" });
    assert.equal(r.deliveryStatus, "sent");
    assert.equal(rows["pt1"].delivery_status, "sent");
    assert.equal(rows["pt1"].delivery_attempts, 1);
  });

  await t("4) required + SMTP deshabilitado → 'notification_failed' (code SMTP_DISABLED)", async () => {
    const { deps, rows } = deliveryDeps({ smtpReady: false });
    const r = await handleBookingConfirmation(deps, { slug: "demo", pending: p(), isES: true, mode: "required" });
    assert.equal(r.deliveryStatus, "notification_failed");
    assert.equal(rows["pt1"].delivery_status, "notification_failed");
    assert.equal(rows["pt1"].delivery_error_code, "SMTP_DISABLED");
  });

  await t("5) required + SMTP lanza → 'notification_failed' (code SEND_FAILED)", async () => {
    const { deps, rows } = deliveryDeps({ smtpReady: true, sendMailImpl: () => { throw new Error("535 auth failed pass=SECRET123"); } });
    const r = await handleBookingConfirmation(deps, { slug: "demo", pending: p(), isES: false, mode: "required" });
    assert.equal(r.deliveryStatus, "notification_failed");
    assert.equal(rows["pt1"].delivery_error_code, "SEND_FAILED");
  });

  await t("6) delivery_attempts incrementa con cada intento (1 → 2 → 3)", async () => {
    const { deps, rows } = deliveryDeps({ smtpReady: false });
    await handleBookingConfirmation(deps, { slug: "demo", pending: p(), isES: true, mode: "required" });
    assert.equal(rows["pt1"].delivery_attempts, 1);
    await retryBookingNotification(deps, { token: "pt1" });
    assert.equal(rows["pt1"].delivery_attempts, 2);
    await retryBookingNotification(deps, { token: "pt1" });
    assert.equal(rows["pt1"].delivery_attempts, 3);
  });

  await t("7) Retry exitoso → 'sent' (persistido)", async () => {
    const { deps, rows } = deliveryDeps({ smtpReady: true });
    rows["pt1"] = { token: "pt1", tenant_slug: "demo", email: "ana@test.com", subject: "s", text: "t", html: "h", delivery_status: "notification_failed", delivery_attempts: 1 };
    const r = await retryBookingNotification(deps, { token: "pt1" });
    assert.equal(r.ok, true);
    assert.equal(r.deliveryStatus, "sent");
    assert.equal(r.deliveryAttempts, 2);
    assert.equal(rows["pt1"].delivery_status, "sent");
  });

  await t("8) Retry fallido no crea otro pending (mismo token, sin duplicar)", async () => {
    const { deps, rows } = deliveryDeps({ smtpReady: false });
    rows["pt1"] = { token: "pt1", tenant_slug: "demo", email: "ana@test.com", subject: "s", delivery_status: "notification_failed", delivery_attempts: 1 };
    await retryBookingNotification(deps, { token: "pt1" });
    assert.equal(Object.keys(rows).length, 1);       // no new pending row
    assert.equal(rows["pt1"].delivery_status, "notification_failed");
  });

  await t("9) El token se conserva tras el retry", async () => {
    const { deps, rows } = deliveryDeps({ smtpReady: false });
    rows["pt1"] = { token: "pt1", tenant_slug: "demo", email: "ana@test.com", subject: "s", delivery_status: "notification_failed", delivery_attempts: 1 };
    await retryBookingNotification(deps, { token: "pt1" });
    assert.ok(rows["pt1"], "pending still present");
    assert.equal(rows["pt1"].token, "pt1");          // same token, not regenerated
  });

  await t("9b) Retry cuando ya está 'sent' → no reenvía (sin email duplicado)", async () => {
    const { deps, rows, calls } = deliveryDeps({ smtpReady: true });
    rows["pt1"] = { token: "pt1", tenant_slug: "demo", email: "ana@test.com", subject: "s", delivery_status: "sent", delivery_attempts: 1 };
    const r = await retryBookingNotification(deps, { token: "pt1" });
    assert.equal(r.alreadySent, true);
    assert.equal(calls.sendMail, 0);                 // no duplicate e-mail
  });

  await t("9c) Retry de un token inexistente → falla de forma segura", async () => {
    const { deps } = deliveryDeps({ smtpReady: true });
    const r = await retryBookingNotification(deps, { token: "nope" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not_found");
  });

  await t("10) Nunca se guarda el error crudo de SMTP (solo un code)", async () => {
    const { deps, rows } = deliveryDeps({ smtpReady: true, sendMailImpl: () => { throw new Error("535 auth failed pass=SECRET123 token=abc"); } });
    await handleBookingConfirmation(deps, { slug: "demo", pending: p(), isES: true, mode: "required" });
    const code = rows["pt1"].delivery_error_code;
    assert.equal(code, "SEND_FAILED");
    assert(!/SECRET123|535|token=/.test(code || ""), "raw provider text must never be stored");
  });

  await t("11) required NUNCA crea cita confirmada por fallo de email", async () => {
    const { deps, store } = deliveryDeps({ smtpReady: false });
    const r = await handleBookingConfirmation(deps, { slug: "demo", pending: p(), isES: true, mode: "required" });
    assert.equal(r.appointmentConfirmed, false);
    assert.equal(store.demo.length, 0);
  });

  await t("12) none mantiene la cita confirmada aunque la notificación falle", async () => {
    const { deps, store } = deliveryDeps({ smtpReady: true, sendMailImpl: () => { throw new Error("network"); } });
    const r = await handleBookingConfirmation(deps, { slug: "demo", pending: p(), isES: true, mode: "none" });
    assert.equal(r.appointmentConfirmed, true);
    assert.equal(r.deliveryStatus, "notification_failed");
    assert.equal(store.demo.length, 1);
    assert.equal(store.demo[0].confirmed, true);
  });

  await t("12b) none + SMTP off (no requerido) → delivery_status='not_required', cita confirmada", async () => {
    const { deps, store } = deliveryDeps({ smtpReady: false });
    const r = await handleBookingConfirmation(deps, { slug: "demo", pending: p(), isES: true, mode: "none" });
    assert.equal(r.appointmentConfirmed, true);
    assert.equal(r.deliveryStatus, "not_required");
    assert.equal(store.demo.length, 1);
  });
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
