import express from "express"
import {db} from '../db.js'

export const showsRouter =express.Router()

//queries 
const getShow=db.prepare(`select * from shows WHERE id = ?`)

const getSeats= db.prepare(`select label, status from seats  WHERE show_id = ? ORDER BY rowid`)


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