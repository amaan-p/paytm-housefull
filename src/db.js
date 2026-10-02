import Database from 'better-sqlite3'

//INITIALIZING THE DATABSE
const DB_PATH = process.env.DB_PATH || 'data.db';

export const db= new Database(DB_PATH)

//pragmas
db.pragma('journal_mode = WAL');  
db.pragma('foreign_keys = ON'); //thisis off by default by sqlite hence  
db.pragma('busy_timeout = 5000');//5s shoudl be good lock time

db.exec(`Create table if not exists shows(
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    price_paise     INTEGER NOT NULL CHECK (price_paise>0),
    per_user_limit  INTEGER NOT NULL DEFAULT 4 CHECK (per_user_limit > 0),
    total_seats     INTEGER NOT NULL CHECK (total_seats > 0),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);`);

db.exec(`Create table if not exists seats (
    show_id     TEXT NOT NULL REFERENCES shows(id),
    label       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'held', 'confirmed')),
    user_id     TEXT,
    reservation_id  TEXT,
    PRIMARY KEY (show_id, label)
  );`);

db.exec(`Create table if not exists reservations (
    id               TEXT PRIMARY KEY,
    show_id          TEXT NOT NULL REFERENCES shows(id),
    user_id          TEXT NOT NULL,
    idempotency_key  TEXT NOT NULL,
    request_hash     TEXT NOT NULL,
    seats            TEXT NOT NULL,
    amount_paise     INTEGER NOT NULL CHECK (amount_paise > 0),
    status           TEXT NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('confirmed', 'cancelled')),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, idempotency_key);`)
    
db.exec(`Create table if not exists user_show_seats (
    show_id   TEXT NOT NULL REFERENCES shows(id),
    user_id   TEXT NOT NULL,
    count     INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (show_id, user_id)
);`);
