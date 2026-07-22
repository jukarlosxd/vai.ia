// tests/staging-origin-csrf.mjs
// Cross-origin / CSRF enforcement against the Render STAGING service.
//
// A browser CANNOT run this test: `Origin` is a forbidden header, so fetch()
// silently refuses to forge it and the request always carries the page's own
// origin. Only a non-browser client can prove the server rejects a foreign
// Origin. Hence this script.
//
// It logs in itself, so no cookie is ever exported or pasted anywhere. The
// admin password is read from an environment variable and never printed; the
// session cookie and CSRF token are held in memory and only ever shown masked.
//
// Usage (PowerShell):
//   cd C:\Users\jukar\Desktop\vai.ia
//   $sec = Read-Host "Admin password" -AsSecureString
//   $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
//   try {
//     $env:STAGING_ADMIN_EMAIL    = "jukarlosxd@gmail.com"
//     $env:STAGING_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
//     node ".\tests\staging-origin-csrf.mjs"
//   } finally {
//     Remove-Item Env:\STAGING_ADMIN_PASSWORD -ErrorAction SilentlyContinue
//     Remove-Item Env:\STAGING_ADMIN_EMAIL -ErrorAction SilentlyContinue
//     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)
//     Remove-Variable sec, b -ErrorAction SilentlyContinue
//   }
//
// Sends no SMS. Changes no data: the mutating endpoint used is /connect with an
// EMPTY body, which the server treats as "keep everything as it is".

const BASE = process.env.STAGING_BASE || "https://vai-ia-staging.onrender.com";
const EMAIL = process.env.STAGING_ADMIN_EMAIL || "";
const PASSWORD = process.env.STAGING_ADMIN_PASSWORD || "";
const PROD_HOSTS = ["vai-ia.onrender.com", "vai.ia"];

if (!EMAIL || !PASSWORD) {
  console.error("STAGING_ADMIN_EMAIL / STAGING_ADMIN_PASSWORD are not set. Aborting.");
  process.exit(2);
}
if (PROD_HOSTS.some((h) => BASE.includes(h))) {
  console.error("REFUSING TO RUN: BASE points at production. Aborting.");
  process.exit(2);
}

const HOST = new URL(BASE).host;
let pass = 0, fail = 0;
const t = (name, cond, detail = "") => {
  if (cond) { console.log("  PASS", name, detail && "— " + detail); pass++; }
  else { console.log("  FAIL", name, detail && "— " + detail); fail++; }
};
const mask = (s) => (s ? s.slice(0, 4) + "…(" + s.length + " chars)" : "(none)");

// ── sign in (cookies handled manually; Node fetch has no jar) ───────────────
const loginRes = await fetch(BASE + "/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (loginRes.status !== 200) {
  console.error("Admin login failed:", loginRes.status, "— aborting.");
  process.exit(1);
}
const setCookie = loginRes.headers.getSetCookie?.() || [];
const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
if (!cookie) { console.error("No session cookie returned — aborting."); process.exit(1); }

// ── fetch a valid CSRF token ───────────────────────────────────────────────
const stateRes = await fetch(BASE + "/admin/api/apps/twilio", { headers: { cookie } });
const state = await stateRes.json();
const csrf = state.csrfToken;

console.log("── staging Origin / CSRF enforcement ──");
console.log("   base:  ", BASE);
console.log("   cookie:", mask(cookie));
console.log("   csrf:  ", mask(csrf));
console.log();

// An EMPTY connect body: valid, mutating route, but a no-op for stored data.
const attempt = (headers) =>
  fetch(BASE + "/admin/api/apps/twilio/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, ...headers },
    body: JSON.stringify({}),
  });

// 1. foreign Origin + VALID CSRF  → must be rejected
{
  const r = await attempt({ "X-CSRF-Token": csrf, Origin: "https://malicious.example" });
  t("foreign Origin + valid CSRF → 403", r.status === 403, "status " + r.status);
}

// 2. correct Origin + valid CSRF  → allowed
{
  const r = await attempt({ "X-CSRF-Token": csrf, Origin: `https://${HOST}` });
  t("correct Origin + valid CSRF → allowed", r.status === 200, "status " + r.status);
}

// 3. correct Origin + invalid CSRF → rejected
{
  const r = await attempt({ "X-CSRF-Token": "not-a-real-token", Origin: `https://${HOST}` });
  t("correct Origin + invalid CSRF → 403", r.status === 403, "status " + r.status);
}

// 4. foreign Origin + invalid CSRF → rejected
{
  const r = await attempt({ "X-CSRF-Token": "not-a-real-token", Origin: "https://malicious.example" });
  t("foreign Origin + invalid CSRF → 403", r.status === 403, "status " + r.status);
}

// 5. no Origin at all + valid CSRF (server-to-server) → policy: allowed by the
//    Origin guard (it only acts when Origin is present); CSRF still required.
{
  const r = await attempt({ "X-CSRF-Token": csrf });
  t("absent Origin + valid CSRF → allowed (CSRF is the gate)", r.status === 200, "status " + r.status);
}

// 6. no Origin, no CSRF → rejected
{
  const r = await attempt({});
  t("absent Origin + no CSRF → 403", r.status === 403, "status " + r.status);
}

// 7. a malformed Origin must not crash the guard
{
  const r = await attempt({ "X-CSRF-Token": csrf, Origin: "not a url" });
  t("malformed Origin → 403", r.status === 403, "status " + r.status);
}

// ── the connection must be untouched by any of the above ───────────────────
{
  const after = await (await fetch(BASE + "/admin/api/apps/twilio", { headers: { cookie } })).json();
  const c = after.connection || {};
  t("connection still intact", c.hasToken === true && !!c.accountSidMasked,
    `status=${c.status} hasToken=${c.hasToken} account=${c.accountSidMasked}`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
