// src/routes/Gestiones/GestionNiveles.js
import express from "express";
import pool from "../../config/db.js";

const router = express.Router();

/* ========== helpers ========== */
const isEmpty = (v) =>
  v === undefined || v === null || `${v}`.trim() === "" || `${v}`.trim() === "-1";

const SORT_WHITELIST = new Set(["nivel", "descripcion", "fecha_creacion"]);
const sortCol = (field) => (SORT_WHITELIST.has(String(field)) ? field : "nivel");
const sortDir = (dir) => (String(dir).toUpperCase() === "DESC" ? "DESC" : "ASC");

/* logging breve (opcional) */
router.use((req, _res, next) => {
  console.log("[GestionNiveles]", req.method, req.originalUrl);
  next();
});

/* ================= LIST =================
   GET /api/gestion-niveles/list
   params: page, limit, sortField, sortOrder, q, estado
=========================================*/
router.get("/list", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortField = "nivel",
      sortOrder = "ASC",
      q = "",
      estado = "-1",
    } = req.query;

    const p = Math.max(parseInt(page, 10) || 1, 1);
    const s = Math.max(parseInt(limit, 10) || 20, 1);
    const off = (p - 1) * s;

    const params = [];
    const wh = [];

    if (!isEmpty(q)) {
      params.push(`%${String(q).trim()}%`);
      params.push(`%${String(q).trim()}%`);
      wh.push(`(nivel ILIKE $${params.length - 1} OR descripcion ILIKE $${params.length})`);
    }
    if (!isEmpty(estado)) {
      params.push(String(estado));
      wh.push(`estado_registro = $${params.length}`);
    }

    const WHERE = wh.length ? `WHERE ${wh.join(" AND ")}` : "";
    const orderBy = `${sortCol(sortField)} ${sortDir(sortOrder)}, id_nive ASC`;

    const sqlCount = `SELECT COUNT(1)::int AS total FROM doa2.nivel ${WHERE};`;
    const sqlRows = `
      SELECT
        id_nive,
        nivel,
        descripcion,
        fecha_creacion,
        oper_creador,
        fecha_modificacion,
        oper_modifica,
        estado_registro
      FROM doa2.nivel
      ${WHERE}
      ORDER BY ${orderBy}
      LIMIT ${s} OFFSET ${off};
    `;

    const [cRes, rRes] = await Promise.all([pool.query(sqlCount, params), pool.query(sqlRows, params)]);
    res.json({
      ok: true,
      data: rRes.rows || [],
      page: p,
      pageSize: s,
      total: cRes.rows?.[0]?.total ?? 0,
    });
  } catch (err) {
    console.error("GET /gestion-niveles/list", err);
    res.status(500).json({ ok: false, message: "Error listando niveles" });
  }
});

/* ================= GET ONE =================
   GET /api/gestion-niveles/:id
===========================================*/
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, message: "ID inválido" });

  try {
    const { rows } = await pool.query(
      `SELECT id_nive, nivel, descripcion, fecha_creacion, oper_creador,
              fecha_modificacion, oper_modifica, estado_registro
         FROM doa2.nivel
        WHERE id_nive = $1
        LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "Nivel no encontrado" });
    res.json({ ok: true, row: rows[0] });
  } catch (err) {
    console.error("GET /gestion-niveles/:id", err);
    res.status(500).json({ ok: false, message: "Error consultando nivel" });
  }
});

/* ================= CREATE =================
   POST /api/gestion-niveles
   body: { nivel, descripcion, estado_registro?, oper? }
===========================================*/
router.post("/", async (req, res) => {
  try {
    const nivel = (req.body?.nivel ?? "").toString().trim();
    const descripcion = (req.body?.descripcion ?? "").toString().trim();
    const estado = (req.body?.estado_registro ?? "A").toString().trim().toUpperCase() === "I" ? "I" : "A";
    const oper = (req.body?.oper ?? req.headers["x-user"] ?? "WEB").toString().slice(0, 60);

    if (!nivel) return res.status(400).json({ ok: false, message: "El campo 'nivel' es obligatorio" });
    if (!descripcion) return res.status(400).json({ ok: false, message: "La 'descripcion' es obligatoria" });

    const { rows } = await pool.query(
      `INSERT INTO doa2.nivel
        (nivel, descripcion, fecha_creacion, oper_creador, fecha_modificacion, oper_modifica, estado_registro)
       VALUES ($1,$2,NOW(),$3,NOW(),$3,$4)
       RETURNING id_nive`,
      [nivel, descripcion, oper, estado]
    );

    res.json({ ok: true, id: rows[0]?.id_nive });
  } catch (err) {
    console.error("POST /gestion-niveles", err);
    res.status(500).json({ ok: false, message: "Error creando nivel" });
  }
});

/* ================= UPDATE =================
   PUT /api/gestion-niveles/:id
   body: { nivel, descripcion, estado_registro, oper? }
===========================================*/
router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, message: "ID inválido" });

    const nivel = (req.body?.nivel ?? "").toString().trim();
    const descripcion = (req.body?.descripcion ?? "").toString().trim();
    const estado = (req.body?.estado_registro ?? "A").toString().trim().toUpperCase() === "I" ? "I" : "A";
    const oper = (req.body?.oper ?? req.headers["x-user"] ?? "WEB").toString().slice(0, 60);

    if (!nivel) return res.status(400).json({ ok: false, message: "El campo 'nivel' es obligatorio" });
    if (!descripcion) return res.status(400).json({ ok: false, message: "La 'descripcion' es obligatoria" });

    const upd = await pool.query(
      `UPDATE doa2.nivel
          SET nivel=$1,
              descripcion=$2,
              estado_registro=$3,
              fecha_modificacion=NOW(),
              oper_modifica=$4
        WHERE id_nive=$5`,
      [nivel, descripcion, estado, oper, id]
    );

    res.json({ ok: true, updated: upd.rowCount || 0 });
  } catch (err) {
    console.error("PUT /gestion-niveles/:id", err);
    res.status(500).json({ ok: false, message: "Error actualizando nivel" });
  }
});

/* =============== PATCH ESTADO ===============
   PATCH /api/gestion-niveles/:id/estado
   body: { estado_registro, oper? }
=============================================*/
router.patch("/:id/estado", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, message: "ID inválido" });

    const estado = (req.body?.estado_registro ?? "").toString().trim().toUpperCase();
    if (!["A", "I"].includes(estado)) return res.status(400).json({ ok: false, message: "Estado inválido" });
    const oper = (req.body?.oper ?? req.headers["x-user"] ?? "WEB").toString().slice(0, 60);

    const upd = await pool.query(
      `UPDATE doa2.nivel
          SET estado_registro=$1,
              fecha_modificacion=NOW(),
              oper_modifica=$2
        WHERE id_nive=$3`,
      [estado, oper, id]
    );

    res.json({ ok: true, updated: upd.rowCount || 0 });
  } catch (err) {
    console.error("PATCH /gestion-niveles/:id/estado", err);
    res.status(500).json({ ok: false, message: "Error actualizando estado" });
  }
});

export default router;
