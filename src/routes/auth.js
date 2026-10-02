import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { signToken } from '../auth.js';

export const authRouter = express.Router();

const USER_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function isAdminKey(given) {
  const expected = process.env.ADMIN_KEY;
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

authRouter.post('/token', (req, res) => {
  const { user_id } = req.body ?? {};
  if (typeof user_id !== 'string' || !USER_ID_PATTERN.test(user_id)) {
    return res.status(400).json({ error: 'validation_failed', message: 'user_id must be 1-64 chars: letters, digits, _ . -' });
  }

  const adminKey = req.get('x-admin-key');
  if (adminKey !== undefined && !isAdminKey(adminKey)) {
    return res.status(403).json({ error: 'invalid_admin_key' });
  }

  const role = adminKey !== undefined ? 'admin' : 'user';
  res.json({ token: signToken(user_id, role), user_id, role });
});
