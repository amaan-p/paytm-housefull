import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET is not set');  
}

export function signToken(userId, role = 'user') {
  return jwt.sign({ sub: userId, role }, SECRET, { algorithm: 'HS256', expiresIn: '24h' });
}

export function requireUser(req, res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'missing_token' });
  }
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

export function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'admin_only' });
    }
    next();
  });
}
