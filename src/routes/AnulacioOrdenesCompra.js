// src/routes/AnulacioOrdenesCompra.js
import express from 'express'
import pool from '../config/db.js'

const router = express.Router()

/* ========================== Helpers ========================== */
const asInt = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}
const like = (s) => (s ? `%${String(s).trim()}%` : null)

/* ==================== Catálogos / filtros ==================== */

// Centros de costo (activos)
router.get('/filtros/centros-costo', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT TRIM(c.codigo) AS codigo,
           COALESCE(TRIM(c.descripcion),'') AS descripcion
    FROM doa2.centro_costo c
    WHERE c.estado_registro='A' AND TRIM(c.codigo) <> ''
    ORDER BY 1
  `);

  res.json(rows.map(r => ({
    value: r.codigo,
    label: r.descripcion ? `${r.codigo} — ${r.descripcion}` : r.codigo,
    codigo: r.codigo,
    descripcion: r.descripcion
  })));
});

// Solicitantes
router.get('/filtros/solicitantes', async (_req, res) => {
  try {
    const q = `
      SELECT DISTINCT TRIM(COALESCE(c.solicitante,'')) AS value,
             TRIM(COALESCE(c.solicitante,'')) AS label
      FROM doa2.cabecera_oc c
      WHERE c.solicitante IS NOT NULL AND c.solicitante <> ''
      ORDER BY 2
    `
    const { rows } = await pool.query(q)
    res.json(rows)
  } catch (err) {
    console.error('GET /filtros/solicitantes', err)
    res.status(500).json({ error: 'Error listando solicitantes' })
  }
})

// Compañías
router.get('/filtros/companias', async (_req, res) => {
  try {
    const q = `
      SELECT co.id_compania::text AS value,
             COALESCE(co.nombre_compania,'') AS label
      FROM doa2.companias co
      WHERE co.estado_registro = 'A'
      ORDER BY co.nombre_compania
    `
    const { rows } = await pool.query(q)
    res.json(rows)
  } catch (err) {
    console.error('GET /filtros/companias', err)
    res.status(500).json({ error: 'Error listando compañías' })
  }
})

// Sistemas
router.get('/filtros/sistemas', async (_req, res) => {
  try {
    const q = `
      SELECT DISTINCT TRIM(COALESCE(c.sistema,'')) AS value,
             TRIM(COALESCE(c.sistema,'')) AS label
      FROM doa2.cabecera_oc c
      WHERE c.sistema IS NOT NULL AND c.sistema <> ''
      ORDER BY 2
    `
    const { rows } = await pool.query(q)
    res.json(rows)
  } catch (err) {
    console.error('GET /filtros/sistemas', err)
    res.status(500).json({ error: 'Error listando sistemas' })
  }
})

// Proveedores (NIT - Nombre)
router.get('/filtros/proveedores', async (_req, res) => {
  try {
    const q = `
      SELECT DISTINCT
        TRIM(COALESCE(c.nit_proveedor,'')) AS nit,
        TRIM(COALESCE(c.nombre_proveedor,'')) AS nombre
      FROM doa2.cabecera_oc c
      WHERE c.nit_proveedor IS NOT NULL AND c.nit_proveedor <> ''
      ORDER BY 2
    `
    const { rows } = await pool.query(q)
    const out = rows.map(r => ({
      value: r.nit,
      label: `${r.nit} - ${r.nombre}`.trim()
    }))
    res.json(out)
  } catch (err) {
    console.error('GET /filtros/proveedores', err)
    res.status(500).json({ error: 'Error listando proveedores' })
  }
})

// Motivos
router.get('/anulacion/motivos', async (_req, res) => {
  try {
    const q = `
      SELECT id_more AS id, codigo, descripcion
      FROM doa2.motivo_rechazo
      WHERE estado_registro = 'A'
      ORDER BY descripcion
    `
    const { rows } = await pool.query(q)
    res.json(rows)
  } catch (err) {
    console.error('GET /anulacion/motivos', err)
    res.status(500).json({ error: 'Error obteniendo motivos' })
  }
})

/* ===================== Listado (DataTable) ===================== */
/**
 * GET /anulacion/lista
 * Query params: numeroSolicitud, numeroOc, centroCosto, solicitante, compania, sistema, proveedorNit,
 * prioridad (G|I|N|P|U), fechaInicio, fechaFin, page, pageSize
 */
router.get('/anulacion/lista', async (req, res) => {
  try {
    const {
      numeroSolicitud,
      numeroOc,
      centroCosto,
      solicitante,
      compania,
      sistema,
      proveedorNit,
      prioridad,
      fechaInicio,
      fechaFin,
      page = 1,
      pageSize = 15
    } = req.query;

    const params = [];
    const where = [
      `c.estado_registro = 'A'`,
      `COALESCE(c.estado_oc_id_esta,0) <> 4`
    ];

    if (numeroSolicitud) {
      params.push(like(numeroSolicitud));
      where.push(`c.numero_solicitud ILIKE $${params.length}`);
    }
    if (numeroOc) {
      params.push(like(numeroOc));
      where.push(`c.numero_orden_compra ILIKE $${params.length}`);
    }

    if (centroCosto && centroCosto !== '-1') {
      params.push(String(centroCosto).trim());
      where.push(`
        EXISTS (
          SELECT 1
          FROM doa2.centro_costo ccf
          WHERE c.centro_costo_id_ceco = ccf.id_ceco
            AND TRIM(UPPER(ccf.codigo)) = TRIM(UPPER($${params.length}))
        )
      `);
    }

    if (solicitante && solicitante !== '-1') {
      params.push(solicitante);
      where.push(`c.solicitante = $${params.length}`);
    }
    if (compania && compania !== '-1') {
      params.push(compania);
      where.push(`c.id_compania = $${params.length}`);
    }
    if (sistema && sistema !== '-1') {
      params.push(sistema);
      where.push(`c.sistema = $${params.length}`);
    }
    if (proveedorNit) {
      params.push(proveedorNit);
      where.push(`c.nit_proveedor = $${params.length}`);
    }
    if (prioridad && ['G','I','N','P','U'].includes(String(prioridad).toUpperCase())) {
      params.push(String(prioridad).toUpperCase());
      where.push(`c.prioridad_orden = $${params.length}`);
    }
    if (fechaInicio) {
      params.push(fechaInicio);
      where.push(`DATE(c.fecha_orden_compra) >= $${params.length}`);
    }
    if (fechaFin) {
      params.push(fechaFin);
      where.push(`DATE(c.fecha_orden_compra) <= $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const pageN = asInt(page, 1);
    const limitN = asInt(pageSize, 15);
    const offsetN = (pageN - 1) * limitN;

    // total
    const qCount = `
      SELECT COUNT(1) AS total
      FROM doa2.cabecera_oc c
      ${whereSql}
    `;
    const { rows: rc } = await pool.query(qCount, params);
    const total = Number(rc[0]?.total || 0);

    // ===== USD rate (la más reciente y activa) + datos =====
    const qData = `
      WITH usd AS (
        SELECT tasa_cambio
        FROM doa2.moneda
        WHERE UPPER(codigo) = 'USD' AND estado_registro = 'A'
        ORDER BY COALESCE(fecha_modificacion, fecha_creacion) DESC
        LIMIT 1
      )
      SELECT
        c.id_cabe AS id,
        c.numero_solicitud AS "numeroSolicitud",
        c.numero_orden_compra AS "numOrden",
        TO_CHAR(c.fecha_orden_compra,'YYYY-MM-DD') AS "fechaOrdenString",
        c.nombre_proveedor AS "descProveedor",
        c.nit_proveedor AS "proveedorNit",
        c.nombre_empresa AS "empresa",

        TRIM(cc.codigo) AS "centroCostoCodigo",
        COALESCE(TRIM(cc.descripcion),'') AS "centroCostoDescripcion",
        CASE
          WHEN TRIM(cc.codigo) <> '' AND COALESCE(TRIM(cc.descripcion),'') <> ''
            THEN TRIM(cc.codigo) || ' - ' || TRIM(cc.descripcion)
          ELSE COALESCE(TRIM(cc.codigo), TRIM(cc.descripcion), '')
        END AS "centroCosto",

        c.prioridad_orden AS "prioridadOrden",
        c.total_neto AS "totalNeto",

        -- ✅ Subtotal en COP y en USD (dividido por tasa USD)
        c.sub_total AS "subTotal",
        ROUND( c.sub_total / NULLIF((SELECT tasa_cambio FROM usd), 0), 2 ) AS "subTotalUsd",

        eo.descripcion AS "estado"
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.centro_costo cc ON cc.id_ceco = c.centro_costo_id_ceco
      LEFT JOIN doa2.estado_oc eo ON eo.id_esta = c.estado_oc_id_esta
      ${whereSql}
      ORDER BY c.fecha_orden_compra DESC, c.id_cabe DESC
      LIMIT ${limitN} OFFSET ${offsetN}
    `;
    const { rows } = await pool.query(qData, params);

    res.json({ data: rows, page: pageN, pageSize: limitN, total });
  } catch (err) {
    console.error('GET /anulacion/lista', err);
    res.status(500).json({ error: 'Error listando órdenes' });
  }
});


