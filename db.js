// db.js
import Database from "better-sqlite3";
import { DateTime } from "luxon";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const dbPath = path.join(__dirname, "data.sqlite");
const db = new Database(dbPath);

// Tablas
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  client_slug TEXT,
  lang TEXT,
  channel TEXT,            -- 'web' | 'whatsapp' | 'instagram' | 'sms' ...
  channel_user_id TEXT,    -- ID del usuario en el canal (tel/ig_psid/etc)
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  role TEXT,               -- 'user' | 'assistant'
  content TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  phone TEXT,
  email TEXT,
  instagram_psid TEXT,
  whatsapp_id TEXT,
  created_at TEXT,
  UNIQUE(phone, email, instagram_psid, whatsapp_id)

  
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_slug TEXT,
  session_id TEXT,
  contact_id INTEGER,
  service TEXT,
  time_utc TEXT,           -- ISO en UTC
  timezone TEXT,           -- zona horaria de la sucursal
  pay_method TEXT,         -- 'cash' | 'card'
  status TEXT,             -- 'confirmed' | 'cancelled' | ...
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER,
  fire_at_utc TEXT,        -- momento exacto de envío (UTC)
  channel TEXT,            -- por dónde se enviará
  target TEXT,             -- id/phone/psid
  payload TEXT,            -- mensaje a enviar (json o texto)
  status TEXT,             -- 'pending' | 'sent' | 'failed'
  created_at TEXT,
  sent_at TEXT,
  error TEXT
);

`);

export function nowISO() {
  return DateTime.utc().toISO();
}

export default db;
// Índices: email único; name NO único
db.exec(`
  -- Si en algún momento se creó UNIQUE(name), elimínalo
  DROP INDEX IF EXISTS ux_contacts_name;

  -- email sí debe ser único (para upsert por correo)
  CREATE UNIQUE INDEX IF NOT EXISTS ux_contacts_email ON contacts(email);

  -- name solo como índice normal (no único) para búsquedas
  CREATE INDEX IF NOT EXISTS ix_contacts_name ON contacts(name);
`);


