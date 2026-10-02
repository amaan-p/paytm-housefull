import express from 'express';
import { requireAdmin } from '../auth.js';
import { db } from '../db.js';
import { register } from '../metrics.js';

export const adminRouter = express.Router();

// children first (they reference shows)
const wipeAll = db.transaction(() => {
  db.exec(`
    DELETE FROM reservations;
    DELETE FROM user_show_seats;
    DELETE FROM seats;
    DELETE FROM shows;
  `);
});

// wipe all data + metrics between burst runs. Admin-only AND must be switched on via ALLOW_RESET=true
adminRouter.post('/reset', requireAdmin, (req, res) => {
  if (process.env.ALLOW_RESET !== 'true') {
    return res.status(403).json({ error: 'reset_disabled' });
  }
  wipeAll();
  register.resetMetrics(); // seat gauges re-read the (now empty) DB on next scrape
  req.log.warn({ event: 'data_reset', by: req.user.id }, 'all data wiped');
  res.json({ status: 'reset' });
});
