// Tests for the shared booking-confirmation helper (booking-notify.js).
// Exercises the REAL functions used by index.js — no logic is copied.
//
// Core invariant: a communication (SMTP) failure must NEVER promote a pending
// booking into a CONFIRMED appointment when confirmation is required. Only an
// explicit "none" mode books without confirmation.
//
// Run: node tests/booking-notify.test.mjs
import assert from "node:assert";
import { handleBookingConfirmation, bookingConfirmationMode } from "../booking-notify.js";

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

await t("4) Confirmación opcional (mode=none) + SMTP falla → cita creada una vez, notificación fallida", async () => {
  const { deps, store } = makeDeps({ smtpReady: false });
  const r = await handleBookingConfirmation(deps, { slug: "demo", pending: pending(), isES: true, mode: "none" });
  assert.equal(r.appointmentCreated, true);
  assert.equal(r.appointmentConfirmed, true);
  assert.equal(r.emailSent, false);
  assert.equal(r.appointmentError, "NOTIFICATION_FAILED");
  assert.equal(store.demo.length, 1);
  assert.equal(store.demo[0].confirmed, true);
  assert(/confirmad|confirmed/i.test(r.reply), "none-mode reply should state the booking is confirmed");
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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
