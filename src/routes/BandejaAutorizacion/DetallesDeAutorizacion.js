import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();

/* ========================= Helpers base ========================= */
const norm = (s) => String(s ?? '').trim();
const q = (sql, params = [], cx = pool) => (cx || pool).query(sql, params);
const isEmpty = (v) => v === undefined || v === null || v === '';

/** Permisos elevados (super vista / super aprobador) */
const canDoAll = (req) => {
  const roles = req?.auth?.roles || [];
  const scope = req?.auth?.scope || [];
  return roles.includes('ADMIN')
      || roles.includes('SUPERAPROBADOR')
      || scope.includes('doa:aprobar:todas');
};

/** Estado por descripción exacta (por si lo necesitas suelto) */
async function resolveEstadoIdByDescripcion(descripcion, client = null) {
  const cx = client || pool;
  const { rows } = await cx.query(
    `SELECT id_esta
       FROM doa2.estado_oc
      WHERE estado_registro='A' AND UPPER(TRIM(descripcion)) = UPPER(TRIM($1))
      LIMIT 1`,
    [descripcion]
  );
  return rows[0]?.id_esta ?? null;
}

/** Todos los IDs de estado en un solo viaje */
async function resolveEstadoIds(client = null) {
  const cx = client || pool;
  const { rows } = await cx.query(`
    SELECT id_esta, UPPER(TRIM(descripcion)) AS d
      FROM doa2.estado_oc
     WHERE estado_registro='A'
  `);
  const map = {};
  for (const r of rows) map[r.d] = r.id_esta;
  return {
    INICIADO : map['INICIADO'],
    APROBADO : map['APROBADO'],
    RECHAZADO: map['RECHAZADO'],
    MAS_DATOS: map['SE NECESITAN MAS DATOS'],
  };
}

/** Código de centro de costo desde id */
async function getCentroCostoCodigo(ccId, client = null) {
  if (!ccId) return null;
  const cx = client || pool;
  const { rows } = await cx.query(
    `SELECT codigo FROM doa2.centro_costo WHERE id_ceco = $1 LIMIT 1`,
    [ccId]
  );
  return rows[0]?.codigo ?? null;
}

/** id de centro de costo por código */
async function getCentroCostoIdByCodigo(codigo, client = null) {
  const cod = norm(codigo);
  if (!cod) return null;
  const cx = client || pool;
  const { rows } = await cx.query(
    `SELECT id_ceco FROM doa2.centro_costo WHERE TRIM(codigo)=TRIM($1) LIMIT 1`,
    [cod]
  );
  return rows[0]?.id_ceco ?? null;
}

/** Niveles configurados para un CECO (activos y vigentes) */
async function getConfiguredLevelsByCeco(client, cecoId) {
  const { rows } = await client.query(`
    SELECT DISTINCT a.nivel_id_nive AS nid
      FROM doa2.autorizador a
     WHERE a.estado_registro='A'
       AND a.centro_costo_id_ceco = $1
       AND (
         COALESCE(a.temporal,'N')='N'
         OR (a.temporal='S' AND (NOW()::date BETWEEN a.fecha_inicio_temporal AND a.fecha_fin_temporal))
       )
     ORDER BY 1 ASC
  `,[cecoId]);
  return rows.map(r => Number(r.nid)).filter(Number.isFinite);
}

/** Roles del aprobador (para limitar aprobación cuando NO es superAll) */
async function getUserAuthorizerRoles(client, personaId) {
  const { rows } = await q(
    `SELECT
       a.id_auto,
       a.persona_id_pers          AS "personaId",
       a.tipo_autorizador_id_tiau AS "tipoId",
       a.nivel_id_nive            AS "nivelId",
       a.centro_costo_id_ceco     AS "cecoId"
     FROM doa2.autorizador a
    WHERE a.estado_registro='A'
      AND a.persona_id_pers = $1
      AND (
        COALESCE(a.temporal,'N')='N'
        OR (a.temporal='S' AND (NOW()::date BETWEEN a.fecha_inicio_temporal AND a.fecha_fin_temporal))
      )`,
    [personaId],
    client
  );

  // ⚠️ No conviertas a Number() si puede venir NULL.
  return rows.map(r => ({
    nivelId: Number(r.nivelId),
    tipoId : r.tipoId === null ? null : Number(r.tipoId),
    cecoId : Number(r.cecoId),
  })).filter(r => Number.isFinite(r.nivelId) && Number.isFinite(r.cecoId));
}

