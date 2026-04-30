// auth/jwt.js
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "changeme";
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
  if (!token) return res.redirect("/login");
  try {
    req.admin = jwt.verify(token, SECRET);
    next();
  } catch {
    res.clearCookie(COOKIE);
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

export function signClient(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: "7d" });
}

export function verifyClient(req, res, next) {
  const token = req.cookies?.[CLIENT_COOKIE];
  if (!token) {
    if (req.path === "/login" || req.path === "/auth/login") return next();
    return res.redirect("/client/login");
  }
  try {
    req.client = jwt.verify(token, SECRET);
    next();
  } catch {
    res.clearCookie(CLIENT_COOKIE);
    return res.redirect("/client/login");
  }
}

export function setClientCookie(res, token) {
  res.cookie(CLIENT_COOKIE, token, {
    httpOnly: true,
    secure: SECURE,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearClientCookie(res) {
  res.clearCookie(CLIENT_COOKIE);
}