/* ============== Flujo (lista_autorizaccion + historial) ============== */
router.get('/anulacion/orden/:id/flujo', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, message: 'ID inválido' });

  try {
    const sql = `
      SELECT
        la.id_liau                                   AS id,
        ta.codigo                                     AS tipo_autorizador,    -- usa "codigo" como en tu ruta OK
        COALESCE(n.nivel, n.descripcion)              AS nivel,               -- toma nivel preferido
        COALESCE(cc.codigo, cc.descripcion, '')       AS centro_costo,
        COALESCE(eo.descripcion, 'PENDIENTE')         AS estado,
        mr.descripcion                                AS motivo_rechazo,
        la.observacion                                AS observacion,
        asg.personas_asignadas                        AS personas
      FROM doa2.lista_autorizaccion la
      LEFT JOIN doa2.tipo_autorizador ta ON ta.id_tiau = la.tipo_autorizador_id_tiau
      LEFT JOIN doa2.nivel n             ON n.id_nive  = la.nivel_id_nive
      LEFT JOIN doa2.centro_costo cc     ON cc.id_ceco = la.centro_costo_id_ceco
      LEFT JOIN doa2.estado_oc eo        ON eo.id_esta = la.estado_oc_id_esta
      LEFT JOIN doa2.motivo_rechazo mr   ON mr.id_more = la.motivo_rechazo_id_more

      /* Personas asignadas (tolerando NULL en tipo_autorizador y ceco) */
      LEFT JOIN LATERAL (
        WITH pers AS (
          SELECT DISTINCT jsonb_build_object(
            'id',     p.id_pers,
            'nombre', NULLIF(TRIM(p.nombre), ''),
            'correo', NULLIF(TRIM(p.email),  ''),   -- usa "correo" para que tu normalizador lo capte
            'rol',    ta.codigo                     -- mostramos el mismo "tipo" del paso
          ) AS pj
          FROM doa2.autorizador a
          JOIN doa2.persona p ON p.id_pers = a.persona_id_pers AND p.estado_registro = 'A'
          WHERE a.estado_registro = 'A'
            AND a.nivel_id_nive = la.nivel_id_nive
            AND (
                 (a.tipo_autorizador_id_tiau = la.tipo_autorizador_id_tiau)
              OR (a.tipo_autorizador_id_tiau IS NULL AND la.tipo_autorizador_id_tiau IS NULL)
            )
            AND (
                 a.centro_costo_id_ceco IS NULL
              OR a.centro_costo_id_ceco = la.centro_costo_id_ceco
            )
            AND (
                 COALESCE(a.temporal, 'N') = 'N'
              OR (a.temporal = 'S' AND (CURRENT_DATE BETWEEN a.fecha_inicio_temporal AND a.fecha_fin_temporal))
            )
        )
        SELECT COALESCE(
          (SELECT json_agg(pj ORDER BY pj->>'nombre', pj->>'correo') FROM pers),
          '[]'::json
        ) AS personas_asignadas
      ) asg ON TRUE

      WHERE la.cabecera_oc_id_cabe = $1::bigint
        AND la.estado_registro = 'A'

      ORDER BY
        CASE
          WHEN UPPER(COALESCE(n.nivel,'')) = 'DUENO CC' THEN 0
          WHEN ta.id_tiau IS NULL AND UPPER(COALESCE(n.nivel,'')) <> 'DUENO CC' THEN 1
          WHEN ta.id_tiau IS NOT NULL AND COALESCE(n.nivel,'') ~ '^[0-9]+$' THEN 2
          ELSE 3
        END,
        CASE
          WHEN COALESCE(n.nivel,'') ~ '^[0-9]+$' THEN (n.nivel)::int
          ELSE 9999
        END,
        ta.codigo NULLS LAST,
        la.id_liau;
    `;

    const { rows } = await pool.query(sql, [id]);

    // Map a camelCase + 'aprobadores' (lo que consume tu expandible)
    const data = rows.map((r, i) => ({
      tipoAutorizador: r.tipo_autorizador || null,
      nivel:           r.nivel || null,
      centroCosto:     r.centro_costo || '',
      estado:          r.estado || 'PENDIENTE',
      motivoRechazo:   r.motivo_rechazo || null,
      observacion:     r.observacion || null,
      aprobadores:     Array.isArray(r.personas) ? r.personas.map(p => ({
                         id: p.id,
                         nombre: p.nombre,
                         correo: p.correo,
                         rol: p.rol
                       })) : [],
      __idx:           i
    }));

    return res.json(data);
  } catch (err) {
    console.error('GET /anulacion/orden/:id/flujo', err);
    return res.status(500).json({ ok: false, message: 'Error consultando flujo' });
  }
});

