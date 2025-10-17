// src/routes/Home/auth.js
// 👇 Rutas de autenticación (Express + JWT). Requiere: pool (pg), authMiddleware (verifica Bearer).
/*import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../../config/db.js';
import authMiddleware from '../../middlewares/auth.middleware.js';

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

/* -------------------- helpers -------------------- */

// Escoge el rol principal con prioridad
/*function pickPrimaryRole(codes = []) {
  if (codes.includes('ADMIN')) return 'ADMIN';
  if (codes.includes('APROBADOR')) return 'APROBADOR';
  if (codes.includes('USUARIO')) return 'USUARIO';
  return 'USUARIO';
}

// 🔎 Trae usuario + persona + roles
//  - JOIN por persona.identificacion = usuario_cuenta.global_id (según tu modelo)
//  - NO usamos u.persona_id_pers (para evitar el error de columna)
async function findUserWithPersonaAndRoles(globalId) {
  const sql = `
    SELECT
      u.id_uccc,
      u.global_id,
      u.password_hash,
      u.estado,
      p.id_pers,
      p.nombre,
      p.email,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT r.codigo) FILTER (WHERE r.codigo IS NOT NULL), NULL) AS roles
    FROM doa2.usuario_cuenta u
    LEFT JOIN doa2.persona p
      ON p.identificacion = u.global_id
    LEFT JOIN doa2.rol_x_persona rp
      ON rp.persona_id_pers = p.id_pers
     AND rp.estado_registro = 'A'
    LEFT JOIN doa2.rol r
      ON r.id_rol = rp.rol_id_rol
     AND r.estado_registro = 'A'
    WHERE u.global_id = $1
    GROUP BY u.id_uccc, u.global_id, u.password_hash, u.estado, p.id_pers, p.nombre, p.email
  `;
  const { rows } = await pool.query(sql, [globalId]);
  return rows[0];
}

/* -------------------- LOGIN -------------------- */
/*router.post('/auth/login', async (req, res) => {
  try {
    let { globalId, password } = req.body ?? {};
    if (!globalId || !password) {
      return res.status(400).json({ error: 'Faltan credenciales' });
    }

    // ✨ Normalizamos el globalId (evita problemas de mayúsculas/espacios)
    globalId = String(globalId).trim().toUpperCase();

    // Buscamos usuario + persona + roles
    const u = await findUserWithPersonaAndRoles(globalId);
    if (!u) return res.status(401).json({ error: 'Credenciales inválidas' });
    if (u.estado !== 'A') return res.status(401).json({ error: 'Cuenta inactiva' });

    // Validamos contraseña
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    // Roles y rol principal
    const roles = u.roles || [];
    const role = pickPrimaryRole(roles);

    // 🧾 Token (2h). Si quieres refresh tokens, sería otro flujo aparte.
    const token = jwt.sign(
      { sub: String(u.id_uccc), globalId: u.global_id, roles, role },
      SECRET,
      { expiresIn: '2h' }
    );

    // Respondemos con token + datos mínimos de usuario
    res.json({
      token,
      user: {
        id: String(u.id_uccc),
        globalId: u.global_id,
        email: u.email || '',
        name: u.nombre || u.global_id,
        role,
        roles,
      },
    });
  } catch (e) {
    console.error('❌ Error login:', e);
    res.status(500).json({ error: 'Error de autenticación' });
  }
});

/* -------------------- QUIÉN SOY -------------------- */
/*router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const u = await findUserWithPersonaAndRoles(req.user.globalId);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const role = pickPrimaryRole(u.roles || []);
    res.json({
      id: String(u.id_uccc),
      globalId: u.global_id,
      email: u.email || '',
      name: u.nombre || u.global_id,
      role,
      roles: u.roles || [],
    });
  } catch (e) {
    console.error('❌ /auth/me error:', e);
    res.status(500).json({ error: 'No se pudo resolver /me' });
  }
});

/* -------------------- LOGOUT -------------------- */
// Requiere authMiddleware. Si el token no es válido, Express devolverá 401.
// El front, ante 401, limpiará sesión local (sin volver a llamar a /logout).
/*router.post('/auth/logout', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub;

    // Auditamos el logout (opcional)
    await pool.query(
      `INSERT INTO doa2.usuario_session_log (usuario_id, evento, ip, user_agent, creado_en)
       VALUES ($1,'LOGOUT',$2,$3,now())`,
      [userId, req.ip || null, req.headers['user-agent'] || null]
    );

    // Guardamos último cierre de sesión (opcional)
    await pool.query(
      `UPDATE doa2.usuario_cuenta SET ultimo_cierre_sesion = now() WHERE id_uccc = $1`,
      [userId]
    );

    // 204 = ok sin body
    return res.status(204).end();
  } catch (e) {
    console.error('❌ Error logout:', e);
    res.status(500).json({ error: 'No se pudo cerrar sesión' });
  }
});

export default router;*/
