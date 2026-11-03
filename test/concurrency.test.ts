import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { BookingEngine } from "../src/engine.js";

/**
 * Real race: N worker threads, each with its OWN database connection to the same
 * file, all try to book the only crew member at the same moment.
 * Exactly one must win. This is the double-booking bug the slot lock prevents.
 */
describe("concurrent booking", () => {
  const dir = mkdtempSync(join(tmpdir(), "booking-"));
  const file = join(dir, "race.db");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("lets exactly one of many simultaneous requests win the same slot", async () => {
    const db = openDb(file);
    const engine = new BookingEngine(db);
    engine.addCrew({ id: "solo", name: "Solo", skills: "junk" });
    engine.addService({ id: "pickup", name: "Pickup", duration_minutes: 60, required_skill: "junk" });
    db.close();

    const workerCode = `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require("better-sqlite3");
      const db = new Database(workerData.file);
      db.pragma("busy_timeout = 5000");
      const { randomUUID } = require("node:crypto");
      const id = randomUUID();
      const slots = ["2026-11-10T09:00:00.000Z", "2026-11-10T09:30:00.000Z"];
      // Same strategy as BookingEngine.tryLock: one atomic multi-row INSERT.
      const tx = db.transaction(() => {
        db.prepare("PRAGMA defer_foreign_keys = ON").run();
        db.prepare("INSERT INTO slot_locks (crew_id, slot_start, booking_id) VALUES (?, ?, ?), (?, ?, ?)")
          .run("solo", slots[0], id, "solo", slots[1], id);
        db.prepare("INSERT INTO bookings (id, service_id, customer, start_utc, end_utc, crew_id) VALUES (?, 'pickup', ?, ?, ?, 'solo')")
          .run(id, "customer-" + workerData.n, slots[0], "2026-11-10T10:00:00.000Z");
      });
      try { tx.immediate(); parentPort.postMessage("won"); }
      catch (e) { parentPort.postMessage(e.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ? "lost" : "error:" + e.message); }
    `;

    const N = 12;
    const results = await Promise.all(
      Array.from(
        { length: N },
        (_, n) =>
          new Promise<string>((resolve, reject) => {
            const w = new Worker(workerCode, { eval: true, workerData: { file, n } });
            w.once("message", resolve);
            w.once("error", reject);
          }),
      ),
    );

    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "lost")).toHaveLength(N - 1);

    const check = openDb(file);
    expect((check.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n).toBe(1);
    check.close();
  });
});