/** Inserta historial para un conjunto de marcas (RETURNING de UPDATE) */
async function insertHistForMarks(client, marks, { estado, observacion, motivoId, personaId }) {
  if (!Array.isArray(marks) || marks.length === 0) return;
  const estadoTxt = norm(estado) || '-';
  const userTxt = String(personaId ?? 'web');

  // Insert masivo por VALUES
  const values = [];
  const params = [];
  let i = 1;

  for (const m of marks) {
    const liauId = Number(m.liauId);
    const cabId  = Number(m.cabId);
    if (!Number.isFinite(liauId) || !Number.isFinite(cabId)) continue;

    values.push(`($${i++}, $${i++}, $${i++}, NOW(), $${i++}, 'A', $${i++}, $${i++})`);
    params.push(
      estadoTxt,
      observacion ?? null,
      motivoId ?? null,
      userTxt,
      liauId,
      cabId
    );
  }

  if (values.length === 0) return;

  const sql = `
    INSERT INTO doa2.historial_autorizacion
      (estado, observacion, motivo_rechazo, fecha_creacion, oper_creador, estado_registro,
       lista_autorizaccion_id_liau, cabecera_oc_id_cabe)
    VALUES ${values.join(',')}
  `;
  await client.query(sql, params);
}

/** Recalcula estado agregado y sincroniza cabecera_oc */
async function recomputeAndSyncHeader(client, ocId, personaId) {
  const EST = await resolveEstadoIds(client);
  const q = await client.query(`
    SELECT
      SUM((estado_oc_id_esta = $1)::int) AS n_aprob,
      SUM((estado_oc_id_esta = $2)::int) AS n_rech,
      SUM((estado_oc_id_esta = $3)::int) AS n_ini
    FROM doa2.lista_autorizaccion
    WHERE estado_registro='A' AND cabecera_oc_id_cabe=$4
  `, [EST.APROBADO, EST.RECHAZADO, EST.INICIADO, ocId]);

  const n_aprob = Number(q.rows?.[0]?.n_aprob || 0);
  const n_rech  = Number(q.rows?.[0]?.n_rech  || 0);
  const n_ini   = Number(q.rows?.[0]?.n_ini   || 0);

  let headerEstado = EST.INICIADO; // default “en proceso”
  if (n_rech > 0) headerEstado = EST.RECHAZADO;
  else if (n_ini === 0) headerEstado = EST.APROBADO;

  await client.query(`
    UPDATE doa2.cabecera_oc
       SET estado_oc_id_esta = $2,
           fecha_modificacion = NOW(),
           oper_modifica = $3
     WHERE id_cabe = $1::bigint
  `, [ocId, headerEstado, String(personaId)]);
}

/* ===================== FLUJO (solo pasos de la OC, con personas asignadas) ===================== */
router.get('/ordenes/:id/flujo', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ ok:false, message:'ID inválido' });

  try {
    const sql = `
      SELECT
        la.id_liau                                   AS id,
        ta.codigo                                     AS "tipoAutorizador",
        n.nivel                                       AS "nivel",
        cc.codigo                                     AS "centroCosto",
        eo.descripcion                                 AS "estado",
        mr.descripcion                                 AS "motivoRechazo",
        la.observacion                                 AS "observaciones",
        asg.personas_asignadas                         AS "personas"
      FROM doa2.lista_autorizaccion la
      LEFT JOIN doa2.tipo_autorizador ta ON ta.id_tiau = la.tipo_autorizador_id_tiau
      LEFT JOIN doa2.nivel n             ON n.id_nive  = la.nivel_id_nive
      LEFT JOIN doa2.centro_costo cc     ON cc.id_ceco = la.centro_costo_id_ceco
      LEFT JOIN doa2.estado_oc eo        ON eo.id_esta = la.estado_oc_id_esta
      LEFT JOIN doa2.motivo_rechazo mr   ON mr.id_more = la.motivo_rechazo_id_more

      /* Personas asignadas (soporta tipo_autorizador NULL) */
      LEFT JOIN LATERAL (
        WITH pers AS (
          SELECT DISTINCT jsonb_build_object(
            'id',     p.id_pers,
            'nombre', NULLIF(TRIM(p.nombre), ''),
            'email',  NULLIF(TRIM(p.email),  '')
          ) AS pj
          FROM doa2.autorizador a
          JOIN doa2.persona p ON p.id_pers = a.persona_id_pers AND p.estado_registro='A'
          WHERE a.estado_registro='A'
            AND a.nivel_id_nive = la.nivel_id_nive
            AND (
                 (a.tipo_autorizador_id_tiau = la.tipo_autorizador_id_tiau)
              OR (a.tipo_autorizador_id_tiau IS NULL AND la.tipo_autorizador_id_tiau IS NULL)
            )
            AND (a.centro_costo_id_ceco IS NULL OR a.centro_costo_id_ceco = la.centro_costo_id_ceco)
            AND (
                 COALESCE(a.temporal,'N')='N'
              OR (a.temporal='S' AND (NOW()::date BETWEEN a.fecha_inicio_temporal AND a.fecha_fin_temporal))
            )
        )
        SELECT COALESCE(
          (SELECT json_agg(pj ORDER BY pj->>'nombre', pj->>'email') FROM pers),
          '[]'::json
        ) AS personas_asignadas
      ) asg ON TRUE

      WHERE la.cabecera_oc_id_cabe = $1::bigint
        AND la.estado_registro='A'

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
        la.id_liau
    `;
    const { rows } = await pool.query(sql, [id]);
    res.json(rows);
  } catch (err) {
    console.error('GET /detalles-bandeja-autorizacion/ordenes/:id/flujo', err);
    res.status(500).json({ ok:false, message:'Error obteniendo flujo' });
  }
});

