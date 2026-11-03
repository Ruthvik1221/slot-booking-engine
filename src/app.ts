import express from "express";
import { z } from "zod";
import { BookingEngine, BookingError } from "./engine.js";

const bookBody = z.object({
  serviceId: z.string().min(1),
  customer: z.string().min(1).max(120),
  start: z.string().datetime(),
});

const STATUS: Record<BookingError["code"], number> = {
  unknown_service: 404,
  bad_start: 400,
  fully_booked: 409,
  not_found: 404,
};

export function createApp(engine: BookingEngine) {
  const app = express();
  app.use(express.json());

  app.get("/availability", (req, res) => {
    const q = z.object({ serviceId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: "serviceId and date (YYYY-MM-DD) are required" });
    res.json({ starts: engine.availability(q.data.serviceId, q.data.date) });
  });

  app.post("/bookings", (req, res) => {
    const body = bookBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.flatten() });
    res.status(201).json(engine.book(body.data));
  });

  app.delete("/bookings/:id", (req, res) => {
    res.json(engine.cancel(req.params.id));
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof BookingError) return void res.status(STATUS[err.code]).json({ error: err.code, message: err.message });
    console.error(err);
    res.status(500).json({ error: "internal" });
  });

  return app;
}
