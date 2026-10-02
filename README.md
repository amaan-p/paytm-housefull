# paytm-housefull 🎬

> Take-home assignment for the Paytm engineering round. Not an official Paytm product.

A small seat-reservation service for one job: a show goes on sale, thousands of people hit "book" in the same second, and **every seat goes to exactly one person**. No double-sells, no user over their limit, no double-charge on a retry. When it's sold out, the board says **HOUSEFULL**.

Node.js + Express + SQLite (`better-sqlite3`). Prometheus metrics, structured JSON logs, and a one-command burst script that storms the live service and checks every rule.

**Live:** `<LIVE_URL>` · **Metrics:** `<LIVE_URL>/metrics` · **Health:** `<LIVE_URL>/health/ready`

The design reasoning (atomic decision, idempotency, failure modes, AI usage) is in [WRITEUP.md](WRITEUP.md).

---

## Run it locally

You need Node 24+ and pnpm.

```bash
pnpm install
pnpm approve-builds          # allow better-sqlite3 to fetch its native binary
cp .env.example .env         # then set JWT_SECRET and ADMIN_KEY
pnpm dev                     # http://localhost:3000
```

Check it's up:

```bash
curl localhost:3000/health/ready     # {"status":"ready"}
```

## Run it with Docker

```bash
docker build -t paytm-housefull .
docker run -p 3000:3000 -v housefull-data:/data \
  -e DB_PATH=/data/app.db -e JWT_SECRET=change-me -e ADMIN_KEY=change-me \
  paytm-housefull
```

The volume is where the SQLite file lives, so data survives restarts. This is the same image that runs in production.

---

## Getting a token

There's no real login, so the service hands out demo tokens. Your identity comes **only** from the token. Anything like `user_id` in a request body is ignored.

```bash
# user token
curl -X POST localhost:3000/auth/token -H 'content-type: application/json' \
  -d '{"user_id":"alice"}'

# admin token (needed to create shows): send the server's ADMIN_KEY
curl -X POST localhost:3000/auth/token -H 'content-type: application/json' \
  -H 'x-admin-key: <ADMIN_KEY>' -d '{"user_id":"admin"}'
```

Send the token as `Authorization: Bearer <token>`. Tokens last 24h.

## API

| Method | Path | Who | What |
|---|---|---|---|
| `POST` | `/shows` | admin | Create a show with its seats, all `available` |
| `GET` | `/shows/:id` | anyone | Per-seat status + counts |
| `POST` | `/shows/:id/reserve` | user | Reserve one or more seats |
| `POST` | `/reservations/:id/cancel` | owner | Cancel, and the seats go back on sale |
| `GET` | `/health/live` | anyone | Process is up |
| `GET` | `/health/ready` | anyone | DB answers a query. **503 if not** |
| `GET` | `/metrics` | anyone | Prometheus metrics |
| `POST` | `/auth/token` | anyone | Demo token issuer |
| `POST` | `/admin/reset` | admin | Wipe all data. Only works if `ALLOW_RESET=true` |

### Create a show

```bash
curl -X POST localhost:3000/shows -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"friday-night","seats":["A1","A2","A3"],"price_paise":25000,"per_user_limit":4}'
```

`price_paise` must be a positive integer. `250.5` or `"25000"` gets a 400. `per_user_limit` is optional and defaults to 4. Seat labels must be unique.

### Reserve

```bash
curl -X POST localhost:3000/shows/$SHOW/reserve -H "authorization: Bearer $ALICE" -H 'content-type: application/json' \
  -d '{"seats":["A12","A13"],"idempotency_key":"9f1c..."}'
```

The idempotency key can go in the body or in an `Idempotency-Key` header. The header wins if both are sent.

```json
201 { "reservation_id": "…", "show_id": "…", "user_id": "alice",
      "seats": ["A12","A13"], "amount_paise": 50000, "status": "confirmed" }
```

The rules:
- **All-or-nothing.** If you ask for A12 + A13 and A13 is gone, you get neither, and A12 stays available.
- **Retry with the same key** gets back the original reservation (same `reservation_id`, still 201). Nothing new is booked.
- **Same key, different seats** is a 409 `idempotency_key_reused`.
- **The amount is computed by the server** as price × seats, in integer paise.

### Cancel

```bash
curl -X POST localhost:3000/reservations/$RES/cancel -H "authorization: Bearer $ALICE"
```

Only the owner can cancel. Anyone else gets a 404, so you can't even confirm the reservation exists. Cancelling twice is harmless.

### Error codes

Every decline is a clean 4xx with `{"error": "<code>"}`. Only real bugs are 5xx.

| Status | `error` | When |
|---|---|---|
| 400 | `validation_failed` | Bad body (with a `message`) |
| 400 | `invalid_json` | Body isn't valid JSON |
| 400 | `unknown_seat` | A seat label that isn't in this show |
| 401 | `missing_token` / `invalid_token` | No token, a bad one, or an expired one |
| 403 | `admin_only` / `invalid_admin_key` | Not an admin |
| 404 | `show_not_found` / `reservation_not_found` | Doesn't exist, or isn't yours |
| 409 | `seat_taken` | Someone else got there first |
| 409 | `per_user_limit` | This would take you over the per-user limit |
| 409 | `idempotency_key_reused` | Same key, different request |
| 413 | `body_too_large` | Body over 1 MB |