/* ===================== CATÁLOGO MOTIVOS ===================== */
router.get('/motivos-rechazo', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id_more AS id, descripcion
        FROM doa2.motivo_rechazo
       WHERE estado_registro='A'
       ORDER BY descripcion
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /motivos-rechazo', e);
    res.status(500).json({ error: 'Error obteniendo motivos' });
  }
});

/* ===================== PÓLIZAS: catálogos/selección ===================== */
router.get('/polizas/tipos', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        tp.id_tipo       AS "id",
        tp.descripcion   AS "label",
        tp.porcentaje    AS "porcentajeDef",
        tp.posicion      AS "posicion"
      FROM doa2.tipo_poliza tp
      WHERE tp.estado_registro='A'
      ORDER BY COALESCE(tp.posicion, 9999), tp.descripcion
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /polizas/tipos', e);
    res.status(500).json({ error: 'Error obteniendo tipos de póliza' });
  }
});

router.get('/ordenes/:id/polizas', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

  try {
    const cab = await pool.query(`
      SELECT 
        COALESCE(requiere_poliza,'N')   AS "requierePoliza",
        COALESCE(requiere_contrato,'N') AS "requiereContrato"
      FROM doa2.cabecera_oc
      WHERE id_cabe = $1::bigint
      LIMIT 1
    `, [id]);
    const base = cab.rows[0] || { requierePoliza: 'N', requiereContrato: 'N' };

    const sel = await pool.query(`
      SELECT
        tpxo.tipo_poliza_id_tipo         AS "tipoId",
        COALESCE(tpxo.porcentaje,0)::numeric AS "porcentaje",
        tp.descripcion                   AS "label"
      FROM doa2.tipo_poliza_x_oc tpxo
      JOIN doa2.tipo_poliza tp ON tp.id_tipo = tpxo.tipo_poliza_id_tipo
      WHERE tpxo.estado_registro='A'
        AND tpxo.cabecera_oc_id_cabe = $1::bigint
      ORDER BY COALESCE(tp.posicion,9999), tp.descripcion
    `, [id]);

    res.json({
      requierePoliza: base.requierePoliza === 'S',
      requiereContrato: base.requiereContrato === 'S',
      seleccion: sel.rows.map(r => ({
        tipoId: Number(r.tipoId),
        porcentaje: Number(r.porcentaje || 0),
        label: r.label || ''
      })),
    });
  } catch (e) {
    console.error('GET /ordenes/:id/polizas', e);
    res.status(500).json({ error: 'Error obteniendo pólizas de la OC' });
  }
});

