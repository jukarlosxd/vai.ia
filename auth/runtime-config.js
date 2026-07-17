// auth/runtime-config.js
// Pure, side-effect-free runtime configuration helpers shared by index.js and
// the test suite. Importing this module must NEVER start a server or touch I/O,
// so both production code and tests exercise the SAME function.

// Resolve the Twilio channel configuration from an env-like object.
// Returns { enabled, valid, errors, accountSid, authToken }.
//   - enabled: whether the Twilio (SMS/Voice) channel is turned on
//   - valid:   whether the configuration is internally consistent
//   - errors:  human-readable startup errors (empty when valid)
// Rules:
//   * TWILIO_ENABLED accepts only the exact strings "true" / "false"
//     (case-insensitive, trimmed). Any other non-empty value (e.g. "yes",
//     "1abc", "  ") is INVALID → { enabled:false, valid:false } with an error,
//     so the server refuses to start on an ambiguous flag rather than guessing.
//   * When TWILIO_ENABLED is unset/empty, the channel is deduced ENABLED only
//     when the full config (accountSid + authToken) is present.
//   * When enabled, a partial config is invalid (hard startup error).
//   * No placeholder tokens: a value must be a real credential to count.
export function resolveTwilioConfiguration(env = {}) {
  const accountSid = (env.TWILIO_ACCOUNT_SID || "").trim() || null;
  const authToken  = (env.TWILIO_AUTH_TOKEN  || "").trim() || null;

  const rawFlag = env.TWILIO_ENABLED;
  const hasFlag = rawFlag !== undefined && rawFlag !== null && String(rawFlag).trim() !== "";
  const flag = String(rawFlag ?? "").trim().toLowerCase();

  const errors = [];
  let enabled;

  if (!hasFlag) {
    // Deduce from a complete configuration.
    enabled = Boolean(accountSid && authToken);
  } else if (flag === "true") {
    enabled = true;
  } else if (flag === "false") {
    enabled = false;
  } else {
    // Ambiguous/invalid flag value — do not guess.
    errors.push(`TWILIO_ENABLED has an invalid value; use exactly "true" or "false".`);
    return { enabled: false, valid: false, errors, accountSid, authToken };
  }

  if (enabled) {
    if (!accountSid) errors.push("Twilio is enabled but TWILIO_ACCOUNT_SID is not set.");
    if (!authToken)  errors.push("Twilio is enabled but TWILIO_AUTH_TOKEN is not set.");
  }

  return { enabled, valid: errors.length === 0, errors, accountSid, authToken };
}

// Build the tenant-local timestamps for an availability block from SEPARATE
// local fields. The timezone is supplied by the AUTHENTICATED tenant config —
// never by the model. Time fields must be plain local wall-clock "HH:mm" (or
// "H:mm"); any ISO offset, "Z", timezone name, or full ISO datetime is
// REJECTED so a "20:00Z" can never be silently reinterpreted as 20:00 local.
//
// DateTimeLib is injected (Luxon's DateTime) to avoid a hard dependency here.
// Returns { ok:true, startISO, endISO, startMs, endMs } or { ok:false, error, message }.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;          // HH:mm 00:00–23:59
const OFFSET_LIKE_RE = /(Z|[+-]\d{2}:?\d{2}|T\d)/i;     // Z, ±HH:mm, or a "T<hour>"

export function buildLocalBlockInterval(DateTimeLib, tz, date, startTime, endTime) {
  for (const [label, v] of [["date", date], ["start_time", startTime], ["end_time", endTime]]) {
    if (typeof v !== "string" || v.trim() === "") {
      return { ok: false, error: "VALIDATION_ERROR", message: `${label} is required` };
    }
  }
  const d = date.trim(), st = startTime.trim(), et = endTime.trim();

  if (!DATE_RE.test(d)) return { ok: false, error: "AMBIGUOUS_DATE", message: "date must be YYYY-MM-DD (local, no timezone)" };
  // Reject anything that looks like an offset/Z/ISO time — the model must send
  // plain local time, not a timezone-qualified value.
  for (const [label, v] of [["start_time", st], ["end_time", et]]) {
    if (OFFSET_LIKE_RE.test(v)) {
      return { ok: false, error: "VALIDATION_ERROR", message: `${label} must be local HH:mm with no timezone/offset (got "${v}")` };
    }
    if (!TIME_RE.test(v)) {
      return { ok: false, error: "VALIDATION_ERROR", message: `${label} must be local HH:mm (got "${v}")` };
    }
  }

  const [sh, sm] = st.split(":").map(Number);
  const [eh, em] = et.split(":").map(Number);
  const [y, mo, da] = d.split("-").map(Number);

  const s = DateTimeLib.fromObject({ year: y, month: mo, day: da, hour: sh, minute: sm }, { zone: tz });
  const e = DateTimeLib.fromObject({ year: y, month: mo, day: da, hour: eh, minute: em }, { zone: tz });

  if (!s.isValid || !e.isValid) {
    return { ok: false, error: "AMBIGUOUS_DATE", message: "the requested local date/time is invalid" };
  }
  // DST spring-forward gap: Luxon silently shifts a nonexistent wall-clock time
  // forward (e.g. 02:30 → 03:30). Detect it by comparing the requested clock
  // fields against the constructed ones and reject rather than block the wrong hour.
  if (s.hour !== sh || s.minute !== sm || e.hour !== eh || e.minute !== em) {
    return { ok: false, error: "AMBIGUOUS_DATE", message: "the requested local time does not exist on this date (DST change)" };
  }
  if (e <= s) return { ok: false, error: "VALIDATION_ERROR", message: "end_time must be after start_time" };
  if (e.diff(s, "days").days > 14) return { ok: false, error: "VALIDATION_ERROR", message: "interval too long (max 14 days)" };

  return {
    ok: true,
    startISO: s.toUTC().toISO(), endISO: e.toUTC().toISO(),
    startMs: s.toUTC().toMillis(), endMs: e.toUTC().toMillis(),
  };
}
