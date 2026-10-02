import { randomUUID, createHash } from 'node:crypto';
import { db } from './db.js';


// Throwing it inside db.transaction() also triggers the rollback.

function domainError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  err.isDomain = true;
  return err;
}

//queries

const getShow = db.prepare(`
  SELECT id, price_paise, per_user_limit FROM shows WHERE id = ?
`);

const findByKey = db.prepare(`
  SELECT * FROM reservations WHERE user_id = ? AND idempotency_key = ?
`);

// per-user limit: add n seats ONLY IF the total stays within the limit
const addToUserCount = db.prepare(`
  INSERT INTO user_show_seats (show_id, user_id, count) VALUES (@show_id, @user_id, @n)
  ON CONFLICT (show_id, user_id) DO UPDATE SET count = count + excluded.count
  WHERE count + excluded.count <= @limit
`);

//take a seat if its available uk
const takeSeat = db.prepare(`
  UPDATE seats
  SET status = 'confirmed', user_id = @user_id, reservation_id = @reservation_id
  WHERE show_id = @show_id AND label = @label AND status = 'available'
`);

const seatExists = db.prepare(`
  SELECT 1 FROM seats WHERE show_id = ? AND label = ?
`);

const insertReservation = db.prepare(`
  INSERT INTO reservations (id, show_id, user_id, idempotency_key, request_hash, seats, amount_paise)
  VALUES (@id, @show_id, @user_id, @idempotency_key, @request_hash, @seats, @amount_paise)
`);

const getReservation = db.prepare(`SELECT * FROM reservations WHERE id = ?`);

const markCancelled = db.prepare(`
  UPDATE reservations SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'
`);

// only frees seats that STILL belong to this reservation + user → can't resurrect someone else's seat
const releaseSeats = db.prepare(`
  UPDATE seats SET status = 'available', user_id = NULL, reservation_id = NULL
  WHERE reservation_id = ? AND user_id = ?
`);

const subtractFromUserCount = db.prepare(`
  UPDATE user_show_seats SET count = count - ? WHERE show_id = ? AND user_id = ?
`);

// ---------- helpers ----------

// same show + same seats (any order) → same hash
const hashRequest = (showId, seats) =>
  createHash('sha256').update(showId + ':' + [...seats].sort().join(',')).digest('hex');

const toResponse = (row) => ({
  reservation_id: row.id,
  show_id: row.show_id,
  user_id: row.user_id,
  seats: JSON.parse(row.seats),
  amount_paise: row.amount_paise,
  status: row.status,
});

// ---------- reserve ----------

export const reserve = db.transaction(({ showId, userId, seats, idempotencyKey }) => {
  const hash = hashRequest(showId, seats);

  // 1. idempotency: same key seen before?
  const existing = findByKey.get(userId, idempotencyKey);
  if (existing) {
    if (existing.request_hash !== hash) throw domainError(409, 'idempotency_key_reused');
    return { reservation: toResponse(existing), replayed: true };
  }

  // 2. show exists?
  const show = getShow.get(showId);
  if (!show) throw domainError(404, 'show_not_found');

  // 3. per-user limit (guarded counter)
  if (seats.length > show.per_user_limit) throw domainError(409, 'per_user_limit');
  const counted = addToUserCount.run({
    show_id: showId, user_id: userId, n: seats.length, limit: show.per_user_limit,
  });
  if (counted.changes !== 1) throw domainError(409, 'per_user_limit');

  // 4. take every seat in SORTED order; any failure → throw → whole thing rolls back
  const reservationId = randomUUID();
  const sorted = [...seats].sort();
  for (const label of sorted) {
    const result = takeSeat.run({
      user_id: userId, reservation_id: reservationId, show_id: showId, label,
    });
    // changes === 1 ---> we won the seat else its taken or just doenst exists
    if (result.changes !== 1) {
      if (!seatExists.get(showId, label)) throw domainError(400, 'unknown_seat');
      throw domainError(409, 'seat_taken');
    }
  }

  // 5. record the reservation
  const row = {
    id: reservationId,
    show_id: showId,
    user_id: userId,
    idempotency_key: idempotencyKey,
    request_hash: hash,
    seats: JSON.stringify(sorted),
    amount_paise: show.price_paise * seats.length, // integer paise, computed server-side
    status: 'confirmed',
  };
  insertReservation.run(row);

  return { reservation: toResponse(row), replayed: false };
});

// ---------- cancel ----------

export const cancel = db.transaction(({ reservationId, userId }) => {
  const row = getReservation.get(reservationId);

  // Not yours (or doesn't exist) → 404, don't reveal it exists
  if (!row || row.user_id !== userId) throw domainError(404, 'reservation_not_found');

  // Already cancelled → just return it (cancel twice = no extra effect)
  if (markCancelled.run(reservationId).changes === 0) {
    return toResponse({ ...row, status: 'cancelled' });
  }

  const freed = releaseSeats.run(reservationId, userId).changes;
  subtractFromUserCount.run(freed, row.show_id, userId);

  return toResponse({ ...row, status: 'cancelled' });
});
