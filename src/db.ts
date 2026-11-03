import Database from "better-sqlite3";

export type DB = Database.Database;

/** Bookings are made in fixed slots; a 90-minute job occupies three 30-minute slots. */
export const SLOT_MINUTES = 30;

export function openDb(file = ":memory:"): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL"); // lets separate connections write safely
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crew (
      id     TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      skills TEXT NOT NULL            -- comma-separated, e.g. "junk,moving"
    );

    CREATE TABLE IF NOT EXISTS services (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0 AND duration_minutes % ${SLOT_MINUTES} = 0),
      required_skill   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id         TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES services(id),
      customer   TEXT NOT NULL,
      start_utc  TEXT NOT NULL,
      end_utc    TEXT NOT NULL,
      crew_id    TEXT NOT NULL REFERENCES crew(id),
      status     TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- The heart of the engine: one row per (crew member, 30-minute slot).
    -- The PRIMARY KEY makes it physically impossible for two bookings
    -- to hold the same crew member in the same slot.
    CREATE TABLE IF NOT EXISTS slot_locks (
      crew_id    TEXT NOT NULL REFERENCES crew(id),
      slot_start TEXT NOT NULL,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      PRIMARY KEY (crew_id, slot_start)
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_crew_start ON bookings(crew_id, start_utc);
  `);
}