/* =================== Cabecera + Detalle + Totales =================== */
router.get('/anulacion/orden/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  try {
    const qCab = `
      SELECT
        c.*,
        TRIM(cc.codigo) AS centro_costo_codigo,
        CASE c.estado_oc_id_esta
          WHEN 1 THEN 'INICIADO'
          WHEN 2 THEN 'EN PROCESO'
          WHEN 3 THEN 'RECHAZADO'
          WHEN 4 THEN 'APROBADO'
          WHEN 5 THEN 'ANULADO'
          ELSE '—'
        END AS estado_general,
        TO_CHAR(c.fecha_orden_compra,'YYYY-MM-DD') AS fecha_orden_string
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.centro_costo cc ON cc.id_ceco = c.centro_costo_id_ceco
      WHERE c.id_cabe = $1
      LIMIT 1
    `;
    const cab = await pool.query(qCab, [id]);
    if (cab.rowCount === 0) {
      return res.status(404).json({ error: 'Orden no encontrada' });
    }

    const qDet = `
      SELECT
        d.id_deta                 AS "idDetalle",
        d.cabecera_oc_id_cabe     AS "idCabecera",
        d.referencia,
        d.descripcion_referencia  AS "descripcion",
        d.unidad_medida           AS "unidadMedida",
        TO_CHAR(d.fecha_entrega,'YYYY-MM-DD') AS "fechaEntrega",
        d.cantidad,
        d.valor_unidad            AS "valorUnitario",
        d.descuento               AS "descuentoRef",
        d.iva                     AS "ivaRef",
        d.valor_descuento         AS "valorDescuento",
        d.valor_iva               AS "valorIva",
        d.valor_sin_iva_descuento AS "valorSinIvaDesc",
        d.valor_total             AS "valorTotal",
        d.estado_registro         AS "estadoRegistro"
      FROM doa2.detalle_oc d
      WHERE d.cabecera_oc_id_cabe = $1
      ORDER BY d.id_deta
    `;
    const det = await pool.query(qDet, [id]);

    // 🔹 tasa USD (más reciente)
    const { rows: rUsd } = await pool.query(`
      SELECT tasa_cambio
      FROM doa2.moneda
      WHERE UPPER(codigo) = 'USD' AND estado_registro = 'A'
      ORDER BY COALESCE(fecha_modificacion, fecha_creacion) DESC
      LIMIT 1
    `);
    const tasaUsd = Number(rUsd[0]?.tasa_cambio || 0);

    const c = cab.rows[0];
    const totales = {
      totalBruto: Number(c.total_bruto ?? 0),
      dctoGlobal: Number(c.descuento_global ?? 0),
      subTotal:   Number(c.sub_total ?? 0),
      valorIva:   Number(c.valor_iva ?? 0),
      totalNeto:  Number(c.total_neto ?? 0),
      // ✅ Nuevo: subtotal en USD
      subTotalUsd: tasaUsd > 0 ? Number((Number(c.sub_total ?? 0) / tasaUsd).toFixed(2)) : null,
      tasaUsd
    };

    res.json({ cabecera: c, detalle: det.rows, totales });
  } catch (err) {
    console.error('GET /anulacion/orden/:id', err);
    res.status(500).json({ error: 'Error consultando la orden' });
  }
});

