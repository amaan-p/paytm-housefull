// On-sale stampede against a live (or local) server, then verify every correctness rule.
//
// Usage:  ADMIN_KEY=... node scripts/burst.js <BASE_URL>
// Tuning (env, optional): SEATS HOT_SEATS HOT_USERS REQUESTS USERS CONCURRENCY
//
// Phases:
//   1. hot-seat storm : HOT_USERS different users per hot seat, all grabbing the same seat
//   2. stampede       : REQUESTS reserves from USERS users, biased to the "good" front seats,
//                       ~10% exact retries (same key + body), ~2% same key with different seats
//   3. limit + spoof  : one user fires 10 parallel reserves on a limit-4 show; a user sends a
//                       spoofed user_id in the body and tries to cancel someone else's booking
//   4. reconcile      : API state vs what we saw vs /metrics. Exit code 1 if any check fails.
import { randomUUID } from 'node:crypto';

const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY;
const num = (name, fallback) => Number(process.env[name]) || fallback;

const CFG = {
  seats: num('SEATS', 200),
  hotSeats: num('HOT_SEATS', 5),
  hotUsers: num('HOT_USERS', 500), // per hot seat
  requests: num('REQUESTS', 15000),
  users: num('USERS', 3000),
  concurrency: num('CONCURRENCY', 300),
};

if (!ADMIN_KEY) {
  console.error('ADMIN_KEY env var is required (same value as on the server)');
  process.exit(2);
}

// ---------- tiny helpers ----------

const randInt = (n) => Math.floor(Math.random() * n);

async function call(method, path, { token, body, headers = {} } = {}) {
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: json };
  } catch (err) {
    return { status: 0, body: { error: 'network_error', message: err.cause?.code || err.message } };
  }
}

// run fn over items with at most `limit` requests in flight
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const tokens = new Map();
async function ensureTokens(userIds) {
  const missing = userIds.filter((u) => !tokens.has(u));
  await runPool(missing, CFG.concurrency, async (u) => {
    const r = await call('POST', '/auth/token', { body: { user_id: u } });
    if (r.status !== 200) throw new Error(`token for ${u} failed: ${r.status} ${JSON.stringify(r.body)}`);
    tokens.set(u, r.body.token);
  });
}

async function metricsText() {
  try { return await (await fetch(BASE + '/metrics')).text(); } catch { return ''; }
}

// value of one metric line, e.g. metric(text, 'seats_available', 'show_id="abc"')
function metric(text, name, labels) {
  const prefix = labels ? `${name}{${labels}} ` : `${name} `;
  const line = text.split('\n').find((l) => l.startsWith(prefix));
  return line ? Number(line.slice(prefix.length)) : 0;
}

const seatLabel = (i) => {
  const row = Math.floor(i / 20);
  return (row < 26 ? String.fromCharCode(65 + row) : `R${row}`) + ((i % 20) + 1);
};

// ---------- outcome bookkeeping ----------

const outcomes = {}; // phase -> { 'confirmed': n, 'replay': n, 'declined:seat_taken': n, '5xx': n, ... }
const reservations = new Map(); // reservation_id -> response body (every distinct booking we saw)

function record(phase, res) {
  const bucket = (outcomes[phase] ??= {});
  let kind;
  if (res.status === 201) {
    kind = reservations.has(res.body.reservation_id) ? 'replay' : 'confirmed';
    reservations.set(res.body.reservation_id, res.body);
  } else if (res.status >= 500) kind = '5xx';
  else if (res.status === 0) kind = 'network_error';
  else kind = `declined:${res.body.error}`;
  bucket[kind] = (bucket[kind] ?? 0) + 1;
  return kind;
}

const reserve = (showId, user, seats, key, extraBody = {}) =>
  call('POST', `/shows/${showId}/reserve`, {
    token: tokens.get(user),
    body: { seats, idempotency_key: key, ...extraBody },
  });

// ---------- main ----------

const checks = [];
const check = (ok, label, detail = '') => checks.push({ ok, label, detail });

console.log(`\nburst → ${BASE}`);
console.log(CFG);

const ready = await call('GET', '/health/ready');
if (ready.status !== 200) {
  console.error('server not ready:', ready.status, ready.body);
  process.exit(1);
}

