import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { BookingEngine } from "./engine.js";

const db = openDb(process.env.DB_FILE ?? "bookings.db");
const engine = new BookingEngine(db);

// Demo seed data (idempotent).
const seeded = db.prepare("SELECT COUNT(*) AS n FROM crew").get() as { n: number };
if (seeded.n === 0) {
  engine.addCrew({ id: "crew-a", name: "Crew A", skills: "junk,moving" });
  engine.addCrew({ id: "crew-b", name: "Crew B", skills: "junk" });
  engine.addService({ id: "junk-pickup", name: "Junk pickup", duration_minutes: 60, required_skill: "junk" });
  engine.addService({ id: "small-move", name: "Small move", duration_minutes: 120, required_skill: "moving" });
}

const port = Number(process.env.PORT ?? 3000);
createApp(engine).listen(port, () => console.log(`listening on http://localhost:${port}`));
