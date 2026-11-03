import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { BookingEngine } from "../src/engine.js";

function app() {
  const engine = new BookingEngine(openDb());
  engine.addCrew({ id: "a", name: "A", skills: "junk" });
  engine.addService({ id: "pickup", name: "Pickup", duration_minutes: 60, required_skill: "junk" });
  return createApp(engine);
}

describe("HTTP API", () => {
  it("books, refuses the double booking with 409, and frees the slot on cancel", async () => {
    const a = app();
    const body = { serviceId: "pickup", customer: "Ann", start: "2026-11-10T09:00:00.000Z" };
    const first = await request(a).post("/bookings").send(body).expect(201);
    await request(a).post("/bookings").send({ ...body, customer: "Bob" }).expect(409);
    await request(a).delete(`/bookings/${first.body.id}`).expect(200);
    await request(a).post("/bookings").send({ ...body, customer: "Bob" }).expect(201);
  });

  it("validates input", async () => {
    await request(app()).post("/bookings").send({ serviceId: "pickup" }).expect(400);
    await request(app()).get("/availability").expect(400);
  });

  it("lists availability", async () => {
    const res = await request(app()).get("/availability").query({ serviceId: "pickup", date: "2026-11-10" }).expect(200);
    expect(res.body.starts[0]).toBe("2026-11-10T08:00:00.000Z");
  });
});