/* =========================== Anulación =========================== */

// Anular 1
router.post('/anulacion/orden/:id/anular', async (req, res) => {
  const id = Number(req.params.id)
  const { usuario, motivoId, observacion } = req.body || {}
  if (!id) return res.status(400).json({ error: 'ID inválido' })
  if (!usuario) return res.status(400).json({ error: 'Usuario requerido' })

  try {
    await pool.query('BEGIN')

    const sel = await pool.query(
      `SELECT id_cabe, numero_orden_compra, estado_oc_id_esta, estado_registro
       FROM doa2.cabecera_oc
       WHERE id_cabe = $1
       FOR UPDATE`,
      [id]
    )
    if (sel.rowCount === 0) {
      await pool.query('ROLLBACK'); return res.status(404).json({ error: 'Orden no encontrada' })
    }
    const oc = sel.rows[0]
    if (oc.estado_registro !== 'A') {
      await pool.query('ROLLBACK'); return res.status(400).json({ error: 'Orden inactiva' })
    }
    if (Number(oc.estado_oc_id_esta) === 4) {
      await pool.query('ROLLBACK'); return res.status(400).json({ error: 'La orden ya está ANULADA' })
    }

    await pool.query(
      `UPDATE doa2.cabecera_oc
       SET estado_oc_id_esta = 4, fecha_modificacion = NOW(), oper_modifica = $2
       WHERE id_cabe = $1`,
      [id, usuario]
    )

    await pool.query(
      `INSERT INTO doa2.historial_autorizacion
       (estado, observacion, motivo_rechazo, fecha_creacion, oper_creador, estado_registro, cabecera_oc_id_cabe)
       VALUES ($1, $2, $3, NOW(), $4, 'A', $5)`,
      ['ANULADA', observacion ?? null, motivoId ?? null, usuario, id]
    )

    await pool.query('COMMIT')
    res.json({ success: true, message: `OC ${oc.numero_orden_compra} anulada` })
  } catch (err) {
    await pool.query('ROLLBACK')
    console.error('POST /anulacion/orden/:id/anular', err)
    res.status(500).json({ error: 'Error anulando la orden' })
  }
})

