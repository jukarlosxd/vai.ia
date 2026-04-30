// mailer.js
import nodemailer from "nodemailer";

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM
} = process.env;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
  console.warn("[MAILER] Falta configuración SMTP en .env (SMTP_*)");
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: false, // true solo si usas puerto 465
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS
  }
});

export async function sendEmail({ to, subject, text, html }) {
  if (!to) throw new Error("Missing 'to'");

  const info = await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject,
    text,
    html: html || `<p>${text?.replace(/\n/g, "<br>")}</p>`
  });

  console.log(`[MAIL] Sent: ${info.messageId} to ${to}`);
  return info;
}
