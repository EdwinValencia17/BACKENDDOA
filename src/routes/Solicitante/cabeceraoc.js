// routes/cabecera-oc.js  (JS, ESM)
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();

function maskBearer(h = '') {
  if (!h) return null;
  const [type, tok] = String(h).split(' ');
  if (!tok) return h;
  return `${type} ${tok.slice(0, 8)}…${tok.slice(-4)}`;
}

router.use((req, _res, next) => {
  console.log('[cabecera-oc] ->', req.method, req.originalUrl, {
    query: req.query,
    hasBody: !!(req.body && Object.keys(req.body).length),
    auth: maskBearer(req.headers.authorization),
  });
  next();
});

/* Helpers */
const isEmpty = (v) => v === undefined || v === null || v === '' || v === '-1';
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim(); 

const toInt = (v) => {
  if (isEmpty(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const startOfDay = (d) => (d ? new Date(new Date(d).setHours(0, 0, 0, 0)) : undefined);
const endOfDay   = (d) => (d ? new Date(new Date(d).setHours(23, 59, 59, 999)) : undefined);

function dbg(...args) {
  if (String(process.env.DEBUG_SQL).toLowerCase() === 'true') {
    console.log('[SQL]', ...args);
  }
}

/** WHERE dinámico con alias:
 *  c  = cabecera_oc
 *  cc = centro_costo
 *  eo = estado_oc
 *  co = companias
 */
function buildWhereParams(q) {
  const where = [];
  const params = [];

  // N° Solicitud (texto) — limpiar espacios
  if (!isEmpty(q.numeroSolicitud)) {
    const v = norm(q.numeroSolicitud);
    where.push(`c.numero_solicitud ILIKE $${params.length + 1}`);
    params.push(`%${v}%`);
  }

  // N° Orden (texto)
  if (!isEmpty(q.numeroOrden)) {
    const v = norm(q.numeroOrden);
    where.push(`c.numero_orden_compra ILIKE $${params.length + 1}`);
    params.push(`%${v}%`);
  }

  // Solicitante (texto)
  if (!isEmpty(q.solicitante)) {
    const v = norm(q.solicitante);
    where.push(`c.solicitante ILIKE $${params.length + 1}`);
    params.push(`%${v}%`);
  }

  // Proveedor nombre (texto)
  if (!isEmpty(q.proveedorNombre)) {
    const v = norm(q.proveedorNombre);
    where.push(`c.nombre_proveedor ILIKE $${params.length + 1}`);
    params.push(`%${v}%`);
  }

  // Compañía — comparar trimeado (evita fallar por espacios)
  if (!isEmpty(q.compania)) {
    where.push(`TRIM(c.compania) = TRIM($${params.length + 1})`);
    params.push(norm(q.compania));
  }

  // Estado (numérico)
  const estado = toInt(q.estado);
  if (estado !== undefined) {
    where.push(`c.estado_oc_id_esta = $${params.length + 1}::bigint`);
    params.push(estado);
  }

  // NIT proveedor → tratar como TEXTO (nada de bigint)
  if (!isEmpty(q.proveedorNit)) {
    where.push(`TRIM(c.nit_proveedor::text) = TRIM($${params.length + 1}::text)`);
    params.push(String(q.proveedorNit));
  }

  // Centro de costo: acepta ID (num) o CÓDIGO (texto)
  if (!isEmpty(q.centroCosto)) {
    const v = String(q.centroCosto);
    if (/^\d+$/.test(v)) {
      where.push(`c.centro_costo_id_ceco::text = $${params.length + 1}`);
      params.push(v);
    } else {
      where.push(`cc.codigo = $${params.length + 1}`);
      params.push(v);
    }
  }

  // Prioridad (G/I/N/P/U)
  if (!isEmpty(q.prioridad)) {
    where.push(`c.prioridad_orden = $${params.length + 1}`);
    params.push(q.prioridad);
  }

  // Fechas en fecha_orden_compra
  const onlyDate = (s) => (s ? String(s).slice(0, 10) : undefined);
  const fi = onlyDate(q.fechaInicio);
  const ff = onlyDate(q.fechaFin);

  if (fi) {
    where.push(`DATE(c.fecha_orden_compra) >= $${params.length + 1}::date`);
    params.push(fi);
  }
  if (ff) {
    where.push(`DATE(c.fecha_orden_compra) <= $${params.length + 1}::date`);
    params.push(ff);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
}

/**
 * GET /api/cabecera-oc/buscar
 * Requiere mínimo 2 filtros activos
 * Tip: agrega ?debug=1 para ver SQL y params en la respuesta.
 */
router.get('/buscar', async (req, res) => {
  try {
    const { page = 1, limit = 20, debug, ...filtros } = req.query;

    // 👇 LOG: filtros crudos y conteo de filtros activos
    const filtrosActivos = Object.values(filtros).filter(v => !isEmpty(v)).length;
    console.log('[cabecera-oc/buscar] filtros:', filtros, 'filtrosActivos:', filtrosActivos);

    if (filtrosActivos < 2) {
      console.warn('[cabecera-oc/buscar] <400> Menos de 2 filtros');
      return res.status(400).json({ message: 'Se deben aplicar al menos 2 filtros para realizar una búsqueda.' });
    }

    const p = Math.max(1, parseInt(String(page), 10) || 1);
    const l = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const offset = (p - 1) * l;

    const { whereSql, params } = buildWhereParams(filtros);

    // 👇 LOG: SQL dinámico y parámetros
    console.log('[cabecera-oc/buscar] whereSql:', whereSql);
    console.log('[cabecera-oc/buscar] params :', params);

    const fromJoins = `
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.centro_costo cc ON cc.id_ceco = c.centro_costo_id_ceco
      LEFT JOIN doa2.estado_oc   eo ON eo.id_esta = c.estado_oc_id_esta
      LEFT JOIN doa2.companias   co ON co.codigo_compania = c.compania
    `;

    const selectSql = `
      SELECT
        c.id_cabe, c.numero_solicitud, c.numero_orden_compra, c.fecha_orden_compra,
        c.nombre_proveedor, c.nit_proveedor, c.nombre_empresa, c.nit_empresa,
        c.moneda, c.total_neto, c.estado_oc_id_esta, c.centro_costo_id_ceco, c.compania,
        c.solicitante, c.prioridad_orden, c.fecha_creacion, c.estado_registro,
        eo.descripcion AS descripcion_estado,
        cc.descripcion AS descripcion_centro_costo,
        cc.codigo      AS codigo_centro_costo,
        co.nombre_compania AS descripcion_compania
      ${fromJoins}
      ${whereSql}
      ORDER BY c.fecha_orden_compra DESC NULLS LAST, c.id_cabe DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2};
    `;

    const countSql = `
      SELECT COUNT(*)::bigint AS total
      ${fromJoins}
      ${whereSql};
    `;

    const selectParams = [...params, l, offset];

    // 👇 LOG opcional extra (además de DEBUG_SQL)
    console.log('[cabecera-oc/buscar] COUNT SQL:', countSql);
    console.log('[cabecera-oc/buscar] SELECT SQL:', selectSql);
    console.log('[cabecera-oc/buscar] SELECT params:', selectParams);

    const [countResult, dataResult] = await Promise.all([
      pool.query(countSql, params),
      pool.query(selectSql, selectParams),
    ]);

    const total = Number(countResult.rows[0]?.total || 0);
    const totalPages = Math.ceil(total / l);

    console.log('[cabecera-oc/buscar] OK total:', total, 'page:', p, 'limit:', l, 'rows:', dataResult.rowCount);

    if (String(debug) === '1') {
      return res.json({
        data: dataResult.rows, total, page: p, limit: l, totalPages,
        _debug: { whereSql, params, selectSql, selectParams, countSql }
      });
    }

    res.json({ data: dataResult.rows, total, page: p, limit: l, totalPages });
  } catch (err) {
    console.error('[cabecera-oc/buscar] ERROR:', err?.message, err);
    res.status(500).json({ message: 'Error interno al buscar órdenes', detail: err?.message });
  }
});

/** GET /api/cabecera-oc/:id (con joins para descripciones Y FLUJO DE APROBACIÓN) */
/** GET /api/cabecera-oc/:id (cabecera + flujo de aprobación SOLO de la OC, sin fallback) */
/** GET /api/cabecera-oc/:id (cabecera + categoría + flujo de aprobación SOLO de la OC) */
// routes/cabecera-oc.js  (handler /:id)
// routes/cabecera-oc.js - Consulta corregida con historial_autorizacion
// routes/cabecera-oc.js - Consulta ajustada para el frontend
// GET /api/cabecera-oc/:id  — SOLO CAMPOS PARA EL MODAL (sin tocar nada más)
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'ID inválido' });

    const sql = `
      SELECT
        c.id_cabe, c.categoria_id_cate, c.estado_oc_id_esta,
        c.numero_solicitud, c.numero_orden_compra,
        c.fecha_sugerida, c.fecha_orden_compra,

        -- Proveedor (para llenar panel)
        c.nombre_proveedor, c.contacto_proveedor, c.direccion_proveedor,
        c.telefono_proveedor, c.ciudad_proveedor, c.departamento_proveedor,
        c.pais_proveedor, c.nit_proveedor, c.email_proveedor, c.fax_proveedor,

        -- Empresa / Compañía (panel empresa)
        c.nombre_empresa, c.direccion_empresa, c.telefono_empresa,
        c.ciudad_empresa, c.pais_empresa, c.nit_empresa, c.email_empresa, c.fax_empresa,

        -- Comerciales
        c.moneda, c.forma_de_pago, c.condiciones_de_pago,
        c.email_comprador, c.lugar_entrega,

        -- Observaciones
        c.observaciones, c.observacion_compras,

        -- Totales / flags
        c.total_bruto, c.descuento_global, c.sub_total, c.valor_iva, c.total_neto,
        c.requiere_poliza, c.requiere_contrato, c.poliza_gestionada, c.contrato_gestionada,

        -- Meta / auditoría
        c.compania, c.sistema, c.bodega, c.fecha_creacion,
        c.oper_creador, c.fecha_modificacion, c.oper_modifica, c.estado_registro,
        c.centro_costo_id_ceco, c.nit_compania,

        -- Solicitante y prioridad
        c.solicitante, c.email_solicitante, c.prioridad_orden,

        -- Envíos (por si los muestran)
        c.exitoso_envio_po, c.intento_envio_po, c.fecha_envio_po, c.envio_correo,
        c."version", c.id_compania,

        -- Descripciones para UI
        eo.descripcion     AS descripcion_estado,
        cc.descripcion     AS descripcion_centro_costo,
        cc.codigo          AS codigo_centro_costo,
        co.nombre_compania AS descripcion_compania
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.centro_costo cc ON cc.id_ceco = c.centro_costo_id_ceco
      LEFT JOIN doa2.estado_oc   eo ON eo.id_esta = c.estado_oc_id_esta
      LEFT JOIN doa2.companias   co ON co.codigo_compania = TRIM(c.compania)
      WHERE c.id_cabe = $1::bigint
      LIMIT 1;
    `;
    const r = await pool.query(sql, [id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Orden no encontrada' });

    res.json(r.rows[0]);
  } catch (err) {
    console.error('[cabecera-oc/:id] ERROR:', err?.message, err);
    res.status(500).json({ message: 'Error interno', detail: err?.message });
  }
});




export default router;