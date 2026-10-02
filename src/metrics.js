import { Counter, Gauge, Histogram, register, collectDefaultMetrics } from '@prometheus-io/client';
import { db } from './db.js';

collectDefaultMetrics();


export { register };

export const reservationsConfirmed = new Counter({
  name: 'reservations_confirmed_total',
  help: 'Reservations successfully created',
});

export const reservationsDeclined = new Counter({
  name: 'reservations_declined_total',
  help: 'Reservations declined, by reason',
  labelNames: ['reason'],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

// Seat gauges: computed from the DB on every scrape → always match GET /shows
const seatCounts = db.prepare(`
  SELECT show_id,
         SUM(status = 'available') AS available,
         SUM(status = 'held')      AS held,
         SUM(status = 'confirmed') AS confirmed
  FROM seats GROUP BY show_id
`);

function seatGauge(name, column) {
  return new Gauge({
    name,
    help: `Seats ${column} per show (read from DB at scrape time)`,
    labelNames: ['show_id'],
    collect() {
      this.reset();
      for (const row of seatCounts.all()) {
        this.set({ show_id: row.show_id }, row[column]);
      }
    },
  });
}

seatGauge('seats_available', 'available');
seatGauge('seats_held', 'held');
seatGauge('seats_confirmed', 'confirmed');