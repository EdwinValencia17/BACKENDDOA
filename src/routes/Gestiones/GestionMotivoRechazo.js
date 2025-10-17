// src/routes/Gestiones/GestionMotivoRechazo.js
import express from "express";
import pool from "../../config/db.js";

const router = express.Router();

/* ===== helpers ===== */
const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const cleanSort = (field, order) => {
  const map = {
    codigo: "codigo",
    descripcion: "descripcion",
    fecha_creacion: "fecha_creacion",
  };
  const col = map[field] || "codigo";
  const dir = String(order).toUpperCase() === "DESC" ? "DESC" : "ASC";
  return { col, dir };
};

/* ===== LIST =====
   GET /api/gestion-motivo-rechazo/list
   ?page=1&limit=20&q=&estado=-1&sortField=codigo&sortOrder=ASC
*/
router.get("/list", async (req, res) => {
  try {
    const page = toInt(req.query.page, 1);
    const limit = toInt(req.query.limit, 20);
    const offset = (page - 1) * limit;

    const q = (req.query.q ?? "").trim();
    const estado = (req.query.estado ?? "-1").toString();
    const { col, dir } = cleanSort(req.query.sortField, req.query.sortOrder);

    const params = [];
    const wh = [];
    if (q) {
      params.push(`%${q.toUpperCase()}%`);
      params.push(`%${q.toUpperCase()}%`);
      wh.push(`(UPPER(codigo) LIKE $${params.length - 1} OR UPPER(descripcion) LIKE $${params.length})`);
    }
    if (estado !== "-1") {
      params.push(estado);
      wh.push(`estado_registro = $${params.length}`);
    }
    const WHERE = wh.length ? `WHERE ${wh.join(" AND ")}` : "";

    const sqlCount = `SELECT COUNT(1)::int AS total FROM doa2.motivo_rechazo ${WHERE}`;
    const sqlRows = `
      SELECT
        id_more,
        codigo,
        descripcion,
        fecha_creacion,
        oper_creador,
        fecha_modificacion,
        oper_modifica,
        estado_registro
      FROM doa2.motivo_rechazo
      ${WHERE}
      ORDER BY ${col} ${dir}, id_more ${dir}
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
    console.error("GET /gestion-motivo-rechazo/list", err);
    res.status(500).json({ ok: false, message: "Error listando motivos de rechazo" });
  }
});

/* ===== GET ONE ===== */
router.get("/:id", async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });
  try {
    const { rows } = await pool.query(
      `SELECT id_more, codigo, descripcion, fecha_creacion, oper_creador,
              fecha_modificacion, oper_modifica, estado_registro
         FROM doa2.motivo_rechazo
        WHERE id_more = $1
        LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "No encontrado" });
    res.json({ ok: true, row: rows[0] });
  } catch (err) {
    console.error("GET /gestion-motivo-rechazo/:id", err);
    res.status(500).json({ ok: false, message: "Error consultando motivo" });
  }
});

/* ===== CREATE ===== */
router.post("/", async (req, res) => {
  try {
    const codigo = (req.body?.codigo ?? "").toString().trim();
    const descripcion = (req.body?.descripcion ?? "").toString().trim();
    const estado = (req.body?.estado_registro ?? "A").toString().trim() === "I" ? "I" : "A";
    const oper = (req.body?.oper ?? "WEB").toString().slice(0, 60);

    if (!codigo) return res.status(400).json({ ok: false, message: "El código es obligatorio" });
    if (!descripcion) return res.status(400).json({ ok: false, message: "La descripción es obligatoria" });

    const { rows } = await pool.query(
      `INSERT INTO doa2.motivo_rechazo
         (codigo, descripcion, fecha_creacion, oper_creador, estado_registro)
       VALUES ($1, $2, NOW(), $3, $4)
       RETURNING id_more`,
      [codigo, descripcion, oper, estado]
    );
    res.json({ ok: true, id: rows[0].id_more });
  } catch (err) {
    console.error("POST /gestion-motivo-rechazo", err);
    res.status(500).json({ ok: false, message: "Error creando motivo" });
  }
});

/* ===== UPDATE ===== */
router.put("/:id", async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });

  try {
    const codigo = (req.body?.codigo ?? "").toString().trim();
    const descripcion = (req.body?.descripcion ?? "").toString().trim();
    const estado = (req.body?.estado_registro ?? "A").toString().trim() === "I" ? "I" : "A";
    const oper = (req.body?.oper ?? "WEB").toString().slice(0, 60);

    if (!codigo) return res.status(400).json({ ok: false, message: "El código es obligatorio" });
    if (!descripcion) return res.status(400).json({ ok: false, message: "La descripción es obligatoria" });

    const upd = await pool.query(
      `UPDATE doa2.motivo_rechazo
          SET codigo=$1,
              descripcion=$2,
              estado_registro=$3,
              fecha_modificacion=NOW(),
              oper_modifica=$4
        WHERE id_more=$5`,
      [codigo, descripcion, estado, oper, id]
    );
    if (!upd.rowCount) return res.status(404).json({ ok: false, message: "No encontrado" });
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /gestion-motivo-rechazo/:id", err);
    res.status(500).json({ ok: false, message: "Error actualizando motivo" });
  }
});

/* ===== SET ESTADO ===== */
router.patch("/:id/estado", async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });
  try {
    const estado = (req.body?.estado_registro ?? "A").toString().trim() === "I" ? "I" : "A";
    const oper = (req.body?.oper ?? "WEB").toString().slice(0, 60);

    const upd = await pool.query(
      `UPDATE doa2.motivo_rechazo
          SET estado_registro=$1,
              fecha_modificacion=NOW(),
              oper_modifica=$2
        WHERE id_more=$3`,
      [estado, oper, id]
    );
    if (!upd.rowCount) return res.status(404).json({ ok: false, message: "No encontrado" });
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /gestion-motivo-rechazo/:id/estado", err);
    res.status(500).json({ ok: false, message: "Error cambiando estado" });
  }
});

export default router;
