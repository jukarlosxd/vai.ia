// reminders.js
import cron from "node-cron";
import db, { nowISO } from "./db.js";
import { DateTime } from "luxon";

// ADAPTADORES DE ENVÍO (placeholder)
// Implementa cada uno cuando conectes canales reales:
async function sendViaWeb(target, text) {
  // Hoy: no hay push en tiempo real -> log + podrías guardar una "inbox" para mostrar al recargar.
  console.log(`[REMINDER][WEB -> ${target}] ${text}`);
  return true;
}
async function sendViaWhatsApp(target, text) {
  // TODO: Twilio WhatsApp API aquí
  console.log(`[REMINDER][WA -> ${target}] ${text}`);
  return true;
}
async function sendViaInstagram(target, text) {
  // TODO: Instagram Messaging API aquí
  console.log(`[REMINDER][IG -> ${target}] ${text}`);
  return true;
}
async function sendViaSMS(target, text) {
  // TODO: Twilio SMS aquí
  console.log(`[REMINDER][SMS -> ${target}] ${text}`);
  return true;
}

// Router de envío por canal
async function sendByChannel(channel, target, payloadText) {
  switch (channel) {
    case "web":       return sendViaWeb(target, payloadText);
    case "whatsapp":  return sendViaWhatsApp(target, payloadText);
    case "instagram": return sendViaInstagram(target, payloadText);
    case "sms":       return sendViaSMS(target, payloadText);
    default:          return sendViaWeb(target, payloadText);
  }
}

// Levanta pendientes cada minuto
export function startReminderWorker() {
  cron.schedule("* * * * *", async () => {
    const now = DateTime.utc();
    const rows = db.prepare(`
      SELECT * FROM reminders
      WHERE status = 'pending' AND fire_at_utc <= ?
      ORDER BY fire_at_utc ASC
      LIMIT 50
    `).all(now.toISO());

    for (const r of rows) {
      let ok = false, errMsg = null;
      try {
        const payload = r.payload || "";
        ok = await sendByChannel(r.channel, r.target, payload);
      } catch (e) {
        ok = false; errMsg = e?.message || String(e);
      }
      if (ok) {
        db.prepare(`UPDATE reminders SET status='sent', sent_at=?, error=NULL WHERE id=?`)
          .run(nowISO(), r.id);
      } else {
        db.prepare(`UPDATE reminders SET status='failed', error=? WHERE id=?`)
          .run(errMsg || "send error", r.id);
      }
    }
  });
}

// Utilidad: crear recordatorio
export function createReminder({ booking_id, fire_at_dt_utc, channel, target, payload }) {
  db.prepare(`
    INSERT INTO reminders (booking_id, fire_at_utc, channel, target, payload, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    booking_id,
    fire_at_dt_utc.toISO(),
    channel,
    target,
    payload,
    nowISO()
  );
}
