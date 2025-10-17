// src/routes/auth.seguridadjci.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pool from '../../config/db.js';
import authMiddleware from '../../middlewares/auth.middleware.js';

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DEBUG = (process.env.DEBUG_AUTH || '').toLowerCase() === 'true';

/* ------------------------------- helpers ------------------------------- */

function pickPrimaryRole(roles = []) {
  const U = roles.map(r => String(r || '').trim().toUpperCase());
  if (U.includes('ADMIN')) return 'ADMIN';
  if (U.includes('APROBADOR')) return 'APROBADOR';
  if (U.includes('USUARIO')) return 'USUARIO';
  if (U.some(r => r.includes('ADMIN'))) return 'ADMIN';
  if (U.some(r => r.includes('APROB'))) return 'APROBADOR';
  return roles[0] || 'USUARIO';
}

function normalizeBcryptHash(hashRaw) {
  let h = String(hashRaw || '').trim();
  if (h.startsWith('$2y$') || h.startsWith('$2x$')) h = '$2a$' + h.slice(4);
  return h;
}

function isBcryptLike(h) {
  return /^\$2[abxy]\$/.test(String(h || '').trim());
}

function md5hex(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

// usuario + roles (sólo activos=1)
async function getUserAndRoles(login) {
  const normalized = String(login || '').trim().toUpperCase();

  const ures = await pool.query(
    `
    SELECT
      usuarioid,
      usrlogin,
      usrpwd,
      usrnombre,
      usrmail,
      estado,
      roleid
    FROM seguridadjci.usuario
    WHERE UPPER(TRIM(usrlogin)) = $1
    LIMIT 1
    `,
    [normalized]
  );
  if (!ures.rows.length) return null;
  const u = ures.rows[0];

  const rres = await pool.query(
    `
    -- rol directo (activo)
    SELECT r.roledesc
      FROM seguridadjci.roles r
     WHERE r.roleid = $1
       AND COALESCE(r.estado,0) = 1

    UNION

    -- roles por asignación (ambos activos)
    SELECT r2.roledesc
      FROM seguridadjci.rolxusuario rx
      JOIN seguridadjci.roles r2 ON r2.roleid = rx.roleid
     WHERE rx.usuarioid = $2
       AND COALESCE(rx.estado,0) = 1
       AND COALESCE(r2.estado,0) = 1
    `,
    [u.roleid ?? null, u.usuarioid]
  );

  const roles = rres.rows.map(r => r.roledesc).filter(Boolean);
  return { ...u, roles };
}

// personaId en doa2.persona por identificacion = login
async function getPersonaIdByLogin(login) {
  const { rows } = await pool.query(
    `SELECT id_pers
       FROM doa2.persona
      WHERE estado_registro='A'
        AND UPPER(TRIM(identificacion)) = UPPER(TRIM($1))
      LIMIT 1`,
    [String(login || '').trim()]
  );
  return rows[0]?.id_pers ?? null;
}

/* ------------------------------ POST /login ------------------------------ */
router.post('/auth/login', async (req, res) => {
  try {
    const login =
      req.body?.login ??
      req.body?.username ??
      req.body?.usrlogin ??
      req.body?.globalId;
    const password = req.body?.password;

    if (!login || !password) {
      return res.status(400).json({ error: 'Faltan credenciales' });
    }

    const u = await getUserAndRoles(login);
    if (!u) {
      if (DEBUG) console.warn(`[auth] usuario no encontrado: ${String(login).trim().toUpperCase()}`);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // ACTIVO = 1
    if (Number(u.estado) !== 1) {
      return res.status(401).json({ error: 'Cuenta inactiva' });
    }

    const stored = String(u.usrpwd || '').trim();
    let passwordOK = false;

    if (isBcryptLike(stored)) {
      const h = normalizeBcryptHash(stored);
      passwordOK = await bcrypt.compare(String(password), h);
    } else if (/^[a-f0-9]{32}$/i.test(stored)) {
      // legacy MD5 (32 hex)
      const md5Input = md5hex(password);
      if (md5Input.toLowerCase() === stored.toLowerCase()) {
        passwordOK = true;
        // Auto-migración a bcrypt 💫 (best effort)
        try {
          const newHash = await bcrypt.hash(String(password), 10);
          await pool.query(
            `UPDATE seguridadjci.usuario SET usrpwd = $1 WHERE usuarioid = $2`,
            [newHash, u.usuarioid]
          );
          if (DEBUG) console.log(`[auth] migrado a bcrypt usuario ${u.usrlogin}`);
        } catch (e) {
          if (DEBUG) console.warn('[auth] no se pudo migrar a bcrypt:', e.message);
        }
      }
    } else {
      // opcional: permitir texto plano sólo si AUTH_ALLOW_PLAINTEXT=true
      if ((process.env.AUTH_ALLOW_PLAINTEXT || '').toLowerCase() === 'true') {
        passwordOK = stored === String(password);
      }
    }

    if (!passwordOK) {
      if (DEBUG) console.warn(`[auth] contraseña incorrecta para ${u.usrlogin}`);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // personaId para bandeja/autorizador
    const personaId = await getPersonaIdByLogin(u.usrlogin);

    const role = pickPrimaryRole(u.roles || []);
    const token = jwt.sign(
      {
        sub: String(u.usuarioid),
        login: u.usrlogin,
        globalId: u.usrlogin,      // compat con front
        personaId: personaId ?? null,
        roles: u.roles || [],
        role,
      },
      SECRET,
      { expiresIn: '2h' }
    );

    // contador y última entrada
    try {
      await pool.query(`SELECT seguridadjci.incrementarentrada($1)`, [u.usuarioid]);
    } catch (e) {
      if (DEBUG) console.warn('incrementarentrada aviso:', e.message);
    }

    return res.json({
      token,
      user: {
        id: String(u.usuarioid),
        login: u.usrlogin,
        globalId: u.usrlogin,
        personaId: personaId ?? null,
        name: u.usrnombre || u.usrlogin || '',
        email: u.usrmail || '',
        role,
        roles: u.roles || [],
      },
    });
  } catch (e) {
    console.error('❌ /auth/login:', e);
    res.status(500).json({ error: 'Error de autenticación' });
  }
});

/* -------------------------------- GET /me -------------------------------- */
router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const loginFromToken = req.user?.login || req.user?.globalId || '';
    if (!loginFromToken) return res.status(401).json({ error: 'Token inválido' });

    const u = await getUserAndRoles(loginFromToken);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (Number(u.estado) !== 1) return res.status(401).json({ error: 'Cuenta inactiva' });

    const role = pickPrimaryRole(u.roles || []);
    const personaId = await getPersonaIdByLogin(u.usrlogin);

    return res.json({
      id: String(u.usuarioid),
      login: u.usrlogin,
      globalId: u.usrlogin,
      personaId: personaId ?? null,
      name: u.usrnombre || u.usrlogin || '',
      email: u.usrmail || '',
      role,
      roles: u.roles || [],
    });
  } catch (e) {
    console.error('❌ /auth/me:', e);
    res.status(500).json({ error: 'No se pudo resolver /me' });
  }
});

/* ----------------------------- POST /logout ------------------------------ */
router.post('/auth/logout', authMiddleware, async (_req, res) => {
  // Con JWT stateless basta con que el front borre el token.
  res.status(204).end();
});

export default router;