// admin + shows
const adminTok = await call('POST', '/auth/token', { body: { user_id: 'burst-admin' }, headers: { 'x-admin-key': ADMIN_KEY } });
if (adminTok.status !== 200) {
  console.error('admin token failed:', adminTok.status, adminTok.body);
  process.exit(1);
}
const admin = adminTok.body.token;

const labels = Array.from({ length: CFG.seats }, (_, i) => seatLabel(i));
const created = await call('POST', '/shows', {
  token: admin,
  body: { name: `burst-${Date.now()}`, seats: labels, price_paise: 25000 },
});
if (created.status !== 201) {
  console.error('create show failed:', created.status, created.body);
  process.exit(1);
}
const show = created.body;
console.log(`show ${show.id}: ${show.total_seats} seats, limit ${show.per_user_limit}/user`);

const metricsBefore = await metricsText();
const started = Date.now();

// ---- phase 1: hot-seat storm ----
const hotSeats = labels.slice(0, CFG.hotSeats);
const hotJobs = [];
for (const seat of hotSeats) {
  for (let u = 0; u < CFG.hotUsers; u++) hotJobs.push({ user: `hot-${seat}-${u}`, seat });
}
await ensureTokens(hotJobs.map((j) => j.user));

console.log(`\n[1] hot-seat storm: ${hotJobs.length} requests on ${hotSeats.length} seats`);
const hotWinners = Object.fromEntries(hotSeats.map((s) => [s, 0]));
await runPool(hotJobs.sort(() => Math.random() - 0.5), CFG.concurrency, async (j) => {
  const res = await reserve(show.id, j.user, [j.seat], randomUUID());
  if (record('hot-seat storm', res) === 'confirmed') hotWinners[j.seat]++;
});
for (const seat of hotSeats) {
  check(hotWinners[seat] === 1, `hot seat ${seat}: exactly one winner`, `${hotWinners[seat]} winners of ${CFG.hotUsers}`);
}

// ---- phase 2: stampede ----
const users = Array.from({ length: CFG.users }, (_, i) => `user-${i}`);
await ensureTokens(users);

const regular = labels.slice(CFG.hotSeats);
const goodSeats = Math.max(1, Math.floor(regular.length * 0.2));
const pickSeats = () => {
  const i = randInt(Math.random() < 0.6 ? goodSeats : regular.length); // 60% fight over the front 20%
  return Math.random() < 0.2 && i + 1 < regular.length ? [regular[i], regular[i + 1]] : [regular[i]];
};

const jobs = [];
for (let i = 0; i < CFG.requests; i++) {
  const r = Math.random();
  if (r < 0.10 && jobs.length) {
    jobs.push({ ...jobs[randInt(jobs.length)] }); // exact retry: same user, key and seats
  } else if (r < 0.12 && jobs.length) {
    const orig = jobs[randInt(jobs.length)];
    jobs.push({ user: orig.user, key: orig.key, seats: pickSeats() }); // same key, different seats
  } else {
    jobs.push({ user: users[randInt(users.length)], key: randomUUID(), seats: pickSeats() });
  }
}

console.log(`[2] stampede: ${jobs.length} requests from ${users.length} users`);
await runPool(jobs, CFG.concurrency, async (j) => record('stampede', await reserve(show.id, j.user, j.seats, j.key)));

// ---- phase 3: per-user limit under concurrency + identity spoofing ----
const limitShow = (await call('POST', '/shows', {
  token: admin,
  body: { name: `limit-${Date.now()}`, seats: Array.from({ length: 12 }, (_, i) => `L${i}`), price_paise: 25000, per_user_limit: 4 },
})).body;
await ensureTokens(['limit-tester', 'spoofer']);

console.log(`[3] limit test: 1 user, 10 parallel reserves, limit 4`);
const limitResults = await Promise.all(
  Array.from({ length: 10 }, (_, i) => reserve(limitShow.id, 'limit-tester', [`L${i}`], randomUUID())),
);
limitResults.forEach((r) => record('limit test', r));
const limitWins = limitResults.filter((r) => r.status === 201).length;
check(limitWins <= 4, 'per-user limit holds under 10 parallel requests', `${limitWins} confirmed (limit 4)`);

