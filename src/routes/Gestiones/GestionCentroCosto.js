// src/routes/Gestiones/GestionCentroCosto.js
import express from "express";
import pool from "../../config/db.js";

const router = express.Router();

/* ========= LISTAR ========= */
router.get("/list", async (req, res) => {
  try {
    const { page = 1, limit = 20, q = "", estado = "-1", sortField = "codigo", sortOrder = "ASC" } = req.query;

    const offset = (page - 1) * limit;

    let filters = [];
    if (q) {
      filters.push(`(codigo ILIKE '%${q}%' OR descripcion ILIKE '%${q}%')`);
    }
    if (estado !== "-1") {
      filters.push(`estado_registro = '${estado}'`);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    const totalQuery = await pool.query(`SELECT COUNT(*) FROM doa2.centro_costo ${where}`);
    const total = parseInt(totalQuery.rows[0].count, 10);

    const query = `
      SELECT id_ceco, codigo, descripcion, estado_registro, fecha_creacion, oper_creador, fecha_modificacion, oper_modifica
      FROM doa2.centro_costo
      ${where}
      ORDER BY ${sortField} ${sortOrder}
      LIMIT ${limit} OFFSET ${offset};
    `;
    const result = await pool.query(query);

    res.json({
      data: result.rows,
      page: parseInt(page, 10),
      pageSize: parseInt(limit, 10),
      total,
    });
  } catch (error) {
    console.error("Error al listar centros de costo:", error);
    res.status(500).json({ message: "Error al listar centros de costo" });
  }
});

/* ========= CREAR ========= */
router.post("/create", async (req, res) => {
  try {
    const { codigo, descripcion, estado_registro, oper } = req.body;

    if (!codigo || !descripcion) {
      return res.status(400).json({ message: "Código y descripción son obligatorios" });
    }

    const query = `
      INSERT INTO doa2.centro_costo (codigo, descripcion, estado_registro, fecha_creacion, oper_creador)
      VALUES ($1, $2, $3, NOW(), $4)
      RETURNING *;
    `;
    const values = [codigo, descripcion, estado_registro, oper];
    const result = await pool.query(query, values);

    res.json({ message: "Centro de costo creado correctamente", data: result.rows[0] });
  } catch (error) {
    console.error("Error al crear centro de costo:", error);
    res.status(500).json({ message: "Error al crear centro de costo" });
  }
});

/* ========= ACTUALIZAR ========= */
router.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { codigo, descripcion, estado_registro, oper } = req.body;

    const query = `
      UPDATE doa2.centro_costo
      SET codigo = $1,
          descripcion = $2,
          estado_registro = $3,
          fecha_modificacion = NOW(),
          oper_modifica = $4
      WHERE id_ceco = $5
      RETURNING *;
    `;
    const values = [codigo, descripcion, estado_registro, oper, id];
    const result = await pool.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Centro de costo no encontrado" });
    }

    res.json({ message: "Centro de costo actualizado correctamente", data: result.rows[0] });
  } catch (error) {
    console.error("Error al actualizar centro de costo:", error);
    res.status(500).json({ message: "Error al actualizar centro de costo" });
  }
});

/* ========= CAMBIAR ESTADO ========= */
router.patch("/setEstado/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, oper } = req.body;

    const query = `
      UPDATE doa2.centro_costo
      SET estado_registro = $1,
          fecha_modificacion = NOW(),
          oper_modifica = $2
      WHERE id_ceco = $3
      RETURNING *;
    `;
    const values = [estado, oper, id];
    const result = await pool.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Centro de costo no encontrado" });
    }

    res.json({ message: "Estado actualizado correctamente", data: result.rows[0] });
  } catch (error) {
    console.error("Error al cambiar estado:", error);
    res.status(500).json({ message: "Error al cambiar estado" });
  }
});

export default router;
