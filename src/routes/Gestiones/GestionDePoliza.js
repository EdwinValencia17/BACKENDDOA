// src/routes/Gestiones/GestionDePoliza.js
import express from "express";
import pool from "../../config/db.js";

const router = express.Router();

/* ============ Helpers ============ */
const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const cleanSort = (field, order) => {
  const map = {
    descripcion: 'descripcion',
    porcentaje: 'porcentaje',
    posicion: 'posicion',
    fecha_creacion: 'fecha_creacion'
  };
  const col = map[field] || 'descripcion';
  const dir = String(order).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  return { col, dir };
};

/* ============ LIST ============ 
   GET /api/gestion-tipo-poliza/list
   ?page=1&limit=20&q=&estado=-1&sortField=descripcion&sortOrder=ASC
*/
router.get("/list", async (req, res) => {
  try {
    const page = toInt(req.query.page, 1);
    const limit = toInt(req.query.limit, 20);
    const q = (req.query.q ?? "").trim();
    const estado = (req.query.estado ?? "-1").toString();
    const { col, dir } = cleanSort(req.query.sortField, req.query.sortOrder);
    const offset = (page - 1) * limit;

    const params = [];
    const wh = [];
    if (q) {
      params.push(`%${q.toUpperCase()}%`);
      wh.push(`UPPER(descripcion) LIKE $${params.length}`);
    }
    if (estado !== "-1") {
      params.push(estado);
      wh.push(`estado_registro = $${params.length}`);
    }
    const WHERE = wh.length ? `WHERE ${wh.join(" AND ")}` : "";

    const sqlCount = `SELECT COUNT(1)::int AS total FROM doa2.tipo_poliza ${WHERE}`;
    const sqlRows = `
      SELECT
        id_tipo,
        descripcion,
        porcentaje::float8,
        posicion,
        fecha_creacion,
        oper_creador,
        fecha_modificacion,
        oper_modifica,
        estado_registro
      FROM doa2.tipo_poliza
      ${WHERE}
      ORDER BY ${col} ${dir}, id_tipo ${dir}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [cRes, rRes] = await Promise.all([
      pool.query(sqlCount, params),
      pool.query(sqlRows, params),
    ]);

    res.json({
      ok: true,
      data: rRes.rows || [],
      page,
      pageSize: limit,
      total: cRes.rows?.[0]?.total ?? 0,
    });
  } catch (err) {
    console.error("GET /gestion-tipo-poliza/list", err);
    res.status(500).json({ ok: false, message: "Error listando tipos de póliza" });
  }
});

/* ============ GET ONE ============ */
router.get("/:id", async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });
  try {
    const { rows } = await pool.query(
      `SELECT id_tipo, descripcion, porcentaje::float8, posicion, fecha_creacion, oper_creador,
              fecha_modificacion, oper_modifica, estado_registro
         FROM doa2.tipo_poliza
        WHERE id_tipo = $1
        LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "No encontrado" });
    res.json({ ok: true, row: rows[0] });
  } catch (err) {
    console.error("GET /gestion-tipo-poliza/:id", err);
    res.status(500).json({ ok: false, message: "Error consultando tipo de póliza" });
  }
});

/* ============ CREATE ============ */
router.post("/", async (req, res) => {
  try {
    const descripcion = (req.body?.descripcion ?? "").toString().trim();
    const porcentaje = Number(req.body?.porcentaje ?? 0);
    const posicion = toInt(req.body?.posicion ?? 0, 0);
    const estado = (req.body?.estado_registro ?? "A").toString().trim() === "I" ? "I" : "A";
    const oper = (req.body?.oper ?? "WEB").toString().slice(0, 60);

    if (!descripcion) return res.status(400).json({ ok: false, message: "La descripción es obligatoria" });
    if (Number.isNaN(porcentaje) || porcentaje < 0 || porcentaje > 100)
      return res.status(400).json({ ok: false, message: "Porcentaje inválido (0–100)" });

    const { rows } = await pool.query(
      `INSERT INTO doa2.tipo_poliza
         (descripcion, porcentaje, posicion, fecha_creacion, oper_creador, estado_registro)
       VALUES ($1, $2, $3, NOW(), $4, $5)
       RETURNING id_tipo`,
      [descripcion, porcentaje, posicion, oper, estado]
    );
    res.json({ ok: true, id: rows[0].id_tipo });
  } catch (err) {
    console.error("POST /gestion-tipo-poliza", err);
    res.status(500).json({ ok: false, message: "Error creando tipo de póliza" });
  }
});

/* ============ UPDATE ============ */
router.put("/:id", async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });
  try {
    const descripcion = (req.body?.descripcion ?? "").toString().trim();
    const porcentaje = Number(req.body?.porcentaje ?? 0);
    const posicion = toInt(req.body?.posicion ?? 0, 0);
    const estado = (req.body?.estado_registro ?? "A").toString().trim() === "I" ? "I" : "A";
    const oper = (req.body?.oper ?? "WEB").toString().slice(0, 60);

    if (!descripcion) return res.status(400).json({ ok: false, message: "La descripción es obligatoria" });
    if (Number.isNaN(porcentaje) || porcentaje < 0 || porcentaje > 100)
      return res.status(400).json({ ok: false, message: "Porcentaje inválido (0–100)" });

    const upd = await pool.query(
      `UPDATE doa2.tipo_poliza
          SET descripcion = $1,
              porcentaje  = $2,
              posicion    = $3,
              estado_registro = $4,
              fecha_modificacion = NOW(),
              oper_modifica = $5
        WHERE id_tipo = $6`,
      [descripcion, porcentaje, posicion, estado, oper, id]
    );
    if (!upd.rowCount) return res.status(404).json({ ok: false, message: "No encontrado" });
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /gestion-tipo-poliza/:id", err);
    res.status(500).json({ ok: false, message: "Error actualizando tipo de póliza" });
  }
});

/* ============ SET ESTADO ============ */
router.patch("/:id/estado", async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });
  try {
    const estado = (req.body?.estado_registro ?? "A").toString().trim() === "I" ? "I" : "A";
    const oper = (req.body?.oper ?? "WEB").toString().slice(0, 60);

    const upd = await pool.query(
      `UPDATE doa2.tipo_poliza
          SET estado_registro = $1,
              fecha_modificacion = NOW(),
              oper_modifica = $2
        WHERE id_tipo = $3`,
      [estado, oper, id]
    );
    if (!upd.rowCount) return res.status(404).json({ ok: false, message: "No encontrado" });
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /gestion-tipo-poliza/:id/estado", err);
    res.status(500).json({ ok: false, message: "Error cambiando estado" });
  }
});

export default router;
