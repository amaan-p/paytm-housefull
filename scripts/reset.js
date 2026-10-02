// Wipe all shows/reservations + metrics on a server (needs ALLOW_RESET=true on the server).
// Usage: ADMIN_KEY=... node scripts/reset.js <BASE_URL>
const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!ADMIN_KEY) {
  console.error('ADMIN_KEY env var is required');
  process.exit(2);
}

const post = async (path, headers = {}, body) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const auth = await post('/auth/token', { 'x-admin-key': ADMIN_KEY }, { user_id: 'reset-script' });
if (auth.status !== 200) {
  console.error('could not get admin token:', auth.status, auth.body);
  process.exit(1);
}

const result = await post('/admin/reset', { authorization: `Bearer ${auth.body.token}` });
console.log(`reset ${BASE} →`, result.status, result.body);
process.exitCode = result.status === 200 ? 0 : 1; // let node exit on its own (process.exit after fetch crashes on Windows)
