// auth/jwt.js
import jwt from "jsonwebtoken";

// JWT_SECRET is required. Application will not start without it (enforced in index.js).
// No fallback is provided here — an undefined SECRET causes jwt.sign/verify to throw,
// which is safer than silently using a known-weak secret.
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  // This path is reached if jwt.js is imported before startup validation runs.
  // Throwing here provides a second line of defence.
  throw new Error("[FATAL] JWT_SECRET environment variable is not set. Refusing to start.");
}
const COOKIE = process.env.COOKIE_NAME || "aidash";
const SECURE = process.env.COOKIE_SECURE === "1";

// ===== ADMIN =====
export function signAdmin(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    SECRET,
    { expiresIn: "7d" }
  );
}

export function verifyAdmin(req, res, next) {
  const token = req.cookies?.[COOKIE];
  // API routes are called via fetch() — a redirect response causes the fetch to follow
  // to /login (HTML), then res.json() throws "Unexpected token", showing "connection error".
  // Return 401 JSON for API paths so the frontend can handle auth failure cleanly.
  const isApi = (req.originalUrl || req.url || "").includes("/api/");
  if (!token) {
    if (isApi) return res.status(401).json({ ok: false, error: "Unauthorized" });
    return res.redirect("/login");
  }
  try {
    req.admin = jwt.verify(token, SECRET);
    next();
  } catch {
    res.clearCookie(COOKIE);
    if (isApi) return res.status(401).json({ ok: false, error: "Session expired" });
    return res.redirect("/login");
  }
}

export function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE);
}

// ===== CLIENT =====
const CLIENT_COOKIE = "aidash_client";

export function signClient(payload, remember = false) {
  return jwt.sign(payload, SECRET, { expiresIn: remember ? "30d" : "2h" });
}

export function verifyClient(req, res, next) {
  const token = req.cookies?.[CLIENT_COOKIE];
  // Same rationale as verifyAdmin above: API calls come from fetch(), where a
  // 302 to the login HTML breaks res.json() parsing. Return 401 JSON instead.
  const isApi = (req.originalUrl || req.url || "").includes("/api/");
  if (!token) {
    if (req.path === "/login" || req.path === "/auth/login") return next();
    if (isApi) return res.status(401).json({ ok: false, error: "Unauthorized" });
    return res.redirect("/client/login");
  }
  try {
    req.client = jwt.verify(token, SECRET);
    next();
  } catch {
    res.clearCookie(CLIENT_COOKIE);
    if (isApi) return res.status(401).json({ ok: false, error: "Session expired" });
    return res.redirect("/client/login");
  }
}

export function setClientCookie(res, token, remember = false) {
  res.cookie(CLIENT_COOKIE, token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "lax",
    maxAge: remember ? 30 * 24 * 60 * 60 * 1000 : 2 * 60 * 60 * 1000,
  });
}

export function clearClientCookie(res) {
  res.clearCookie(CLIENT_COOKIE);
}
