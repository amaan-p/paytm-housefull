import express from 'express';
import { requireUser } from '../auth.js';
import { cancel } from '../reservations.js';

export const reservationsRouter = express.Router();

reservationsRouter.post('/:id/cancel', requireUser, (req, res) => {
  const reservation = cancel({ reservationId: req.params.id, userId: req.user.id });
  res.json(reservation);
});