// Anulación MASIVA
router.post('/anulacion/ordenes/anular', async (req, res) => {
  const { ordenes, usuario, motivoId, observacion } = req.body || {}
  if (!usuario) return res.status(400).json({ error: 'Usuario requerido' })
  if (!Array.isArray(ordenes) || ordenes.length === 0) {
    return res.status(400).json({ error: 'No se enviaron órdenes' })
  }

  const ok = [], skip = [], fails = []
  try {
    await pool.query('BEGIN')

    for (const rawId of ordenes) {
      const id = Number(rawId)
      if (!id) { fails.push({ id: rawId, error: 'ID inválido' }); continue }

      try {
        const sel = await pool.query(
          `SELECT id_cabe, numero_orden_compra, estado_oc_id_esta, estado_registro
           FROM doa2.cabecera_oc
           WHERE id_cabe = $1
           FOR UPDATE`,
          [id]
        )
        if (sel.rowCount === 0) { fails.push({ id, error: 'No encontrada' }); continue }
        const oc = sel.rows[0]
        if (oc.estado_registro !== 'A') { skip.push({ id, motivo: 'Inactiva' }); continue }
        if (Number(oc.estado_oc_id_esta) === 4) { skip.push({ id, motivo: 'Ya anulada' }); continue }

        await pool.query(
          `UPDATE doa2.cabecera_oc
           SET estado_oc_id_esta = 4, fecha_modificacion = NOW(), oper_modifica = $2
           WHERE id_cabe = $1`,
          [id, usuario]
        )
        await pool.query(
          `INSERT INTO doa2.historial_autorizacion
           (estado, observacion, motivo_rechazo, fecha_creacion, oper_creador, estado_registro, cabecera_oc_id_cabe)
           VALUES ($1, $2, $3, NOW(), $4, 'A', $5)`,
          ['ANULADA', observacion ?? null, motivoId ?? null, usuario, id]
        )

        ok.push({ id, numero_orden_compra: oc.numero_orden_compra })
      } catch (e) {
        console.error('anulación masiva - id', id, e)
        fails.push({ id, error: e.message })
      }
    }

    await pool.query('COMMIT')
    res.json({ success: true, message: `OK=${ok.length}, SKIP=${skip.length}, FAIL=${fails.length}`, data: { ok, skip, fails } })
  } catch (err) {
    await pool.query('ROLLBACK')
    console.error('POST /anulacion/ordenes/anular', err)
    res.status(500).json({ error: 'Error en anulación masiva' })
  }
})