router.put('/ordenes/:id/polizas', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

  const requierePoliza   = !!req.body?.requierePoliza;
  const requiereContrato = !!req.body?.requiereContrato;
  const tipos = Array.isArray(req.body?.tipos) ? req.body.tipos : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE doa2.cabecera_oc
         SET requiere_poliza   = $2,
             requiere_contrato = $3,
             fecha_modificacion = NOW(),
             oper_modifica = $4
       WHERE id_cabe = $1::bigint
    `, [id, requierePoliza ? 'S' : 'N', requiereContrato ? 'S' : 'N', String(req.headers['x-user'] || 'web')]);

    await client.query(`
      UPDATE doa2.tipo_poliza_x_oc
         SET estado_registro='I',
             fecha_modificacion = NOW(),
             oper_modifica = $2
       WHERE cabecera_oc_id_cabe = $1::bigint
         AND estado_registro='A'
    `, [id, String(req.headers['x-user'] || 'web')]);

    for (const t of tipos) {
      const tipoId = Number(t?.tipoId);
      const pct    = Number(t?.porcentaje);
      if (!Number.isFinite(tipoId)) continue;

      await client.query(`
        INSERT INTO doa2.tipo_poliza_x_oc
          (porcentaje, fecha_creacion, oper_creador, estado_registro,
           tipo_poliza_id_tipo, cabecera_oc_id_cabe, cabecera_oc_pendientes_id_cabe)
        VALUES
          ($1::numeric, NOW(), $2, 'A',
           $3::bigint, $4::bigint, NULL)
      `, [Number.isFinite(pct) ? pct : 0, String(req.headers['x-user'] || 'web'), tipoId, id]);
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('PUT /ordenes/:id/polizas', e);
    res.status(500).json({ error: 'No se pudo guardar las pólizas' });
  } finally {
    client.release();
  }
});

/* ===================== “Se necesitan más datos” ===================== */
router.post('/mas-datos', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  const usuario = norm(req.body?.usuario) || 'web';
  const descripcion = norm(req.body?.descripcion) || '';

  if (!ids.length || !descripcion) {
    return res.status(400).json({ error: 'Debe enviar ids[] y descripcion' });
  }

  const client = await pool.connect();
  try {
    const EST = await resolveEstadoIds(client);
    if (!EST.MAS_DATOS) return res.status(400).json({ error: 'No existe estado "SE NECESITAN MAS DATOS" en estado_oc' });

    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '45s'; SET LOCAL lock_timeout = '5s';`);

    // Validación de pendientes disponibles
    const v = await client.query(`
      SELECT c.id_cabepen AS id, c.centrocosto
        FROM doa2.cabecera_oc_pendientes c
       WHERE c.id_cabepen = ANY($1::bigint[])
         AND c.estado_registro='A'
         AND COALESCE(c.anular,'N')<>'S'
         AND COALESCE(c.orden_gestionada,'N')<>'S'
    `, [ids]);

    const valid = v.rows;
    const validIds = valid.map(r => r.id);
    const invalid = ids.filter(x => !validIds.includes(x));
    if (!validIds.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'OC(s) inválidas o no disponibles', invalidIds: invalid });
    }

    for (const row of valid) {
      const ccCod = String(row.centrocosto || '').trim();
      let ccId = null;
      if (ccCod) ccId = await getCentroCostoIdByCodigo(ccCod, client);

      await client.query(`
        INSERT INTO doa2.lista_autorizaccion
          (observacion, fecha_creacion, oper_creador, estado_registro,
           estado_oc_id_esta, cabecera_oc_id_cabe, motivo_rechazo_id_more,
           tipo_autorizador_id_tiau, nivel_id_nive, centro_costo_id_ceco)
        VALUES ($1, NOW(), $2, 'A', $3, $4, NULL, NULL, NULL, $5)
      `, [descripcion, usuario, EST.MAS_DATOS, row.id, ccId]);
    }

    await client.query(`
      INSERT INTO doa2.historial_autorizacion
        (estado, observacion, motivo_rechazo, fecha_creacion, oper_creador, estado_registro,
         lista_autorizaccion_id_liau, cabecera_oc_id_cabe)
      SELECT 'SE NECESITAN MAS DATOS', $2, NULL, NOW(), $3, 'A', NULL, id
        FROM UNNEST($1::bigint[]) AS t(id)
    `, [validIds, descripcion, usuario]);

    await client.query('COMMIT');
    res.json({ ok: true, procesadas: validIds, ignoradas: invalid });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST /mas-datos', e);
    res.status(500).json({ error: 'No se pudo registrar “más datos”' });
  } finally {
    client.release();
  }
});

