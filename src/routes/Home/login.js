import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from '../../config/db.js';
import authMiddleware from '../../middlewares/auth.middleware.js'; // usa el tuyo
const router = express.Router();

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

/* -------------------- helpers SQL -------------------- */

// Prioridad de roles (ajusta a tu gusto)
const ROLE_RANK = {
  ADMIN: 3,
  APROBADOR: 2,
  USUARIO: 1,
};

// Dado un array de códigos, elige el más “fuerte”
function pickPrimaryRole(codes = []) {
  if (codes.includes('ADMIN')) return 'ADMIN';
  if (codes.includes('APROBADOR')) return 'APROBADOR';
  if (codes.includes('USUARIO')) return 'USUARIO';
  return 'USUARIO';
}

// Trae usuario + persona + roles
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
         OR p.id_pers = u.persona_id_pers
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
// src/routes/auth.js (o donde tengas el login)
router.post('/auth/login', async (req, res) => {
  try {
    const { globalId, password } = req.body ?? {};
    if (!globalId || !password) return res.status(400).json({ error: 'Faltan credenciales' });

    // Trae usuario + persona + roles
    const { rows } = await pool.query(`
      WITH base AS (
        SELECT u.id_uccc, u.global_id, u.password_hash, u.estado,
               COALESCE(u.persona_id_pers, p.id_pers) AS id_pers
        FROM doa2.usuario_cuenta u
        LEFT JOIN doa2.persona p
               ON p.identificacion = u.global_id
        WHERE u.global_id = $1
      )
      SELECT b.*, r.codigo AS rol_codigo
      FROM base b
      LEFT JOIN doa2.rol_x_persona rp
             ON rp.persona_id_pers = b.id_pers AND rp.estado_registro = 'A'
      LEFT JOIN doa2.rol r
             ON r.id_rol = rp.rol_id_rol AND r.estado_registro = 'A'
    `, [globalId]);

    if (!rows.length) return res.status(401).json({ error: 'Credenciales inválidas' });

    const u = rows[0];
    if (u.estado !== 'A') return res.status(401).json({ error: 'Cuenta inactiva' });

    // Validar password con el primer row (todos comparten password_hash)
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    // Junta todos los roles
    const roles = Array.from(new Set(rows.map(r => r.rol_codigo).filter(Boolean)));

    // Elige principal (ADMIN > APROBADOR > USUARIO)
    const pickPrimaryRole = (arr) => {
      if (arr.includes('ADMIN')) return 'ADMIN';
      if (arr.includes('APROBADOR')) return 'APROBADOR';
      return arr[0] || 'USUARIO';
    };
    const role = pickPrimaryRole(roles);

    const token = jwt.sign(
      { sub: String(u.id_uccc), globalId: u.global_id, roles, role },
      SECRET,
      { expiresIn: '2h' }
    );

    res.json({
      token,
      user: {
        id: String(u.id_uccc),
        globalId: u.global_id,
        email: '',
        name: u.global_id,
        role,     // <- AHORA VIENE DE BD
        roles,    // <- todos los roles por si los necesitas en el front
      },
    });
  } catch (e) {
    console.error('❌ Error login:', e);
    res.status(500).json({ error: 'Error de autenticación' });
  }
});
/* -------------------- QUIÉN SOY -------------------- */
router.get('/auth/me', authMiddleware, async (req, res) => {
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
    res.status(500).json({ error: 'No se pudo resolver /me' });
  }
});

/* -------------------- LOGOUT (audita) -------------------- */
router.post('/auth/logout', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.sub;
    await pool.query(
      `INSERT INTO doa2.usuario_session_log (usuario_id, evento, ip, user_agent, creado_en)
       VALUES ($1,'LOGOUT',$2,$3,now())`,
      [userId, req.ip || null, req.headers['user-agent'] || null]
    );
    await pool.query(
      `UPDATE doa2.usuario_cuenta SET ultimo_cierre_sesion = now() WHERE id_uccc = $1`,
      [userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ Error logout:', e);
    res.status(500).json({ error: 'No se pudo cerrar sesión' });
  }
});

/* -------------------- REGISTER (usuario + persona + rol) -------------------- */
/*
  Body:
  {
    globalId, password,
    persona: { identificacion, nombre, email },
    roleCode: "ADMIN" | "APROBADOR" | "USUARIO"
  }
*/
router.post('/auth/register', authMiddleware, async (req, res) => {
  // (si sólo admin puede crear, comprueba req.user.role === 'ADMIN')
  const client = await pool.connect();
  try {
    const { globalId, password, persona = {}, roleCode = 'USUARIO' } = req.body ?? {};
    if (!globalId || !password || !persona.identificacion || !persona.nombre) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    await client.query('BEGIN');

    // crea/obtén persona
    const pSel = await client.query(
      `SELECT id_pers FROM doa2.persona WHERE identificacion = $1`,
      [persona.identificacion]
    );
    let personaId = pSel.rows[0]?.id_pers;
    if (!personaId) {
      const pIns = await client.query(
        `INSERT INTO doa2.persona (identificacion, nombre, email, fecha_creacion, oper_creador, estado_registro)
         VALUES ($1,$2,$3,now(),'SISTEMA','A')
         RETURNING id_pers`,
        [persona.identificacion, persona.nombre, persona.email || null]
      );
      personaId = pIns.rows[0].id_pers;
    }

    // crea usuario_cuenta
    const passHash = await bcrypt.hash(password, 10);
    const uIns = await client.query(
      `INSERT INTO doa2.usuario_cuenta
         (global_id, password_hash, estado, creado_en, actualizado_en, persona_id_pers)
       VALUES ($1,$2,'A',now(),now(),$3)
       RETURNING id_uccc`,
      [globalId, passHash, personaId]
    );
    const userId = uIns.rows[0].id_uccc;

    // vincula rol
    const rolSel = await client.query(
      `SELECT id_rol FROM doa2.rol WHERE codigo = $1 AND estado_registro='A'`,
      [roleCode]
    );
    if (!rolSel.rows.length) throw new Error(`Rol no existe: ${roleCode}`);
    const rolId = rolSel.rows[0].id_rol;

    await client.query(
      `INSERT INTO doa2.rol_x_persona
         (fecha_creacion, oper_creador, estado_registro, persona_id_pers, rol_id_rol)
       VALUES (now(),'SISTEMA','A',$1,$2)`,
      [personaId, rolId]
    );

    await client.query('COMMIT');
    res.json({ ok: true, userId, personaId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ register error:', e);
    res.status(500).json({ error: 'No se pudo registrar' });
  } finally {
    client.release();
  }
});

export default router;
