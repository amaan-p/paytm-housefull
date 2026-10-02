import { db } from '../src/db.js';

db.prepare(`
  INSERT OR IGNORE INTO shows (id, name, price_paise, total_seats)
  VALUES ('test-1', 'friday-night', 25000, 3)
`).run();

const insertSeat = db.prepare(`
  INSERT OR IGNORE INTO seats (show_id, label) VALUES ('test-1', ?)
`);
for (const label of ['A1', 'A2', 'A3']) {
  insertSeat.run(label);
}

console.log('seeded test-1');
