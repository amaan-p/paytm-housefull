import express from "express"
import {db} from '../db.js'
import { randomUUID } from 'node:crypto';

export const showsRouter =express.Router()

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
