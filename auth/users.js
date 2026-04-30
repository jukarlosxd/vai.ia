// auth/users.js
// Los usuarios ahora viven en Supabase (auth/supabase.js)
// Este archivo solo exporta validatePassword (bcrypt) que sigue igual
import bcrypt from "bcrypt";

export async function validatePassword(plainText, hash) {
  if (!plainText || !hash) return false;
  return bcrypt.compare(plainText, hash);
}

export async function hashPassword(plainText) {
  return bcrypt.hash(plainText, 10);
}