const spoof = await reserve(limitShow.id, 'spoofer', ['L11'], randomUUID(), { user_id: 'limit-tester' });
record('limit test', spoof);
check(spoof.status === 201 && spoof.body.user_id === 'spoofer', 'spoofed body user_id is ignored', `booked as ${spoof.body.user_id}`);

const victimBooking = limitResults.find((r) => r.status === 201)?.body.reservation_id;
const stolenCancel = await call('POST', `/reservations/${victimBooking}/cancel`, { token: tokens.get('spoofer') });
check(stolenCancel.status === 404, "cannot cancel someone else's reservation", `got ${stolenCancel.status}`);

const elapsed = (Date.now() - started) / 1000;

// ---------- reconcile ----------

const state = (await call('GET', `/shows/${show.id}`)).body;
const { available, held, confirmed } = state.counts;
check(available + held + confirmed === state.total_seats, 'available + held + confirmed == total_seats',
  `${available} + ${held} + ${confirmed} = ${available + held + confirmed} / ${state.total_seats}`);

// every distinct booking we were handed, for the main show
const mainBookings = [...reservations.values()].filter((r) => r.show_id === show.id);
const owner = new Map(); // seat -> reservation_id
let doubleSold = 0;
for (const b of mainBookings) {
  for (const seat of b.seats) {
    if (owner.has(seat) && owner.get(seat) !== b.reservation_id) doubleSold++;
    owner.set(seat, b.reservation_id);
  }
}
check(doubleSold === 0, 'no seat confirmed to two reservations', `${doubleSold} double-sold seats`);

const apiConfirmed = new Set(state.seats.filter((s) => s.status === 'confirmed').map((s) => s.label));
const sameSet = apiConfirmed.size === owner.size && [...owner.keys()].every((s) => apiConfirmed.has(s));
check(sameSet, 'confirmed seats in API == seats in 201 responses', `API ${apiConfirmed.size}, responses ${owner.size}`);

const perUser = new Map();
for (const b of mainBookings) perUser.set(b.user_id, (perUser.get(b.user_id) ?? 0) + b.seats.length);
const maxPerUser = Math.max(0, ...perUser.values());
check(maxPerUser <= state.per_user_limit, 'no user above per_user_limit', `max seats held by one user: ${maxPerUser}`);

const total5xx = Object.values(outcomes).reduce((n, o) => n + (o['5xx'] ?? 0), 0);
check(total5xx === 0, 'zero 5xx across the burst', `${total5xx} x 5xx`);

// metrics must agree with the API
const metricsAfter = await metricsText();
const showLabel = `show_id="${show.id}"`;
check(metric(metricsAfter, 'seats_available', showLabel) === available, 'metrics seats_available == API',
  `metrics ${metric(metricsAfter, 'seats_available', showLabel)}, API ${available}`);
check(metric(metricsAfter, 'seats_confirmed', showLabel) === confirmed, 'metrics seats_confirmed == API',
  `metrics ${metric(metricsAfter, 'seats_confirmed', showLabel)}, API ${confirmed}`);

const confirmedDelta = metric(metricsAfter, 'reservations_confirmed_total') - metric(metricsBefore, 'reservations_confirmed_total');
check(confirmedDelta === reservations.size, 'reservations_confirmed_total moved by exactly our bookings',
  `delta ${confirmedDelta}, bookings seen ${reservations.size} (exact only if no one else is hitting the server)`);

// ---------- report ----------

console.log(`\n=== outcome distribution (${elapsed.toFixed(1)}s) ===`);
for (const [phase, o] of Object.entries(outcomes)) {
  const total = Object.values(o).reduce((a, b) => a + b, 0);
  console.log(`\n${phase} (${total} requests)`);
  for (const [k, v] of Object.entries(o).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(34)} ${String(v).padStart(6)}`);
  }
}

console.log(`\n=== reconciliation: show ${show.id} ===`);
console.log(`  available ${available} + held ${held} + confirmed ${confirmed} = ${available + held + confirmed} (total ${state.total_seats})`);

console.log('\n=== checks ===');
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}  ${c.detail ? `(${c.detail})` : ''}`);

const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0; // let node exit on its own (process.exit after fetch crashes on Windows)
