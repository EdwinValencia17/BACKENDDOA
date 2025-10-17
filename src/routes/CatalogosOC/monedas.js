// src/routes/monedas.js
import express from "express";
import pool from "../../config/db.js";

const router = express.Router();

/* util: parseo seguro */
const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const toFloat = (v, d = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/**
 * GET /api/monedas
 * Lista con filtros + paginación
 * Query:
 *  - page, limit
 *  - codigo, descripcion (LIKE)
 *  - tasa (exacta), tasaMin, tasaMax
 *  - estado ('A' | 'I')
 */
router.get("/", async (req, res) => {
  const page = Math.max(1, toInt(req.query.page, 1));
  const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
  const offset = (page - 1) * limit;

  const { codigo, descripcion, estado } = req.query;
  const tasa = req.query.tasa;
  const tasaMin = req.query.tasaMin;
  const tasaMax = req.query.tasaMax;

  const where = [];
  const params = [];

  if (nonEmpty(codigo)) {
    params.push(`%${codigo.trim()}%`);
    where.push(`codigo ILIKE $${params.length}`);
  }
  if (nonEmpty(descripcion)) {
    params.push(`%${descripcion.trim()}%`);
    where.push(`descripcion ILIKE $${params.length}`);
  }
  if (nonEmpty(estado)) {
    params.push(estado.trim().toUpperCase() === "A" ? "A" : "I");
    where.push(`estado_registro = $${params.length}`);
  }
  if (tasa !== undefined && tasa !== "") {
    const val = toFloat(tasa);
    params.push(val);
    where.push(`tasa_cambio = $${params.length}`);
  } else {
    if (tasaMin !== undefined && tasaMin !== "") {
      params.push(toFloat(tasaMin));
      where.push(`tasa_cambio >= $${params.length}`);
    }
    if (tasaMax !== undefined && tasaMax !== "") {
      params.push(toFloat(tasaMax));
      where.push(`tasa_cambio <= $${params.length}`);
    }
  }

  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const countSql = `SELECT COUNT(*)::int AS total FROM doa2.moneda ${whereSQL}`;
    const dataSql = `
      SELECT id_mone, codigo, descripcion, tasa_cambio, fecha_creacion, oper_creador,
             fecha_modificacion, oper_modifica, estado_registro
      FROM doa2.moneda
      ${whereSQL}
      ORDER BY fecha_creacion DESC, id_mone DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countRes = await pool.query(countSql, params);
    const total = countRes.rows[0]?.total ?? 0;

    const dataParams = [...params, limit, offset];
    const listRes = await pool.query(dataSql, dataParams);

    res.json({
      data: listRes.rows,
      page,
      limit,
      total,
    });
  } catch (err) {
    console.error("[GET /monedas] error", err);
    res.status(500).json({ message: "Error al obtener monedas" });
  }
});

/**
 * GET /api/monedas/:id
 */
router.get("/:id", async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ message: "ID inválido" });

  try {
    const q = `
      SELECT id_mone, codigo, descripcion, tasa_cambio, fecha_creacion, oper_creador,
             fecha_modificacion, oper_modifica, estado_registro
      FROM doa2.moneda
      WHERE id_mone = $1
    `;
    const r = await pool.query(q, [id]);
    if (!r.rows.length)
      return res.status(404).json({ message: "Moneda no encontrada" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error("[GET /monedas/:id] error", err);
    res.status(500).json({ message: "Error al obtener la moneda" });
  }
});

/**
 * POST /api/monedas
 * body: { codigo, descripcion, tasa_cambio, oper_creador, estado_registro? }
 */
router.post("/", async (req, res) => {
  const { codigo, descripcion, tasa_cambio, oper_creador, estado_registro } =
    req.body || {};

  // validaciones simples
  if (!nonEmpty(codigo) || codigo.trim().length > 10) {
    return res.status(400).json({ message: "Código requerido (máx 10)" });
  }
  if (!nonEmpty(descripcion) || descripcion.trim().length > 120) {
    return res.status(400).json({ message: "Descripción requerida (máx 120)" });
  }
  const tasa =
    tasa_cambio === undefined || tasa_cambio === null || tasa_cambio === ""
      ? null
      : toFloat(tasa_cambio, NaN);
  if (tasa !== null && !Number.isFinite(tasa)) {
    return res.status(400).json({ message: "Tasa de cambio inválida" });
  }
  if (!nonEmpty(oper_creador)) {
    return res.status(400).json({ message: "oper_creador requerido" });
  }
  const estado = (estado_registro || "A").toUpperCase() === "I" ? "I" : "A";

  try {
    // validar código único
    const dup = await pool.query(
      "SELECT 1 FROM doa2.moneda WHERE codigo = $1 LIMIT 1",
      [codigo.trim()]
    );
    if (dup.rowCount > 0) {
      return res
        .status(409)
        .json({ message: "Ya existe una moneda con ese código" });
    }

    const insertSql = `
      INSERT INTO doa2.moneda
        (codigo, descripcion, tasa_cambio, fecha_creacion, oper_creador, estado_registro)
      VALUES ($1, $2, $3, NOW(), $4, $5)
      RETURNING id_mone, codigo, descripcion, tasa_cambio, fecha_creacion, oper_creador,
                fecha_modificacion, oper_modifica, estado_registro
    `;
    const params = [
      codigo.trim().toUpperCase(),
      descripcion.trim(),
      tasa,
      oper_creador,
      estado,
    ];
    const r = await pool.query(insertSql, params);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error("[POST /monedas] error", err);
    res.status(500).json({ message: "Error al crear la moneda" });
  }
});

/**
 * PUT /api/monedas/:id
 * body: { codigo?, descripcion?, tasa_cambio?, estado_registro?, oper_modifica }
 * - permite cambiar código validando unicidad
 */
// PUT /api/monedas/:id
router.put('/:id', async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ message: 'ID inválido' });

  const { codigo, descripcion, tasa_cambio, estado_registro, oper_modifica } = req.body || {};
  if (!nonEmpty(oper_modifica)) {
    return res.status(400).json({ message: 'oper_modifica requerido' });
  }

  try {
    // Traer el registro actual
    const cur = await pool.query('SELECT * FROM doa2.moneda WHERE id_mone = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ message: 'Moneda no encontrada' });
    const row = cur.rows[0];

    // Aplicar cambios con defaults a los actuales
    const newCodigo = nonEmpty(codigo) ? codigo.trim().toUpperCase() : row.codigo;
    const newDesc   = nonEmpty(descripcion) ? descripcion.trim() : row.descripcion;

    // Reglas para tasa:
    // - undefined  => mantener la actual (puede ser null y está bien)
    // - null o ''  => setear a NULL
    // - otro valor => parsear número
    let newTasa;
    if (tasa_cambio === undefined) {
      newTasa = row.tasa_cambio;
    } else if (tasa_cambio === null || tasa_cambio === '') {
      newTasa = null;
    } else {
      newTasa = toFloat(tasa_cambio, NaN);
    }

    const newEstado = nonEmpty(estado_registro)
      ? (estado_registro.toUpperCase() === 'I' ? 'I' : 'A')
      : row.estado_registro;

    // Validaciones
    if (!nonEmpty(newCodigo) || newCodigo.length > 10) {
      return res.status(400).json({ message: 'Código inválido (máx 10)' });
    }
    if (!nonEmpty(newDesc) || newDesc.length > 120) {
      return res.status(400).json({ message: 'Descripción inválida (máx 120)' });
    }
    if (newTasa !== null && !Number.isFinite(newTasa)) {
      return res.status(400).json({ message: 'Tasa de cambio inválida' });
    }

    // Si cambia el código, validar unicidad
    if (newCodigo !== row.codigo) {
      const dup = await pool.query(
        'SELECT 1 FROM doa2.moneda WHERE codigo = $1 AND id_mone <> $2 LIMIT 1',
        [newCodigo, id]
      );
      if (dup.rowCount > 0) {
        return res.status(409).json({ message: 'Ya existe una moneda con ese código' });
      }
    }

    // Actualizar
    const upSql = `
      UPDATE doa2.moneda
      SET codigo = $1,
          descripcion = $2,
          tasa_cambio = $3,
          estado_registro = $4,
          fecha_modificacion = NOW(),
          oper_modifica = $5
      WHERE id_mone = $6
      RETURNING
        id_mone, codigo, descripcion, tasa_cambio,
        fecha_creacion, oper_creador,
        fecha_modificacion, oper_modifica, estado_registro
    `;
    const params = [newCodigo, newDesc, newTasa, newEstado, oper_modifica, id];
    const r = await pool.query(upSql, params);

    res.json(r.rows[0]);
  } catch (err) {
    console.error('[PUT /monedas/:id] error', err);
    res.status(500).json({ message: 'Error al actualizar la moneda' });
  }
});

/**
 * PATCH /api/monedas/:id/estado
 * body: { estado: 'A'|'I', oper_modifica }
 */
router.patch("/:id/estado", async (req, res) => {
  const id = toInt(req.params.id, 0);
  if (!id) return res.status(400).json({ message: "ID inválido" });

  const { estado, oper_modifica } = req.body || {};
  if (!nonEmpty(oper_modifica)) {
    return res.status(400).json({ message: "oper_modifica requerido" });
  }
  const est = (estado || "").toUpperCase();
  if (est !== "A" && est !== "I") {
    return res.status(400).json({ message: "Estado inválido" });
  }

  try {
    const q = `
      UPDATE doa2.moneda
      SET estado_registro = $1,
          fecha_modificacion = NOW(),
          oper_modifica = $2
      WHERE id_mone = $3
      RETURNING id_mone, codigo, descripcion, tasa_cambio, fecha_creacion, oper_creador,
                fecha_modificacion, oper_modifica, estado_registro
    `;
    const r = await pool.query(q, [est, oper_modifica, id]);
    if (!r.rows.length)
      return res.status(404).json({ message: "Moneda no encontrada" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error("[PATCH /monedas/:id/estado] error", err);
    res.status(500).json({ message: "Error al cambiar estado" });
  }
});

export default router;
