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

// ---------- helpers ----------

function hashRequest(showId, seats) {
  const canonical = JSON.stringify({ show_id: showId, seats: [...seats].sort() });
  return createHash('sha256').update(canonical).digest('hex');
}


export const reserve = db.transaction(({ showId, userId, seats, idempotencyKey }) => {
  const show = getShow.get(showId);
  if (!show) throw domainError(404, 'show_not_found');

  const reservationId = randomUUID();
  const label = seats[0];

  const result = takeSeat.run({
    user_id: userId,
    reservation_id: reservationId,
    show_id: showId,
    label,
  });

  // changes === 1 ---> we won the seat else its taken or just doenst exists
  if (result.changes !== 1) {
    if (!seatExists.get(showId, label)) throw domainError(400, 'unknown_seat');
    throw domainError(409, 'seat_taken');
  }

  const amount = show.price_paise * seats.length; // integer paise, computed server-side

  insertReservation.run({
    id: reservationId,
    show_id: showId,
    user_id: userId,
    idempotency_key: idempotencyKey,
    request_hash: hashRequest(showId, seats),
    seats: JSON.stringify(seats),
    amount_paise: amount,
  });

  return {
    reservation_id: reservationId,
    show_id: showId,
    user_id: userId,
    seats,
    amount_paise: amount,
    status: 'confirmed',
  };
});