// src/routes/Gestiones/GestionCategorias.js
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
    categoria: "categoria",
    descripcion: "descripcion",
    fecha_creacion: "fecha_creacion",
  };
  const col = map[field] || "categoria";
  const dir = String(order).toUpperCase() === "DESC" ? "DESC" : "ASC";
  return { col, dir };
};

/* ===== LIST =====
   GET /api/gestion-categorias/list
   ?page=1&limit=20&q=&estado=-1&sortField=categoria&sortOrder=ASC
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
      params.push(`%${q.toUpperCase()}%`);
      wh.push(`(UPPER(categoria) LIKE $${params.length - 2} OR UPPER(descripcion) LIKE $${params.length - 1} OR UPPER(COALESCE(sites,'')) LIKE $${params.length})`);
    }
    if (estado !== "-1") {
      params.push(estado);
      wh.push(`estado_registro = $${params.length}`);
    }
    const WHERE = wh.length ? `WHERE ${wh.join(" AND ")}` : "";

    const sqlCount = `SELECT COUNT(1)::int AS total FROM doa2.categoria ${WHERE}`;
    const sqlRows = `
      SELECT
        id_cate,
        categoria,
        descripcion,
        fecha_creacion,
        oper_creador,
        fecha_modificacion,
        oper_modifica,
        estado_registro,
        sites
      FROM doa2.categoria
      ${WHERE}
      ORDER BY ${col} ${dir}, id_cate ${dir}
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
    console.error("GET /gestion-categorias/list", err);
    res.status(500).json({ ok: false, message: "Error listando categorías" });
  }
});

/* ===== GET ONE ===== */
router.get("/:id", async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });
  try {
    const { rows } = await pool.query(
      `SELECT id_cate, categoria, descripcion, fecha_creacion, oper_creador,
              fecha_modificacion, oper_modifica, estado_registro, sites
         FROM doa2.categoria
        WHERE id_cate = $1
        LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "No encontrado" });
    res.json({ ok: true, row: rows[0] });
  } catch (err) {
    console.error("GET /gestion-categorias/:id", err);
    res.status(500).json({ ok: false, message: "Error consultando categoría" });
  }
});

/* ===== CREATE ===== */
router.post("/", async (req, res) => {
  try {
    const categoria = (req.body?.categoria ?? "").toString().trim();
    const descripcion = (req.body?.descripcion ?? "").toString().trim();
    const sites = (req.body?.sites ?? "").toString().trim() || null;
    const estado = (req.body?.estado_registro ?? "A").toString().trim() === "I" ? "I" : "A";
    const oper = (req.body?.oper ?? "WEB").toString().slice(0, 60);

    if (!categoria) return res.status(400).json({ ok: false, message: "La categoría es obligatoria" });
    if (!descripcion) return res.status(400).json({ ok: false, message: "La descripción es obligatoria" });

    const { rows } = await pool.query(
      `INSERT INTO doa2.categoria
         (categoria, descripcion, sites, fecha_creacion, oper_creador, estado_registro)
       VALUES ($1, $2, $3, NOW(), $4, $5)
       RETURNING id_cate`,
      [categoria, descripcion, sites, oper, estado]
    );
    res.json({ ok: true, id: rows[0].id_cate });
  } catch (err) {
    console.error("POST /gestion-categorias", err);
    res.status(500).json({ ok: false, message: "Error creando categoría" });
  }
});

/* ===== UPDATE ===== */
router.put("/:id", async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });

  try {
    const categoria = (req.body?.categoria ?? "").toString().trim();
    const descripcion = (req.body?.descripcion ?? "").toString().trim();
    const sites = (req.body?.sites ?? "").toString().trim() || null;
    const estado = (req.body?.estado_registro ?? "A").toString().trim() === "I" ? "I" : "A";
    const oper = (req.body?.oper ?? "WEB").toString().slice(0, 60);

    if (!categoria) return res.status(400).json({ ok: false, message: "La categoría es obligatoria" });
    if (!descripcion) return res.status(400).json({ ok: false, message: "La descripción es obligatoria" });

    const upd = await pool.query(
      `UPDATE doa2.categoria
          SET categoria=$1,
              descripcion=$2,
              sites=$3,
              estado_registro=$4,
              fecha_modificacion=NOW(),
              oper_modifica=$5
        WHERE id_cate=$6`,
      [categoria, descripcion, sites, estado, oper, id]
    );
    if (!upd.rowCount) return res.status(404).json({ ok: false, message: "No encontrado" });
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /gestion-categorias/:id", err);
    res.status(500).json({ ok: false, message: "Error actualizando categoría" });
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
      `UPDATE doa2.categoria
          SET estado_registro=$1,
              fecha_modificacion=NOW(),
              oper_modifica=$2
        WHERE id_cate=$3`,
      [estado, oper, id]
    );
    if (!upd.rowCount) return res.status(404).json({ ok: false, message: "No encontrado" });
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /gestion-categorias/:id/estado", err);
    res.status(500).json({ ok: false, message: "Error cambiando estado" });
  }
});

export default router;