/* ===================== Catálogos para filtros ===================== */
router.get('/centros-costo', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id_ceco AS id, codigo, descripcion
        FROM doa2.centro_costo
       WHERE estado_registro='A'
       ORDER BY codigo
    `);
    res.json(rows.map(r => ({
      id: r.id,
      codigo: r.codigo,
      descripcion: r.descripcion,
      value: r.codigo,
      label: `${r.codigo} - ${r.descripcion}`.trim(),
    })));
  } catch (e) {
    console.error('GET /centros-costo', e);
    res.status(500).json({ error: 'Error obteniendo centros de costo' });
  }
});

router.get('/companias', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id_compania AS id, codigo_compania AS codigo, nombre_compania AS nombre
        FROM doa2.companias
       WHERE estado_registro='A'
       ORDER BY codigo_compania
    `);
    res.json(rows.map(r => ({
      id: r.id,
      codigo: r.codigo,
      nombre: r.nombre,
      value: r.codigo,
      label: `${r.codigo} - ${r.nombre}`.trim(),
    })));
  } catch (e) {
    console.error('GET /companias', e);
    res.status(500).json({ error: 'Error obteniendo compañías' });
  }
});

/* ===================== Detalle OC (cabecera + detalle + totales) ===================== */
router.get('/ordenes/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

  try {
    const cabQ = await pool.query(`
      SELECT
        c.id_cabe                     AS "id",
        c.numero_solicitud            AS "numeroSolicitud",
        c.numero_orden_compra         AS "numeroOrden",
        c.fecha_orden_compra          AS "fechaOrden",
        c.nombre_proveedor            AS "proveedorNombre",
        c.nit_proveedor               AS "proveedorNit",
        c.email_proveedor             AS "proveedorEmail",
        c.contacto_proveedor          AS "proveedorContacto",
        c.direccion_proveedor         AS "proveedorDireccion",
        c.telefono_proveedor          AS "proveedorTelefono",
        c.fax_proveedor               AS "proveedorFax",
        c.ciudad_proveedor            AS "proveedorCiudad",
        c.departamento_proveedor      AS "proveedorDepartamento",
        c.pais_proveedor              AS "proveedorPais",
        c.nombre_empresa              AS "empresa",
        c.direccion_empresa           AS "empresaDireccion",
        c.telefono_empresa            AS "empresaTelefono",
        c.ciudad_empresa              AS "ciudadEmpresa",
        c.pais_empresa                AS "paisEmpresa",
        c.nit_empresa                 AS "nitEmpresa",
        c.email_empresa               AS "emailEmpresa",
        c.fax_empresa                 AS "faxEmpresa",
        c.compania                    AS "compania",
        c.nit_compania                AS "nitCompania",
        c.moneda                      AS "moneda",
        c.forma_de_pago               AS "formaPago",
        c.condiciones_de_pago         AS "condicionesPago",
        c.email_comprador             AS "comprador",
        c.lugar_entrega               AS "lugarEntrega",
        c.solicitante                 AS "solicitanteNombre",
        c.email_solicitante           AS "solicitanteEmail",
        TRIM(cc.codigo)               AS "centroCostoStr",
        c.prioridad_orden             AS "prioridad",
        c.observaciones               AS "observaciones",
        c.observacion_compras         AS "observacionCompras",
        c.total_bruto                 AS "totalBruto",
        c.descuento_global            AS "descuentoGlobal",
        c.sub_total                   AS "subTotal",
        c.valor_iva                   AS "valorIva",
        c.total_neto                  AS "totalNeto",
        c.requiere_poliza             AS "requierePoliza",
        c.requiere_contrato           AS "requiereContrato",
        c.estado_registro             AS "estadoRegistro",
        c.envio_correo                AS "envioCorreo"
        ,eo.descripcion               AS "estadoGeneral"
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.centro_costo cc ON cc.id_ceco = c.centro_costo_id_ceco
      LEFT JOIN doa2.estado_oc    eo ON eo.id_esta = c.estado_oc_id_esta
      WHERE c.id_cabe = $1::bigint
      LIMIT 1
    `,[id]);

    if (!cabQ.rows.length) return res.status(404).json({ error: 'OC no encontrada' });
    const cab = cabQ.rows[0];

    const detQ = await pool.query(`
      SELECT
        d.id_deta                          AS "idDetalle",
        d.cabecera_oc_id_cabe              AS "idCabecera",
        d.referencia                       AS "referencia",
        d.descripcion_referencia           AS "descripcion",
        d.unidad_medida                    AS "unidadMedida",
        d.fecha_entrega                    AS "fechaEntrega",
        COALESCE(d.cantidad,0)::numeric          AS "cantidad",
        COALESCE(d.valor_unidad,0)::numeric      AS "valorUnitario",
        COALESCE(d.descuento,0)::numeric         AS "descuentoRef",
        COALESCE(d.iva,0)::numeric               AS "ivaRef",
        COALESCE(d.valor_descuento,0)::numeric   AS "valorDescuento",
        COALESCE(d.valor_iva,0)::numeric         AS "valorIva",
        COALESCE(d.valor_sin_iva_descuento,0)::numeric AS "valorSinIvaDesc",
        COALESCE(d.valor_total,0)::numeric       AS "valorTotal",
        d.estado_registro                        AS "estadoRegistro"
      FROM doa2.detalle_oc d
      WHERE d.cabecera_oc_id_cabe = $1::bigint
        AND d.estado_registro = 'A'
      ORDER BY d.id_deta ASC
    `, [id]);

    const det = detQ.rows;

    // Totales recalculados
    let totalBruto=0, dctoGlobal=0, valorIva=0, subTotal=0, totalNeto=0;
    for (const r of det) {
      const c  = Number(r.cantidad || 0);
      const vu = Number(r.valorUnitario || 0);
      const dP = Number(r.descuentoRef || 0) / 100;
      const iP = Number(r.ivaRef || 0) / 100;
      const bruto = vu * c;
      const dcto  = bruto * dP;
      const sinIvaDesc = bruto - dcto;
      const ivaVal = sinIvaDesc * iP;
      const tot    = sinIvaDesc + ivaVal;
      totalBruto += bruto;
      dctoGlobal += dcto;
      valorIva   += ivaVal;
      subTotal   += sinIvaDesc;
      totalNeto  += tot;
    }

    res.json({
      cabecera: cab,
      detalle: det,
      totales: { totalBruto, dctoGlobal, subTotal, valorIva, totalNeto }
    });
  } catch (e) {
    console.error('GET /bandeja-autorizacion/ordenes/:id', e);
    res.status(500).json({ error: 'Error consultando la OC' });
  }
});

