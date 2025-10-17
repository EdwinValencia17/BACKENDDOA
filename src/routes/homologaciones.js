import express from "express";
import pool from "../config/db.js";

const router = express.Router();

// ============================
// helpers
// ============================
const getUsuario = (req) => {
  return req.user?.username || req.user?.email || "sistema";
};

const validarExistencia = async (itemId, categoriaId) => {
  try {
    const [itemResult, categoriaResult] = await Promise.all([
      pool.query(
        "SELECT id_item FROM item WHERE id_item = $1 AND estado_registro = $2",
        [itemId, "A"]
      ),
      pool.query(
        "SELECT id_cate FROM categoria WHERE id_cate = $1 AND estado_registro = $2",
        [categoriaId, "A"]
      ),
    ]);

    return {
      itemExiste: itemResult.rows.length > 0,
      categoriaExiste: categoriaResult.rows.length > 0,
    };
  } catch (error) {
    throw new Error(`Error validando existencia: ${error.message}`);
  }
};

// ============================
// 1) LISTAR HOMOLOGACIONES  GET /api/homologaciones
// ============================
router.get("/", async (req, res) => {
  try {
    const { item, categoria, page = 1, limit = 20, estado = "A" } = req.query;

    const p = Number(page) || 1;
    const l = Number(limit) || 20;
    const offset = (p - 1) * l;

    let baseWhere = "WHERE ixc.estado_registro = $1";
    const params = [estado];
    const conditions = [];

    if (item && item !== "-1") {
      conditions.push(
        `(i.referencia ILIKE $${params.length + 1} OR i.descripcion ILIKE $${params.length + 1})`
      );
      params.push(`%${item}%`);
    }

    if (categoria && categoria !== "-1") {
      conditions.push(
        `(c.categoria ILIKE $${params.length + 1} OR c.descripcion ILIKE $${params.length + 1})`
      );
      params.push(`%${categoria}%`);
    }

    if (conditions.length > 0) baseWhere += ` AND ${conditions.join(" AND ")}`;

    const dataSql = `
      SELECT 
        ixc.id_itca,
        ixc.descripcion,
        ixc.fecha_creacion,
        ixc.oper_creador,
        ixc.fecha_modificacion,
        ixc.oper_modifica,
        ixc.estado_registro,

        -- Item
        i.id_item,
        i.referencia,
        i.descripcion as item_descripcion,

        -- Categoría
        c.id_cate,
        c.categoria,
        c.descripcion as categoria_descripcion,
        c.sites,

        -- Extras formateadas
        TO_CHAR(ixc.fecha_creacion, 'YYYY-MM-DD HH24:MI:SS') as fecha_creacion_formateada,
        TO_CHAR(ixc.fecha_modificacion, 'YYYY-MM-DD HH24:MI:SS') as fecha_modificacion_formateada

      FROM item_x_categoria ixc
      INNER JOIN item i ON ixc.item_id_item = i.id_item
      INNER JOIN categoria c ON ixc.categoria_id_cate = c.id_cate
      ${baseWhere}
      ORDER BY ixc.fecha_creacion DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countSql = `
      SELECT COUNT(*)
      FROM item_x_categoria ixc
      INNER JOIN item i ON ixc.item_id_item = i.id_item
      INNER JOIN categoria c ON ixc.categoria_id_cate = c.id_cate
      ${baseWhere}
    `;

    const dataParams = [...params, l, offset];

    const [result, countResult] = await Promise.all([
      pool.query(dataSql, dataParams),
      pool.query(countSql, params),
    ]);

    const total = parseInt(countResult.rows[0].count, 10) || 0;

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
      },
      filters: { item, categoria, estado },
    });
  } catch (error) {
    console.error("Error buscando homologaciones:", error);
    res.status(500).json({
      success: false,
      error: "Error interno del servidor",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});


// 2) CREAR HOMOLOGACIÓN  POST /api/homologaciones
// ============================
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const {
      item_id_item,
      categoria_id_cate,
      descripcion = "Homologación creada automáticamente",
    } = req.body;
    const usuario = getUsuario(req);

    if (!item_id_item || !categoria_id_cate) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        error: "item_id_item y categoria_id_cate son requeridos",
      });
    }

    const { itemExiste, categoriaExiste } = await validarExistencia(
      item_id_item,
      categoria_id_cate
    );

    if (!itemExiste || !categoriaExiste) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: "Item o categoría no encontrados o inactivos",
        details: {
          item_existe: itemExiste,
          categoria_existe: categoriaExiste,
        },
      });
    }

    // ¿ya existe?
    const checkQuery = `
      SELECT id_itca, estado_registro, descripcion as desc_actual
      FROM item_x_categoria
      WHERE item_id_item = $1 AND categoria_id_cate = $2
    `;
    const checkResult = await client.query(checkQuery, [
      item_id_item,
      categoria_id_cate,
    ]);

    if (checkResult.rows.length > 0) {
      const existente = checkResult.rows[0];
      
      if (existente.estado_registro === "E") {
        // Recuperar homologación eliminada
        const recoverQuery = `
          UPDATE item_x_categoria
          SET estado_registro = 'A',
              oper_modifica = $1,
              fecha_modificacion = CURRENT_TIMESTAMP,
              descripcion = $2
          WHERE id_itca = $3
          RETURNING *
        `;
        const recover = await client.query(recoverQuery, [
          usuario,
          descripcion,
          existente.id_itca,
        ]);

        await client.query("COMMIT");
        return res.status(200).json({
          success: true,
          message: "Homologación recuperada exitosamente",
          data: recover.rows[0],
          action: "recovered",
        });
      } else {
        // 🆕 ACTUALIZAR homologación existente en lugar de error 409
        const updateQuery = `
          UPDATE item_x_categoria
          SET descripcion = $1,
              oper_modifica = $2,
              fecha_modificacion = CURRENT_TIMESTAMP
          WHERE id_itca = $3
          RETURNING *
        `;
        
        const updated = await client.query(updateQuery, [
          descripcion,
          usuario,
          existente.id_itca,
        ]);

        await client.query("COMMIT");
        return res.status(200).json({
          success: true,
          message: "Homologación actualizada exitosamente",
          data: updated.rows[0],
          action: "updated",
          details: `Se actualizó la descripción de "${existente.desc_actual}" a "${descripcion}"`
        });
      }
    }

    // crear nueva (si no existe)
    const insertQuery = `
      INSERT INTO item_x_categoria (
        descripcion, oper_creador, fecha_creacion, estado_registro,
        categoria_id_cate, item_id_item
      ) VALUES ($1, $2, CURRENT_TIMESTAMP, 'A', $3, $4)
      RETURNING *
    `;
    const insertRes = await client.query(insertQuery, [
      descripcion,
      usuario,
      categoria_id_cate,
      item_id_item,
    ]);

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Homologación creada exitosamente",
      data: insertRes.rows[0],
      action: "created",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error creando homologación:", error);
    res.status(500).json({
      success: false,
      error: "Error interno del servidor",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// ============================
// 3) CAMBIAR ESTADO  PATCH /api/homologaciones/:id/estado
// ============================
router.patch("/:id/estado", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const { estado } = req.body;
    const usuario = getUsuario(req);

    if (!["A", "I", "E"].includes(estado)) {
      return res.status(400).json({
        success: false,
        error: "Estado debe ser 'A' (Activo), 'I' (Inactivo) o 'E' (Eliminado)",
      });
    }

    const checkQuery = `
      SELECT id_itca, estado_registro, item_id_item, categoria_id_cate
      FROM item_x_categoria
      WHERE id_itca = $1
    `;
    const check = await client.query(checkQuery, [id]);

    if (check.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, error: "Homologación no encontrada" });
    }

    const homologacion = check.rows[0];

    // si se activa, validar existencia actual de item/categoría
    if (estado === "A") {
      const { itemExiste, categoriaExiste } = await validarExistencia(
        homologacion.item_id_item,
        homologacion.categoria_id_cate
      );

      if (!itemExiste || !categoriaExiste) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error:
            "No se puede activar: Item o categoría no existen o están inactivos",
          details: {
            item_existe: itemExiste,
            categoria_existe: categoriaExiste,
          },
        });
      }
    }

    const upd = await client.query(
      `
      UPDATE item_x_categoria
      SET estado_registro = $1,
          oper_modifica = $2,
          fecha_modificacion = CURRENT_TIMESTAMP
      WHERE id_itca = $3
      RETURNING *
    `,
      [estado, usuario, id]
    );

    await client.query("COMMIT");

    const msg = {
      A: "Homologación activada exitosamente",
      I: "Homologación desactivada exitosamente",
      E: "Homologación eliminada lógicamente exitosamente",
    }[estado];

    res.json({ success: true, message: msg, data: upd.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error cambiando estado:", error);
    res.status(500).json({
      success: false,
      error: "Error interno del servidor",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// ============================
// 4) BUSCAR ÍTEMS  GET /api/homologaciones/items
// ============================
router.get("/items", async (req, res) => {
  try {
    const { q, page = 1, limit = 10, con_homologaciones = "false" } = req.query;
    const p = Number(page) || 1;
    const l = Number(limit) || 10;
    const offset = (p - 1) * l;

    const params = [];
    const conditions = ["i.estado_registro = 'A'"];

    if (q && String(q).trim() !== "") {
      params.push(`%${q}%`);
      conditions.push(
        `(i.referencia ILIKE $${params.length} OR i.descripcion ILIKE $${params.length})`
      );
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const dataSql = `
      SELECT
        i.id_item,
        i.referencia,
        i.descripcion,
        i.fecha_creacion,
        i.oper_creador,
        i.fecha_modificacion,
        i.oper_modifica,
        i.estado_registro,
        COUNT(ixc.id_itca) AS total_homologaciones,
        SUM(CASE WHEN ixc.estado_registro = 'A' THEN 1 ELSE 0 END) AS homologaciones_activas
      FROM item i
      LEFT JOIN item_x_categoria ixc ON i.id_item = ixc.item_id_item
      ${where}
      GROUP BY i.id_item
      ORDER BY i.referencia
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countSql = `
      SELECT COUNT(DISTINCT i.id_item) AS count
      FROM item i
      ${where}
    `;

    const dataParams = [...params, l, offset];

    const [result, countResult] = await Promise.all([
      pool.query(dataSql, dataParams),
      pool.query(countSql, params),
    ]);

    const total = parseInt(countResult.rows[0].count, 10) || 0;
    const rows = result.rows;

    if (String(con_homologaciones) === "true") {
      for (const it of rows) {
        const det = await pool.query(
          `
          SELECT
            ixc.id_itca,
            ixc.estado_registro,
            c.id_cate,
            c.categoria,
            c.descripcion as categoria_descripcion
          FROM item_x_categoria ixc
          INNER JOIN categoria c ON ixc.categoria_id_cate = c.id_cate
          WHERE ixc.item_id_item = $1 AND ixc.estado_registro = 'A'
          ORDER BY c.categoria
        `,
          [it.id_item]
        );
        it.homologaciones = det.rows;
      }
    }

    res.json({
      success: true,
      data: rows,
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.ceil(total / l),
      },
    });
  } catch (error) {
    console.error("Error buscando items:", error);
    res.status(500).json({
      success: false,
      error: "Error interno del servidor",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ============================
// 5) CATEGORÍAS  GET /api/homologaciones/categorias
// ============================
router.get("/categorias", async (req, res) => {
  try {
    const { con_items_count = "false" } = req.query;

    let query;

    if (String(con_items_count) === "true") {
      query = `
        SELECT
          c.id_cate,
          c.categoria,
          c.descripcion,
          c.sites,
          c.fecha_creacion,
          c.estado_registro,
          COUNT(ixc.id_itca) AS total_items,
          COUNT(CASE WHEN ixc.estado_registro = 'A' THEN 1 END) AS items_activos
        FROM categoria c
        LEFT JOIN item_x_categoria ixc ON c.id_cate = ixc.categoria_id_cate
        WHERE c.estado_registro = 'A'
        GROUP BY c.id_cate, c.categoria, c.descripcion, c.sites, c.fecha_creacion, c.estado_registro
        ORDER BY c.categoria
      `;
    } else {
      query = `
        SELECT
          c.id_cate,
          c.categoria,
          c.descripcion,
          c.sites,
          c.fecha_creacion,
          c.oper_creador,
          c.fecha_modificacion,
          c.oper_modifica,
          c.estado_registro,
          (
            SELECT COUNT(*) FROM item_x_categoria ixc
            WHERE ixc.categoria_id_cate = c.id_cate AND ixc.estado_registro = 'A'
          ) AS total_items_activos
        FROM categoria c
        WHERE c.estado_registro = 'A'
        ORDER BY c.categoria
      `;
    }

    const result = await pool.query(query);

    res.json({
      success: true,
      data: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    console.error("Error obteniendo categorías:", error);
    res.status(500).json({
      success: false,
      error: "Error interno del servidor",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ============================
// 5b) CATEGORÍAS PARA FILTRO  GET /api/homologaciones/categorias/filtro
// ============================
router.get("/categorias/filtro", async (req, res) => {
  try {
    const { con_contador = "false" } = req.query;

    let query;

    if (String(con_contador) === "true") {
      query = `
        SELECT
          c.id_cate AS value,
          c.categoria AS label,
          c.descripcion,
          c.sites,
          COUNT(ixc.id_itca) AS total_items,
          COUNT(CASE WHEN ixc.estado_registro = 'A' THEN 1 END) AS items_activos
        FROM categoria c
        LEFT JOIN item_x_categoria ixc ON c.id_cate = ixc.categoria_id_cate
        WHERE c.estado_registro = 'A'
        GROUP BY c.id_cate, c.categoria, c.descripcion, c.sites
        ORDER BY c.categoria
      `;
    } else {
      query = `
        SELECT
          id_cate AS value,
          categoria AS label,
          descripcion,
          sites
        FROM categoria
        WHERE estado_registro = 'A'
        ORDER BY categoria
      `;
    }

    const result = await pool.query(query);

    res.json({
      success: true,
      data: result.rows,
      total: result.rows.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error obteniendo categorías para filtro:", error);
    res.status(500).json({
      success: false,
      error: "Error interno del servidor",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ============================
// 6) MASIVO  POST /api/homologaciones/masivo
// ============================
router.post("/masivo", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { items, orden_compra_id, origen = "orden_compra" } = req.body;
    const usuario = getUsuario(req);

    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Se requiere array de items para homologar" });
    }

    if (items.length > 100) {
      return res
        .status(400)
        .json({ success: false, error: "Máximo 100 items por operación masiva" });
    }

    const resultados = {
      total: items.length,
      creadas: 0,
      actualizadas: 0,
      errores: 0,
      detalles: [],
    };

    for (const [index, item] of items.entries()) {
      try {
        const {
          item_id,
          categoria_id,
          descripcion = `Homologación desde ${origen}`,
        } = item;

        const { itemExiste, categoriaExiste } = await validarExistencia(
          item_id,
          categoria_id
        );

        if (!itemExiste || !categoriaExiste) {
          resultados.errores++;
          resultados.detalles.push({
            index,
            item_id,
            categoria_id,
            success: false,
            error: "Item o categoría no encontrados",
            item_existe: itemExiste,
            categoria_existe: categoriaExiste,
          });
          continue;
        }

        const checkQuery = `
          SELECT id_itca, estado_registro
          FROM item_x_categoria
          WHERE item_id_item = $1 AND categoria_id_cate = $2
        `;
        const check = await client.query(checkQuery, [item_id, categoria_id]);

        let accion = "skip";
        let dataRow;

        if (check.rows.length > 0) {
          const existente = check.rows[0];
          if (existente.estado_registro !== "A") {
            const upd = await client.query(
              `
              UPDATE item_x_categoria
              SET estado_registro = 'A',
                  oper_modifica = $1,
                  fecha_modificacion = CURRENT_TIMESTAMP,
                  descripcion = $2
              WHERE id_itca = $3
              RETURNING *
            `,
              [usuario, descripcion, existente.id_itca]
            );
            dataRow = upd.rows[0];
            accion = "reactivated";
            resultados.actualizadas++;
          } else {
            dataRow = existente;
            accion = "already_active";
          }
        } else {
          const ins = await client.query(
            `
            INSERT INTO item_x_categoria (
              descripcion, oper_creador, fecha_creacion, estado_registro,
              categoria_id_cate, item_id_item
            ) VALUES ($1, $2, CURRENT_TIMESTAMP, 'A', $3, $4)
            RETURNING *
          `,
            [descripcion, usuario, categoria_id, item_id]
          );
          dataRow = ins.rows[0];
          accion = "created";
          resultados.creadas++;
        }

        resultados.detalles.push({
          index,
          item_id,
          categoria_id,
          success: true,
          accion,
          data: dataRow,
        });
      } catch (error) {
        resultados.errores++;
        resultados.detalles.push({
          index,
          item_id: item?.item_id,
          categoria_id: item?.categoria_id,
          success: false,
          error: error.message,
        });
      }
    }

    if (orden_compra_id) {
      await client.query(
        `
        INSERT INTO log_homologaciones_masivas
          (orden_compra_id, usuario, total_items, exitosos, errores, fecha_proceso)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      `,
        [
          orden_compra_id,
          usuario,
          resultados.total,
          resultados.creadas + resultados.actualizadas,
          resultados.errores,
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      success: resultados.errores === 0,
      message: `Proceso masivo completado. ${resultados.creadas + resultados.actualizadas} homologaciones procesadas`,
      resultados,
      ...(orden_compra_id && { orden_compra_id }),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error en homologación masiva:", error);
    res.status(500).json({
      success: false,
      error: "Error interno del servidor",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  } finally {
    client.release();
  }
});

// ============================
// 7) ESTADÍSTICAS  GET /api/homologaciones/estadisticas
// ============================
router.get("/estadisticas", async (_req, res) => {
  try {
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM item WHERE estado_registro = 'A') AS total_items,
        (SELECT COUNT(*) FROM categoria WHERE estado_registro = 'A') AS total_categorias,
        (SELECT COUNT(*) FROM item_x_categoria WHERE estado_registro = 'A') AS total_homologaciones_activas,
        (SELECT COUNT(*) FROM item_x_categoria WHERE estado_registro = 'I') AS total_homologaciones_inactivas,
        (SELECT COUNT(*) FROM item i 
           WHERE i.estado_registro = 'A'
             AND NOT EXISTS (
               SELECT 1 FROM item_x_categoria ixc
               WHERE ixc.item_id_item = i.id_item AND ixc.estado_registro = 'A'
             )
        ) AS items_sin_homologar,
        (SELECT COUNT(*) FROM categoria c
           WHERE c.estado_registro = 'A'
             AND NOT EXISTS (
               SELECT 1 FROM item_x_categoria ixc
               WHERE ixc.categoria_id_cate = c.id_cate AND ixc.estado_registro = 'A'
             )
        ) AS categorias_sin_items,
        (SELECT COUNT(*) FROM item_x_categoria
           WHERE estado_registro = 'A'
             AND fecha_creacion >= CURRENT_DATE - INTERVAL '7 days'
        ) AS homologaciones_recientes
    `;

  const topCategoriasQuery = `
      SELECT 
        c.id_cate,
        c.categoria,
        COUNT(ixc.id_itca) AS total_items
      FROM categoria c
      LEFT JOIN item_x_categoria ixc
        ON c.id_cate = ixc.categoria_id_cate
       AND ixc.estado_registro = 'A'
      WHERE c.estado_registro = 'A'
      GROUP BY c.id_cate, c.categoria
      ORDER BY total_items DESC
      LIMIT 10
    `;

    const [stats, top] = await Promise.all([
      pool.query(statsQuery),
      pool.query(topCategoriasQuery),
    ]);

    res.json({
      success: true,
      estadisticas: stats.rows[0],
      top_categorias: top.rows,
    });
  } catch (error) {
    console.error("Error obteniendo estadísticas:", error);
    res.status(500).json({ success: false, error: "Error interno del servidor" });
  }
});

// ============================
// EDITAR  PUT /api/homologaciones/:id
// Campos permitidos: descripcion, categoria_id_cate
// ============================
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const { descripcion, categoria_id_cate } = req.body;
    const usuario = getUsuario(req);

    // 1) existe?
    const cur = await client.query(
      `SELECT id_itca, item_id_item, categoria_id_cate, estado_registro
       FROM item_x_categoria WHERE id_itca = $1`,
      [id]
    );
    if (cur.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success:false, error:"Homologación no encontrada" });
    }

    // 2) si cambia la categoría, valida que exista/activa
    if (categoria_id_cate) {
      const ok = await client.query(
        `SELECT 1 FROM categoria WHERE id_cate = $1 AND estado_registro = 'A'`,
        [categoria_id_cate]
      );
      if (ok.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success:false, error:"Categoría no existe o inactiva" });
      }
    }

    // 3) arma update dinámico
    const sets = [];
    const vals = [];
    if (typeof descripcion === "string") { sets.push(`descripcion = $${sets.length+1}`); vals.push(descripcion); }
    if (categoria_id_cate) { sets.push(`categoria_id_cate = $${sets.length+1}`); vals.push(categoria_id_cate); }
    sets.push(`oper_modifica = $${sets.length+1}`); vals.push(usuario);
    sets.push(`fecha_modificacion = CURRENT_TIMESTAMP`);

    if (sets.length === 1) { // solo oper_modifica… no hay cambios reales
      await client.query("ROLLBACK");
      return res.status(400).json({ success:false, error:"Nada para actualizar" });
    }

    const upd = await client.query(
      `UPDATE item_x_categoria
       SET ${sets.join(", ")}
       WHERE id_itca = $${vals.length+1}
       RETURNING *`,
      [...vals, id]
    );

    await client.query("COMMIT");
    res.json({ success:true, message:"Homologación actualizada", data: upd.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error editando homologación:", err);
    res.status(500).json({ success:false, error:"Error interno del servidor" });
  } finally {
    client.release();
  }
});

export default router;