---

## Burst test: one command

This reproduces the on-sale stampede against any URL, then checks every correctness rule and exits with **code 1 if anything fails**.

```bash
ADMIN_KEY=<server's admin key> pnpm burst <BASE_URL>
# e.g.
ADMIN_KEY=... pnpm burst https://<LIVE_URL>
```

On PowerShell: `$env:ADMIN_KEY="..."; pnpm burst <BASE_URL>`

What it does, on a fresh show of 200 seats:
1. **Hot-seat storm:** 500 different users × 5 hot seats, all grabbing the same seat at once.
2. **Stampede:** 15,000 reserves from 3,000 users, 60% of them fighting over the front 20% of seats. About 10% are exact retries (same key, same body), and about 2% reuse a key with different seats.
3. **Limit and spoofing:** one user fires 10 parallel reserves on a limit-4 show. Another sends a fake `user_id` in the body and tries to cancel someone else's booking.
4. **Reconcile:** the API state against every 201 we got back, and against `/metrics`.

Tune it with env vars: `SEATS`, `HOT_SEATS`, `HOT_USERS` (per hot seat), `REQUESTS`, `USERS`, `CONCURRENCY` (in-flight requests, default 300).

Sample run (local):

```
hot-seat storm (2500 requests)
  declined:seat_taken                  2495
  confirmed                               5

stampede (15000 requests)
  declined:seat_taken                 14704
  confirmed                             176
  replay                                 90
  declined:idempotency_key_reused        30

limit test (11 requests)
  declined:per_user_limit                 6
  confirmed                               5

=== reconciliation ===
  available 0 + held 0 + confirmed 200 = 200 (total 200)

=== checks ===
  PASS  hot seat A1..A5: exactly one winner  (1 winners of 500)
  PASS  per-user limit holds under 10 parallel requests  (4 confirmed (limit 4))
  PASS  spoofed body user_id is ignored
  PASS  cannot cancel someone else's reservation  (got 404)
  PASS  available + held + confirmed == total_seats
  PASS  no seat confirmed to two reservations
  PASS  confirmed seats in API == seats in 201 responses
  PASS  no user above per_user_limit
  PASS  zero 5xx across the burst
  PASS  metrics seats_available / seats_confirmed == API
  PASS  reservations_confirmed_total moved by exactly our bookings

ALL CHECKS PASSED
```

### Reset between runs

```bash
ADMIN_KEY=... pnpm reset <BASE_URL>
```

This wipes all shows and reservations and resets the counters. It only works when the server has `ALLOW_RESET=true`; otherwise you get a 403. It's off in production while the service is being reviewed. You don't actually need it, though, because every burst creates its own fresh show.

---

## Observability

### Metrics (`/metrics`)

| Metric | Type | Notes |
|---|---|---|
| `reservations_confirmed_total` | counter | New bookings only. Replays don't count |
| `reservations_declined_total{reason}` | counter | `seat_taken`, `per_user_limit`, `idempotent_replay`, `idempotency_key_reused`, `unknown_seat`, `show_not_found` |
| `seats_available{show_id}` | gauge | **Read from the DB at scrape time** |
| `seats_held{show_id}`, `seats_confirmed{show_id}` | gauge | Same. Always equal to what `GET /shows/:id` says |
| `http_request_duration_seconds{method,route,status}` | histogram | Labelled by route pattern (`/shows/:id/reserve`), never the raw URL |
| Node defaults | various | Memory, event-loop lag, GC |

The spec's reason names map one-to-one to these labels: seat-taken → `seat_taken`, per-user-limit → `per_user_limit`, idempotent-replay → `idempotent_replay`.

### Logs

These are JSON lines on stdout, one per request plus one per reservation outcome. Every line carries a `reqId`. If you send an `X-Request-Id` header, it's reused; otherwise one is generated. It's echoed back in the response header, so a single request can be traced end to end.

```json
{"level":30,"reqId":"trace-123","event":"reservation_confirmed","reservation_id":"ad50…","user_id":"alice","seats":["A1"]}
{"level":30,"reqId":"trace-123","req":{"method":"POST","url":"/shows/…/reserve"},"res":{"statusCode":201},"responseTime":6}
```

Declines log at `info`, because they're normal at on-sale. Only 5xx logs at `error`. Tokens and the admin key are redacted.

Live logs: `<LOGS_LINK_OR_RECORDING>`

---

## Config

| Var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DB_PATH` | `data.db` | Point it at a persistent volume in production |
| `JWT_SECRET` | — | **Required.** The server won't start without it |
| `ADMIN_KEY` | — | Needed to mint admin tokens. Unset means no admin |
| `LOG_LEVEL` | `info` | |
| `MAX_SEATS` | `50000` | Max seats per show |
| `ALLOW_RESET` | `false` | Enables `POST /admin/reset` |

## Layout

```
src/
  server.js          entry point, graceful shutdown
  app.js             express app, request ids, health, metrics, error handler
  db.js              sqlite connection, pragmas, schema
  reservations.js    reserve + cancel: all the correctness lives here
  auth.js            JWT verify, requireUser / requireAdmin
  metrics.js         prometheus counters, DB-backed seat gauges
  logger.js          pino
  routes/            shows, reservations, auth, admin
scripts/
  burst.js           the stampede + reconciliation
  reset.js           wipe data between runs
```
