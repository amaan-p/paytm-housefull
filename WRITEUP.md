# WRITEUP: paytm-housefull

Short version: every rule is enforced by a single guarded SQL statement, not by an `if` in JS. Tested and live.

## 1. The atomic decision

```sql
UPDATE seats SET status='confirmed', user_id=?, reservation_id=?
WHERE show_id=? AND label=? AND status='available'
```

`changes === 1` means you got the seat. `0` means someone beat you, so you get a 409 `seat_taken`.

**Why is it race-free?>>** The 'check' and the 'take' are the same statement, so there's no "read A12, it's free, now write" gap. 500 people on A12: the first flips it, the other 499 match 0 rows, and only one person gets it.

SQLite serializes writes anyway, but I don't rely on that...(cuz on the job there may be a diffrent database) The guard is in the `WHERE`, so the same SQL is race-free on Postgres too.

### What about multi-seat requests??
All-or-nothing. If you ask for A12 + A13 and A13 is gone, you get neither. Labels are **sorted** before taking them, so two multi-seat requests always lock in the same order, which means no deadlocks.

### Per-user limit??
A counter table with a guarded upsert: `count = count + n WHERE count + n <= limit`. Same idea as the seats. 10 parallel requests on a limit of 4 means exactly 4 win.

## 2. Idempotency

The key lives in `reservations` with `UNIQUE(user_id, idempotency_key)`, so the booking itself is the idempotency record. Each row also stores `sha256(show_id + sorted seats)`.

Inside the same transaction:
- **if same key, same body:** return the original booking (201). Nothing moves.
- **if same key, different seats:** 409 `idempotency_key_reused`.
- **and if new key:** book it. The unique constraint is the backstop.

Failed attempts aren't stored, so retrying after a `seat_taken` just tries again. The key stops double-booking, not retrying.

## 3. Holds and expiry

I went with **explicit cancel**, not timed holds. Reserve confirms immediately (the spec's response says `confirmed`), so `held` is always 0.

Cancel only frees seats `WHERE reservation_id=? AND user_id=?`, so it **can't resurrect someone else's seat**. It's owner-only (anyone else gets a 404), cancelling twice is a no-op, and the seat is re-bookable right away.

Next would be timed holds: `held` with an `expires_at`, plus a guarded sweeper (`WHERE status='held' AND expires_at < now`).

## 4. Consistency vs availability

**CP.** It's one node and one SQLite file, so there's one source of truth. If the DB is unreachable, `/health/ready` returns 503 and the service is down rather than wrong. Selling a seat twice is way worse than "please retry".

The partition that actually matters is a lost response. The client retries with the same key and gets the same booking back.

## 5. What pages me at 2am (aka why you will call me?)

The metrics are: a confirmed counter, declined by reason, a latency histogram, and seat gauges **read from the DB at scrape time** (so they can't drift from the API). Logs are JSON with a request id on every line.

**Page me if:**
- there's any sustained 5xx (declines are 4xx, so a 5xx is a real bug)
- readiness is failing or the service keeps restarting
- `available + held + confirmed != total` for any show
- p99 reserve latency is over 500ms
- the volume is filling up

**Don't page for** `seat_taken` spikes. That's just on-sale working.

**Verified live on Railway (Singapore):**
- 17.5k requests in 24s, 1 winner per hot seat, **0 × 5xx**, and the API, the 201 responses and `/metrics` all reconcile
- a clean Docker build from GitHub
- data survived a restart

## 6. AI usage: directed vs decided

I used Claude in VS Code as a pair.

**Decided (my calls):**
Well deciding on what stack to take, what owuld be teh structure of the project as well as hwo exactly I'll go about it. would write code roughly or just correctly but then I'll use claude code to add guard rails and auto-complete. 

**Directed (his (AI's) calls):**
Prompt it what errors I need and when, ask it to review my code, make script as wellasfinding documentation for libraries I used (promclient was deprcyated sad ), and help me writing this documentation 

I did the Railway setup, the restart test and the logs recording myself. Happy to extend any part of it live.

## 7. Next

- Postgres for multiple instances
- real auth (RS256 from an identity provider)
- rate limiting
- a Grafana dashboard and alerts
