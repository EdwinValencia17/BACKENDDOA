// src/routes/Gestiones/GestionTipoAutorizador.js
import express from "express";
import pool from "../../config/db.js";

const router = express.Router();

/* Helpers */
const isEmpty = (v) =>
  v === undefined || v === null || `${v}`.trim() === "" || `${v}`.trim() === "-1";

const now = () => new Date();

/* ================================
   GET /list
   Paginado + filtros + sort
   q: busca en codigo/descripcion
   estado: A|I
================================ */
router.get("/list", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortField = "codigo", // codigo | descripcion | fecha_creacion
      sortOrder = "ASC",
      q = "",
      estado = "-1",
    } = req.query;

    const off = (Number(page) - 1) * Number(limit);
    const params = [];
    const push = (v) => { params.push(v); return `$${params.length}`; };

    const wh = [];
    if (!isEmpty(q)) {
      const p = `%${String(q).toUpperCase()}%`;
      const p1 = push(p), p2 = push(p);
      wh.push(`(UPPER(codigo) LIKE ${p1} OR UPPER(descripcion) LIKE ${p2})`);
    }
    if (!isEmpty(estado)) {
      wh.push(`estado_registro = ${push(String(estado))}`);
    }
    const WHERE = wh.length ? `WHERE ${wh.join(" AND ")}` : "";

    const orderMap = {
      codigo: "codigo",
      descripcion: "descripcion",
      fecha_creacion: "fecha_creacion",
    };
    const orderCol = orderMap[sortField] || "codigo";
    const orderDir = String(sortOrder).toUpperCase() === "DESC" ? "DESC" : "ASC";

    const countSql = `SELECT COUNT(1) AS total FROM doa2.tipo_autorizador ${WHERE};`;
    const pageSql = `
      SELECT id_tiau, codigo, descripcion, fecha_creacion, oper_creador,
             fecha_modificacion, oper_modifica, estado_registro
      FROM doa2.tipo_autorizador
      ${WHERE}
      ORDER BY ${orderCol} ${orderDir}, id_tiau ${orderDir}
      LIMIT ${Number(limit)} OFFSET ${off};
    `;

    const [cRes, lRes] = await Promise.all([
      pool.query(countSql, params),
      pool.query(pageSql, params),
    ]);

    const total = Number(cRes.rows?.[0]?.total || 0);
    res.json({ ok: true, data: lRes.rows, page: Number(page), pageSize: Number(limit), total });
  } catch (err) {
    console.error("GET /gestion-tipo-autorizador/list error:", err);
    res.status(500).json({ ok: false, message: "Error listando tipos de autorizador" });
  }
});

/* ================================
   GET /:id
================================ */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT id_tiau, codigo, descripcion, fecha_creacion, oper_creador,
              fecha_modificacion, oper_modifica, estado_registro
       FROM doa2.tipo_autorizador
       WHERE id_tiau = $1`,
      [Number(id)]
    );
    if (!rows.length) return res.status(404).json({ ok: false, message: "No encontrado" });
    res.json({ ok: true, row: rows[0] });
  } catch (err) {
    console.error("GET /gestion-tipo-autorizador/:id error:", err);
    res.status(500).json({ ok: false, message: "Error obteniendo registro" });
  }
});

/* ================================
   POST /
   body: { codigo, descripcion, estado_registro, oper }  (oper opcional)
================================ */
router.post("/", async (req, res) => {
  try {
    const { codigo, descripcion, estado_registro = "A", oper = "SYSTEM" } = req.body || {};
    if (!codigo || !descripcion) {
      return res.status(400).json({ ok: false, message: "Código y descripción son obligatorios" });
    }
    const ts = now();
    const sql = `
      INSERT INTO doa2.tipo_autorizador
        (codigo, descripcion, fecha_creacion, oper_creador, fecha_modificacion, oper_modifica, estado_registro)
      VALUES ($1, $2, $3, $4, $3, $4, $5)
      RETURNING id_tiau
    `;
    const { rows } = await pool.query(sql, [codigo.trim(), descripcion.trim(), ts, oper, estado_registro]);
    res.json({ ok: true, id: rows[0].id_tiau });
  } catch (err) {
    console.error("POST /gestion-tipo-autorizador error:", err);
    res.status(500).json({ ok: false, message: "Error creando registro" });
  }
});

/* ================================
   PUT /:id
   body: { codigo, descripcion, estado_registro, oper }
================================ */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { codigo, descripcion, estado_registro, oper = "SYSTEM" } = req.body || {};
    if (!codigo || !descripcion || !estado_registro) {
      return res.status(400).json({ ok: false, message: "Código, descripción y estado son obligatorios" });
    }
    const ts = now();
    const sql = `
      UPDATE doa2.tipo_autorizador
         SET codigo = $1,
             descripcion = $2,
             estado_registro = $3,
             fecha_modificacion = $4,
             oper_modifica = $5
       WHERE id_tiau = $6
    `;
    await pool.query(sql, [codigo.trim(), descripcion.trim(), estado_registro, ts, oper, Number(id)]);
    res.json({ ok: true });
  } catch (err) {
    console.error("PUT /gestion-tipo-autorizador/:id error:", err);
    res.status(500).json({ ok: false, message: "Error actualizando registro" });
  }
});

/* ================================
   PATCH /:id/estado
   body: { estado_registro, oper }
================================ */
router.patch("/:id/estado", async (req, res) => {
  try {
    const { id } = req.params;
    const { estado_registro, oper = "SYSTEM" } = req.body || {};
    if (!estado_registro) return res.status(400).json({ ok: false, message: "Estado requerido" });
    const ts = now();
    await pool.query(
      `UPDATE doa2.tipo_autorizador
          SET estado_registro = $1,
              fecha_modificacion = $2,
              oper_modifica = $3
        WHERE id_tiau = $4`,
      [estado_registro, ts, oper, Number(id)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /gestion-tipo-autorizador/:id/estado error:", err);
    res.status(500).json({ ok: false, message: "Error cambiando estado" });
  }
});

export default router;
