// src/middlewares/auth.middleware.js
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export default function authMiddleware(req, res, next) {
  // Espera "Authorization: Bearer <token>"
  const h = req.headers.authorization || '';
  const [, token] = h.split(' '); // ["Bearer", "<token>"]

  if (!token) return res.status(401).json({ ok: false, error: 'No autorizado' });

  try {
    const payload = jwt.verify(token, SECRET);
    // payload: { sub, login, globalId, roles, role, iat, exp }
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Token inválido/expirado' });
  }
}