/* ============= Patch cabecera (observaciones/requisitos) ============= */
router.patch('/anulacion/orden/:id/cabecera', async (req, res) => {
  const id = Number(req.params.id)
  const { usuario, observaciones, requierePoliza, requiereContrato } = req.body || {}
  if (!id) return res.status(400).json({ error: 'ID inválido' })
  if (!usuario) return res.status(400).json({ error: 'Usuario requerido' })

  try {
    const sets = [], vals = []
    let i = 1
    if (observaciones != null) { sets.push(`observaciones = $${i++}`); vals.push(observaciones) }
    if (requierePoliza != null) { sets.push(`requiere_poliza = $${i++}`); vals.push(requierePoliza ? 'S' : 'N') }
    if (requiereContrato != null) { sets.push(`requiere_contrato = $${i++}`); vals.push(requiereContrato ? 'S' : 'N') }
    if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' })

    sets.push(`fecha_modificacion = NOW()`)
    sets.push(`oper_modifica = $${i++}`); vals.push(usuario)
    vals.push(id)

    const q = `
      UPDATE doa2.cabecera_oc
      SET ${sets.join(', ')}
      WHERE id_cabe = $${i}
      RETURNING id_cabe, observaciones, requiere_poliza, requiere_contrato
    `
    const { rows } = await pool.query(q, vals)
    res.json({ success: true, data: rows[0] })
  } catch (err) {
    console.error('PATCH /anulacion/orden/:id/cabecera', err)
    res.status(500).json({ error: 'Error actualizando cabecera' })
  }
})

// Flujo (forma adicional; mantenido por compatibilidad)
// GET /api/anulacion/orden/:id/flujo  (REEMPLAZAR POR ESTA VERSIÓN)
router.get('/anulacion/orden/:id/flujo', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'ID inválido' });

  try {
    const q = `
      SELECT
        la.id_liau,
        ta.descripcion                              AS tipo_autorizador,
        n.descripcion                               AS nivel,
        COALESCE(cc.descripcion,'')                 AS centro_costo,
        eoc.descripcion                             AS estado,
        mr.descripcion                              AS motivo_rechazo,
        la.observacion                              AS observacion,

        -- 🔽 Personas configuradas para este paso (por terna tipo/nivel/ceco)
        COALESCE(
          (
            SELECT json_agg(
                     json_build_object(
                       'id',    p.id_pers,
                       'nombre', COALESCE(p.nombre,''),
                       'correo', COALESCE(p.email,''),
                       'rol',   COALESCE(ta2.descripcion, ta.descripcion, ''),
                       -- Si no tienes estado por persona, puedes heredar el del paso:
                       'estado', eoc.descripcion
                     )
                     ORDER BY p.nombre NULLS LAST
                   )
            FROM doa2.autorizador au
            JOIN doa2.persona p      ON p.id_pers = au.persona_id_pers
            LEFT JOIN doa2.tipo_autorizador ta2 ON ta2.id_tiau = au.tipo_autorizador_id_tiau
            WHERE au.estado_registro = 'A'
              AND p.estado_registro  = 'A'
              AND au.tipo_autorizador_id_tiau = la.tipo_autorizador_id_tiau
              AND au.nivel_id_nive            = la.nivel_id_nive
              AND au.centro_costo_id_ceco     = la.centro_costo_id_ceco
          ),
          '[]'::json
        ) AS aprobadores

      FROM doa2.lista_autorizaccion la
      LEFT JOIN doa2.tipo_autorizador ta ON ta.id_tiau = la.tipo_autorizador_id_tiau
      LEFT JOIN doa2.nivel            n  ON n.id_nive  = la.nivel_id_nive
      LEFT JOIN doa2.centro_costo     cc ON cc.id_ceco = la.centro_costo_id_ceco
      LEFT JOIN doa2.estado_oc        eoc ON eoc.id_esta = la.estado_oc_id_esta
      LEFT JOIN doa2.motivo_rechazo   mr ON mr.id_more  = la.motivo_rechazo_id_more
      WHERE la.cabecera_oc_id_cabe = $1
      ORDER BY la.id_liau
    `;
    const { rows } = await pool.query(q, [id]);

    // 🔁 Shape amigable para el front (incluye aprobadores[])
    const data = rows.map((r, idx) => ({
      __idx: idx + 1, // útil como dataKey si quieres
      tipoAutorizador: r.tipo_autorizador,
      nivel:           r.nivel,
      centroCosto:     r.centro_costo,
      estado:          r.estado,
      motivoRechazo:   r.motivo_rechazo,
      observacion:     r.observacion,
      aprobadores:     Array.isArray(r.aprobadores) ? r.aprobadores : [],
    }));

    res.json(data);
  } catch (err) {
    console.error('GET /anulacion/orden/:id/flujo', err);
    res.status(500).json({ success: false, message: 'Error consultando flujo' });
  }
});


export default router
