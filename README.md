# slot-booking-engine

A booking and crew-assignment engine for service businesses (junk removal, moving, cleaning) that **cannot double-book**, even under concurrent requests.

> This is a clean-room reference implementation written from scratch to show the pattern. It contains no client or employer code and no real customer data.

## The problem

The naive approach is "check if the slot is free, then insert the booking." Two requests that arrive at the same moment both see the slot as free, and both insert. The customer-facing result is two crews promised to the same time, or one crew promised to two places.

## The approach

```
POST /bookings ──► validate (zod) ──► for each qualified crew, least-busy first:
                                        BEGIN IMMEDIATE
                                          INSERT all 30-min slot_locks   ◄── one statement;
                                          INSERT booking row                 PRIMARY KEY (crew_id, slot_start)
                                        COMMIT                               rejects any overlap
                                      ──► first crew that locks wins; none → 409
```

* Time is divided into 30-minute slots. A 90-minute job holds three rows in `slot_locks`.
* `slot_locks` has `PRIMARY KEY (crew_id, slot_start)`, so the database itself refuses a second holder. There is no read-then-write window to race through.
* All of a booking's slots are inserted in **one multi-row statement**. If any slot is taken, the whole statement fails and nothing is left half-locked.
* The booking row and its locks commit in the same transaction. Cancelling deletes the locks, which makes the time bookable again.
* Crew are tried least-busy-first for the day (ties broken by id), which spreads work evenly and keeps behaviour deterministic for tests.

## Design decisions

| Decision | Why |
| --- | --- |
| Lock table instead of overlap queries | An overlap `SELECT` can't stop a concurrent insert; a unique key can. |
| Fixed 30-minute slots | Turns interval overlap into exact key equality, which a unique index can enforce. |
| `BEGIN IMMEDIATE` | Takes the write lock up front, so SQLite serialises writers instead of failing late with `SQLITE_BUSY`. |
| SQLite (WAL) | Zero setup for a demo. The same lock-table pattern works in Postgres with a unique index. |
| UTC everywhere | Avoids daylight-saving bugs. Convert to local time at the edges. |

## Tests

```bash
npm install
npm test        # 13 tests
npm run typecheck
```

* `engine.test.ts`: assignment, load spreading, partial overlaps, back-to-back bookings, no leftover partial locks, cancel/re-book, slot boundaries, availability.
* `concurrency.test.ts`: 12 worker threads, each with its own database connection, race for the only crew member at the same time. Exactly one wins and exactly one booking exists. (The worker runs the same single-statement lock as `BookingEngine.tryLock`, inlined because worker threads load plain JavaScript.)
* `app.test.ts`: HTTP flow: 201, then 409 on the double booking, then 201 again after cancel.

## Run it

```bash
npm run dev     # http://localhost:3000, seeds two crews and two services
curl "localhost:3000/availability?serviceId=junk-pickup&date=2026-11-10"
curl -X POST localhost:3000/bookings -H 'content-type: application/json' \
  -d '{"serviceId":"junk-pickup","customer":"Ann","start":"2026-11-10T09:00:00.000Z"}'
```

## Not included (on purpose)

Auth, payments, time-zone display, recurring bookings and travel time between jobs. Each would sit on top of the same lock table.

## License

MIT