/* =================== APROBAR ===================
   Body:
   {
     ids: number[],          // IDs cabecera_oc
     personaId: number,      // aprobador
     observacion?: string,
     cascade?: boolean       // opcional: si superAll=true aprueba todos los niveles
   }
*/
router.post('/aprobar', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  const personaId = Number(req.body?.personaId);
  const observacion = norm(req.body?.observacion) || null;
  const cascade = !!req.body?.cascade;
  if (!ids.length || !Number.isFinite(personaId)) {
    return res.status(400).json({ error: 'Debe enviar ids[] (cabecera) y personaId' });
  }

  const superAll = canDoAll(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='5s';`);
    const EST = await resolveEstadoIds(client);

    const approveLevelBatch = async (ocIds, unrestricted = false) => {
      let upd;
      if (unrestricted) {
        upd = await client.query(`
          UPDATE doa2.lista_autorizaccion la
             SET estado_oc_id_esta = $1,
                 fecha_modificacion = NOW(),
                 oper_modifica = $2
           WHERE la.estado_registro='A'
             AND la.estado_oc_id_esta = $3
             AND la.cabecera_oc_id_cabe = ANY($4::bigint[])
          RETURNING la.id_liau AS "liauId", la.cabecera_oc_id_cabe AS "cabId"
        `,[EST.APROBADO, String(personaId), EST.INICIADO, ocIds]);
      } else {
        const roles = await getUserAuthorizerRoles(client, personaId);
        if (!roles.length) return { rowCount: 0, rows: [] };
        upd = await client.query(`
          UPDATE doa2.lista_autorizaccion la
             SET estado_oc_id_esta = $1,
                 fecha_modificacion = NOW(),
                 oper_modifica = $2
           WHERE la.estado_registro='A'
             AND la.estado_oc_id_esta = $3
             AND la.cabecera_oc_id_cabe = ANY($4::bigint[])
             AND EXISTS (
               SELECT 1 FROM UNNEST($5::bigint[], $6::bigint[], $7::bigint[]) AS r(nivelId, tipoId, cecoId)
               WHERE la.nivel_id_nive = r.nivelId
                 AND la.tipo_autorizador_id_tiau = r.tipoId
                 AND la.centro_costo_id_ceco = r.cecoId
             )
          RETURNING la.id_liau AS "liauId", la.cabecera_oc_id_cabe AS "cabId"
        `,[
          EST.APROBADO, String(personaId), EST.INICIADO, ocIds,
          roles.map(r=>r.nivelId), roles.map(r=>r.tipoId), roles.map(r=>r.cecoId),
        ]);
      }
      await insertHistForMarks(client, upd.rows, {
        estado: 'APROBADO',
        observacion,
        motivoId: null,
        personaId,
      });
      // Sanea INICIADO sobrante
      await client.query(`
        UPDATE doa2.lista_autorizaccion
           SET estado_registro='I',
               fecha_modificacion = NOW(),
               oper_modifica = $2
         WHERE cabecera_oc_id_cabe = ANY($1::bigint[])
           AND estado_registro='A'
           AND estado_oc_id_esta = $3
      `,[ocIds, String(personaId), EST.INICIADO]);
      return upd;
    };

    // 1) Aprobar nivel actual (según roles o todo si superAll)
    const firstUpd = await approveLevelBatch(ids, superAll);

    // 2) Abrir siguiente nivel (si existe) y actualizar cabecera
    const openNextFor = async (ocId) => {
      const base = await client.query(`
        SELECT c.centro_costo_id_ceco AS ceco_id, TRIM(cc.codigo) AS ceco_txt
          FROM doa2.cabecera_oc c
     LEFT JOIN doa2.centro_costo cc ON cc.id_ceco = c.centro_costo_id_ceco
         WHERE c.id_cabe = $1::bigint
         LIMIT 1
      `,[ocId]);
      if (!base.rows.length) return;
      const cecoId = base.rows[0].ceco_id || await getCentroCostoIdByCodigo(base.rows[0].ceco_txt, client);
      if (!cecoId) return;

      const cur = await client.query(`
        SELECT COALESCE(MAX(nivel_id_nive),0) AS nivel_max
          FROM doa2.lista_autorizaccion
         WHERE cabecera_oc_id_cabe = $1::bigint
           AND estado_registro='A'
      `,[ocId]);
      const nivelMax = Number(cur.rows[0]?.nivel_max || 0);

      const nivelesCfg = await getConfiguredLevelsByCeco(client, cecoId);
      const siguientes = nivelesCfg.filter(nv => nv > nivelMax);
      if (siguientes.length === 0) return;

      const nivelSiguiente = Math.min(...siguientes);
      const sig = await client.query(`
        SELECT DISTINCT a.tipo_autorizador_id_tiau AS "tipoId", a.nivel_id_nive AS "nivelId"
          FROM doa2.autorizador a
         WHERE a.estado_registro='A'
           AND a.centro_costo_id_ceco = $1
           AND a.nivel_id_nive = $2
           AND (
             COALESCE(a.temporal,'N')='N'
             OR (a.temporal='S' AND (NOW()::date BETWEEN a.fecha_inicio_temporal AND a.fecha_fin_temporal))
           )
      `,[cecoId, nivelSiguiente]);

      for (const r of sig.rows) {
        await client.query(`
          INSERT INTO doa2.lista_autorizaccion
            (observacion, fecha_creacion, oper_creador, estado_registro,
             estado_oc_id_esta, cabecera_oc_id_cabe, motivo_rechazo_id_more,
             tipo_autorizador_id_tiau, nivel_id_nive, centro_costo_id_ceco)
          VALUES
            ($1, NOW(), $2, 'A',
             $3, $4, NULL,
             $5, $6, $7)
        `,[observacion, String(personaId), EST.INICIADO, ocId, r.tipoId, r.nivelId, cecoId]);
      }
    };

    for (const ocId of ids) {
      await openNextFor(ocId);
      await recomputeAndSyncHeader(client, ocId, personaId);
    }

    // 3) Cascada (opcional) — solo si superAll=true
    if (cascade && superAll) {
      // Hasta 20 iteraciones por seguridad
      for (let iter = 0; iter < 20; iter++) {
        // ¿Quedan INICIADO en alguna OC?
        const { rows: pend } = await client.query(`
          SELECT DISTINCT cabecera_oc_id_cabe AS id
            FROM doa2.lista_autorizaccion
           WHERE estado_registro='A' AND estado_oc_id_esta = $1
             AND cabecera_oc_id_cabe = ANY($2::bigint[])
        `, [EST.INICIADO, ids]);
        const pendIds = pend.map(r => Number(r.id));
        if (pendIds.length === 0) break;

        // Aprueba todo ese nivel (sin roles) y abre el siguiente
        await approveLevelBatch(pendIds, true);
        for (const ocId of pendIds) {
          await openNextFor(ocId);
          await recomputeAndSyncHeader(client, ocId, personaId);
        }
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, actualizadas: firstUpd.rowCount || 0, cascade: cascade && superAll ? 'done' : 'off' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST /bandeja-autorizacion/aprobar', e);
    res.status(500).json({ error: 'No se pudo aprobar' });
  } finally {
    client.release();
  }
});

/* =================== RECHAZAR =================== */
router.post('/rechazar', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  const personaId = Number(req.body?.personaId);
  const motivoId  = Number(req.body?.motivoId);
  const descripcion = norm(req.body?.descripcion) || '';
  if (!ids.length || !Number.isFinite(personaId) || !Number.isFinite(motivoId) || !descripcion) {
    return res.status(400).json({ error: 'Debe enviar ids[], personaId, motivoId y descripcion' });
  }

  const superAll = canDoAll(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout='45s'; SET LOCAL lock_timeout='5s';`);
    const EST = await resolveEstadoIds(client);

    let upd;
    if (superAll) {
      upd = await client.query(`
        UPDATE doa2.lista_autorizaccion la
           SET estado_oc_id_esta = $1,
               motivo_rechazo_id_more = $2,
               observacion = $3,
               fecha_modificacion = NOW(),
               oper_modifica = $4
         WHERE la.estado_registro='A'
           AND la.estado_oc_id_esta = $5
           AND la.cabecera_oc_id_cabe = ANY($6::bigint[])
        RETURNING la.id_liau AS "liauId", la.cabecera_oc_id_cabe AS "cabId"
      `,[EST.RECHAZADO, motivoId, descripcion, String(personaId), EST.INICIADO, ids]);
    } else {
      const roles = await getUserAuthorizerRoles(client, personaId);
      if (!roles.length) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Aprobador sin roles activos' }); }
      upd = await client.query(`
        UPDATE doa2.lista_autorizaccion la
           SET estado_oc_id_esta = $1,
               motivo_rechazo_id_more = $2,
               observacion = $3,
               fecha_modificacion = NOW(),
               oper_modifica = $4
         WHERE la.estado_registro='A'
           AND la.estado_oc_id_esta = $5
           AND la.cabecera_oc_id_cabe = ANY($6::bigint[])
           AND EXISTS (
             SELECT 1 FROM UNNEST($7::bigint[], $8::bigint[], $9::bigint[]) AS r(nivelId, tipoId, cecoId)
             WHERE la.nivel_id_nive = r.nivelId
               AND la.tipo_autorizador_id_tiau = r.tipoId
               AND la.centro_costo_id_ceco = r.cecoId
           )
        RETURNING la.id_liau AS "liauId", la.cabecera_oc_id_cabe AS "cabId"
      `,[
        EST.RECHAZADO, motivoId, descripcion, String(personaId), EST.INICIADO, ids,
        roles.map(r=>r.nivelId), roles.map(r=>r.tipoId), roles.map(r=>r.cecoId),
      ]);
    }

    await insertHistForMarks(client, upd.rows, {
      estado: 'RECHAZADO',
      observacion: descripcion,
      motivoId,
      personaId,
    });

    await client.query(`
      UPDATE doa2.lista_autorizaccion
         SET estado_registro='I',
             fecha_modificacion = NOW(),
             oper_modifica = $2
       WHERE cabecera_oc_id_cabe = ANY($1::bigint[])
         AND estado_registro='A'
         AND estado_oc_id_esta = $3
    `,[ids, String(personaId), EST.INICIADO]);

    for (const ocId of ids) {
      await recomputeAndSyncHeader(client, ocId, personaId);
    }

    await client.query('COMMIT');
    res.json({ ok: true, actualizadas: upd.rowCount || 0 });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST /bandeja-autorizacion/rechazar', e);
    res.status(500).json({ error: 'No se pudo rechazar' });
  } finally {
    client.release();
  }
});

export default router;
