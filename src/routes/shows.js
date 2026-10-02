import express from "express"
import {db} from '../db.js'
import { randomUUID } from 'node:crypto';

export const showsRouter =express.Router()
const MAX_SEATS = Number(process.env.MAX_SEATS) || 50000;

//queries 
const getShow=db.prepare(`select * from shows WHERE id = ?`)

const getSeats= db.prepare(`select label, status from seats  WHERE show_id = ? ORDER BY rowid`)

const insertShow =db.prepare(`insert into shows (id, name, price_paise, per_user_limit, total_seats)
  VALUES(@id, @name, @price_paise, @per_user_limit, @total_seats)`)

const insertSeat = db.prepare(`insert INTO seats (show_id, label) VALUES (?, ?)`);
 

const createShow = db.transaction((show, seats) => {
  insertShow.run(show);
  for (const label of seats) {
    insertSeat.run(show.id, label);
  }
});


//validator
function validateCreateShow(body) {
  const { name, seats, price_paise, per_user_limit = 4 } = body ?? {};

  if (typeof name !== 'string' || name.trim() === '')
    return 'name must be a non-empty string';
  if (!Array.isArray(seats) || seats.length === 0)
    return 'seats must be a non-empty array';
  if (seats.length > MAX_SEATS)
    return `seats cannot exceed ${MAX_SEATS}`;
  if (!seats.every(s => typeof s === 'string' && s.trim() !== ''))
    return 'each seat must be a non-empty string';
  if (new Set(seats).size !== seats.length)
    return 'duplicate seat labels';
  if (!Number.isSafeInteger(price_paise) || price_paise <= 0)
    return 'price_paise must be a positive integer (paise)';
  if (!Number.isSafeInteger(per_user_limit) || per_user_limit <= 0)
    return 'per_user_limit must be a positive integer';

  return null;
}



//ROUTES////////

//get route for a particular show & its seats
showsRouter.get("/:id",(req,res)=>{
  const show = getShow.get(req.params.id);
  if (!show) {
    return res.status(404).json({ error: 'show_not_found' });
  }

  const seats = getSeats.all(show.id);
  const counts = { available: 0, held: 0, confirmed: 0 };
  for (const seat of seats) {
    counts[seat.status]++;
  }

  res.json({ ...show, seats, counts });
})


showsRouter.post("/",(req,res)=>{
      const error = validateCreateShow(req.body);
  if (error) {
    return res.status(400).json({ error: 'validation_failed', message: error });
  }
  const { name, seats, price_paise, per_user_limit = 4 } = req.body;
  
  const show = {
    id: randomUUID(),
    name,
    price_paise,
    per_user_limit,
    total_seats: seats.length,
  };

  createShow(show, seats);

res.status(201).json({
    ...show,
    seats: seats.map(label => ({ label, status: 'available' })),
    counts: { available: seats.length, held: 0, confirmed: 0 },
  });
})
