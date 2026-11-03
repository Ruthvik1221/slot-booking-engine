import { randomUUID } from "node:crypto";
import { SLOT_MINUTES, type DB } from "./db.js";

export interface Crew {
  id: string;
  name: string;
  skills: string;
}
export interface Service {
  id: string;
  name: string;
  duration_minutes: number;
  required_skill: string;
}
export interface Booking {
  id: string;
  service_id: string;
  customer: string;
  start_utc: string;
  end_utc: string;
  crew_id: string;
  status: "confirmed" | "cancelled";
}

export class BookingError extends Error {
  constructor(
    public code: "unknown_service" | "bad_start" | "fully_booked" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

const MS = 60_000;

/** All slot start times a booking would occupy, as ISO strings. */
export function slotsFor(startIso: string, durationMinutes: number): string[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: durationMinutes / SLOT_MINUTES }, (_, i) => new Date(start + i * SLOT_MINUTES * MS).toISOString());
}

function assertOnSlotBoundary(startIso: string) {
  const t = new Date(startIso);
  if (Number.isNaN(t.getTime())) throw new BookingError("bad_start", "start is not a valid date");
  if (t.getUTCMinutes() % SLOT_MINUTES !== 0 || t.getUTCSeconds() !== 0 || t.getUTCMilliseconds() !== 0) {
    throw new BookingError("bad_start", `start must be on a ${SLOT_MINUTES}-minute boundary`);
  }
}

export class BookingEngine {
  constructor(private db: DB) {}

  addCrew(c: Crew) {
    this.db.prepare("INSERT INTO crew (id, name, skills) VALUES (@id, @name, @skills)").run(c);
  }

  addService(s: Service) {
    this.db
      .prepare("INSERT INTO services (id, name, duration_minutes, required_skill) VALUES (@id, @name, @duration_minutes, @required_skill)")
      .run(s);
  }

  private service(id: string): Service {
    const s = this.db.prepare("SELECT * FROM services WHERE id = ?").get(id) as Service | undefined;
    if (!s) throw new BookingError("unknown_service", `unknown service ${id}`);
    return s;
  }

  /**
   * Crew who have the skill, least-busy that day first, so work spreads evenly.
   * Ties break on id so the order is deterministic (and testable).
   */
  private candidates(skill: string, dayIso: string): Crew[] {
    const day = dayIso.slice(0, 10);
    return this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM bookings b
                       WHERE b.crew_id = c.id AND b.status = 'confirmed' AND substr(b.start_utc,1,10) = ?) AS load
           FROM crew c
          WHERE (',' || c.skills || ',') LIKE ('%,' || ? || ',%')
          ORDER BY load ASC, c.id ASC`,
      )
      .all(day, skill) as Crew[];
  }

  /**
   * Try to lock every slot for one crew member in a SINGLE INSERT statement.
   * SQLite runs one statement atomically: if any slot is already taken, the
   * PRIMARY KEY violation aborts the whole statement and nothing is locked.
   * No read-then-write window, so two concurrent requests cannot both win.
   */
  private tryLock(crewId: string, slots: string[], bookingId: string): boolean {
    const values = slots.map(() => "(?, ?, ?)").join(", ");
    const params = slots.flatMap((s) => [crewId, s, bookingId]);
    try {
      this.db.prepare(`INSERT INTO slot_locks (crew_id, slot_start, booking_id) VALUES ${values}`).run(...params);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") return false;
      throw e;
    }
  }

  /** Book a service at a start time, assigning the first available qualified crew member. */
  book(input: { serviceId: string; customer: string; start: string }): Booking {
    assertOnSlotBoundary(input.start);
    const svc = this.service(input.serviceId);
    const start = new Date(input.start).toISOString();
    const end = new Date(new Date(start).getTime() + svc.duration_minutes * MS).toISOString();
    const slots = slotsFor(start, svc.duration_minutes);

    for (const crew of this.candidates(svc.required_skill, start)) {
      const id = randomUUID();
      // The booking row and its locks commit together or not at all.
      const booked = this.db.transaction(() => {
        this.db.prepare("PRAGMA defer_foreign_keys = ON").run();
        if (!this.tryLock(crew.id, slots, id)) return false;
        this.db
          .prepare("INSERT INTO bookings (id, service_id, customer, start_utc, end_utc, crew_id) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, svc.id, input.customer, start, end, crew.id);
        return true;
      }).immediate();
      if (booked) return this.get(id);
    }
    throw new BookingError("fully_booked", "no qualified crew is free for that time");
  }

  /** Cancelling releases the slot locks, so the time becomes bookable again. */
  cancel(id: string): Booking {
    const res = this.db.transaction(() => {
      const r = this.db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'").run(id);
      this.db.prepare("DELETE FROM slot_locks WHERE booking_id = ?").run(id);
      return r.changes;
    })();
    if (!res) throw new BookingError("not_found", "no confirmed booking with that id");
    return this.get(id);
  }

  get(id: string): Booking {
    const b = this.db.prepare("SELECT id, service_id, customer, start_utc, end_utc, crew_id, status FROM bookings WHERE id = ?").get(id) as
      | Booking
      | undefined;
    if (!b) throw new BookingError("not_found", "booking not found");
    return b;
  }

  /** Start times on a given UTC day (within working hours) when at least one qualified crew member is free. */
  availability(serviceId: string, dayIso: string, open = 8, close = 18): string[] {
    const svc = this.service(serviceId);
    const crew = this.candidates(svc.required_skill, dayIso);
    const taken = new Set(
      (this.db.prepare("SELECT crew_id || '|' || slot_start AS k FROM slot_locks").all() as { k: string }[]).map((r) => r.k),
    );
    const day = dayIso.slice(0, 10);
    const out: string[] = [];
    for (let m = open * 60; m + svc.duration_minutes <= close * 60; m += SLOT_MINUTES) {
      const start = new Date(`${day}T00:00:00.000Z`).getTime() + m * MS;
      const slots = slotsFor(new Date(start).toISOString(), svc.duration_minutes);
      if (crew.some((c) => slots.every((s) => !taken.has(`${c.id}|${s}`)))) out.push(new Date(start).toISOString());
    }
    return out;
  }
}
