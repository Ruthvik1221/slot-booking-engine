import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { BookingEngine, BookingError, slotsFor } from "../src/engine.js";

const DAY = "2026-11-10";
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function setup(): { db: DB; engine: BookingEngine } {
  const db = openDb();
  const engine = new BookingEngine(db);
  engine.addCrew({ id: "a", name: "A", skills: "junk,moving" });
  engine.addCrew({ id: "b", name: "B", skills: "junk" });
  engine.addService({ id: "pickup", name: "Pickup", duration_minutes: 60, required_skill: "junk" });
  engine.addService({ id: "move", name: "Move", duration_minutes: 120, required_skill: "moving" });
  return { db, engine };
}

describe("slotsFor", () => {
  it("splits a duration into 30-minute slots", () => {
    expect(slotsFor(at("09:00"), 90)).toEqual([at("09:00"), at("09:30"), at("10:00")]);
  });
});

describe("BookingEngine", () => {
  let db: DB;
  let engine: BookingEngine;
  beforeEach(() => ({ db, engine } = setup()));

  it("books and assigns a qualified crew member", () => {
    const b = engine.book({ serviceId: "pickup", customer: "Ann", start: at("09:00") });
    expect(b.status).toBe("confirmed");
    expect(["a", "b"]).toContain(b.crew_id);
    expect(b.end_utc).toBe(at("10:00"));
  });

  it("spreads work: the second same-time booking goes to the other crew member", () => {
    const first = engine.book({ serviceId: "pickup", customer: "Ann", start: at("09:00") });
    const second = engine.book({ serviceId: "pickup", customer: "Bob", start: at("09:00") });
    expect(new Set([first.crew_id, second.crew_id])).toEqual(new Set(["a", "b"]));
  });

  it("refuses a third booking when every qualified crew member is busy", () => {
    engine.book({ serviceId: "pickup", customer: "Ann", start: at("09:00") });
    engine.book({ serviceId: "pickup", customer: "Bob", start: at("09:00") });
    expect(() => engine.book({ serviceId: "pickup", customer: "Cy", start: at("09:00") })).toThrowError(BookingError);
  });

  it("detects partial overlaps, not just identical start times", () => {
    engine.book({ serviceId: "move", customer: "Ann", start: at("09:00") }); // a: 09:00-11:00
    // only "a" can do moves; 10:00 overlaps the second hour
    expect(() => engine.book({ serviceId: "move", customer: "Bob", start: at("10:00") })).toThrowError(/no qualified crew/);
    // back-to-back is fine
    expect(engine.book({ serviceId: "move", customer: "Cy", start: at("11:00") }).crew_id).toBe("a");
  });

  it("leaves no partial locks behind when a multi-slot lock fails", () => {
    engine.book({ serviceId: "move", customer: "Ann", start: at("10:00") }); // a: 10:00-12:00
    expect(() => engine.book({ serviceId: "move", customer: "Bob", start: at("09:00") })).toThrow();
    const locks = db.prepare("SELECT COUNT(*) AS n FROM slot_locks").get() as { n: number };
    expect(locks.n).toBe(4); // only Ann's four slots
    const bookings = db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number };
    expect(bookings.n).toBe(1);
  });

  it("cancelling frees the time again", () => {
    const b = engine.book({ serviceId: "move", customer: "Ann", start: at("09:00") });
    engine.cancel(b.id);
    expect(engine.book({ serviceId: "move", customer: "Bob", start: at("09:00") }).crew_id).toBe("a");
    expect(() => engine.cancel(b.id)).toThrowError(/no confirmed booking/);
  });

  it("rejects starts that are not on a slot boundary", () => {
    expect(() => engine.book({ serviceId: "pickup", customer: "Ann", start: at("09:15") })).toThrowError(/boundary/);
  });

  it("reports availability only where a qualified crew member is free for the whole duration", () => {
    engine.book({ serviceId: "move", customer: "Ann", start: at("09:00") }); // a busy 09:00-11:00
    const starts = engine.availability("move", DAY);
    expect(starts).not.toContain(at("08:00")); // would run into 09:00
    expect(starts).not.toContain(at("10:00"));
    expect(starts).toContain(at("11:00"));
    expect(starts.at(-1)).toBe(at("16:00")); // last 2-hour start before 18:00 close
  });
});
