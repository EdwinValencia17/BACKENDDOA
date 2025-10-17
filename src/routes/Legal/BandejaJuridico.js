// src/routes/Legal/BandejaJuridico.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();

/* ========================= Helpers ========================= */
const isEmpty = v => v === undefined || v === null || v === '' || v === '-1';
const norm = s => String(s ?? '').replace(/\s+/g,' ').trim();
const day  = d => (d && `${d}`.slice(0,10)) || null;

/* ==================== Logging ==================== */
const mask = (h='') => { if (!h) return null; const [t,k] = String(h).split(' '); return k ? `${t} ${k.slice(0,8)}…${k.slice(-4)}` : h; };
router.use((req,_res,next)=>{
  console.log('[BandejaJuridico]', req.method, req.originalUrl, {
    q: req.query, body: req.body && Object.keys(req.body).length ? 'yes' : 'no', auth: mask(req.headers.authorization)
  });
  next();
});

/* ==================== Estados cache ==================== */
let ESTADO_CACHE = null;
async function resolveEstadoIds(client = null) {
  if (ESTADO_CACHE) return ESTADO_CACHE;
  const cx = client || pool;
  const { rows } = await cx.query(`
    SELECT id_esta, UPPER(TRIM(descripcion)) AS d
    FROM doa2.estado_oc
    WHERE estado_registro='A'
  `);
  const m = new Map(rows.map(r => [r.d, r.id_esta]));
  ESTADO_CACHE = {
    INICIADO: m.get('INICIADO') || null,
    APROBADO: m.get('APROBADO') || null,
    RECHAZADO: m.get('RECHAZADO') || null,
    ANULADO: m.get('ANULADO') || null,
    SE_NECESITAN_MAS_DATOS: m.get('SE NECESITAN MAS DATOS') || null,
    CANCELADO_CERRADO: m.get('CANCELADO/CERRADO') || null,
  };
  return ESTADO_CACHE;
}

/* ============== WHERE dinámico para CABECERA (c0) ============== */
function buildWhereCabecera(q) {
  const { proveedor, numeroSolicitud, numeroOc, compania, centroCosto, prioridad, fechaInicio, fechaFin } = q;

  const w = [];
  const v = [];
  const ph = (val) => { v.push(val); return `$${v.length}` };

  // Solo activas y que requieren contrato
  w.push(`(c0.estado_registro='A')`);
  w.push(`(COALESCE(c0.requiere_contrato,'N')='S')`);

  if (!isEmpty(numeroSolicitud)) w.push(`c0.numero_solicitud ILIKE ${ph(`%${norm(numeroSolicitud)}%`)}`);
  if (!isEmpty(numeroOc))        w.push(`c0.numero_orden_compra ILIKE ${ph(`%${norm(numeroOc)}%`)}`);
  if (!isEmpty(compania))        w.push(`TRIM(c0.compania) = TRIM(${ph(norm(compania))})`);
  if (!isEmpty(proveedor))       w.push(`TRIM(c0.nit_proveedor::text) = TRIM(${ph(String(proveedor))}::text)`);
  if (!isEmpty(prioridad))       w.push(`UPPER(c0.prioridad_orden) = UPPER(${ph(prioridad)})`);
  if (!isEmpty(centroCosto))     w.push(`TRIM(cc.codigo) = TRIM(${ph(norm(centroCosto))})`);

  const fi = day(fechaInicio);
  const ff = day(fechaFin);
  if (fi) { const d1=ph(fi), d2=ph(fi); w.push(`c0.fecha_orden_compra >= ${d1}::date AND c0.fecha_orden_compra < (${d2}::date + INTERVAL '1 day')`); }
  if (ff) { const d2=ph(ff);            w.push(`c0.fecha_orden_compra < (${d2}::date + INTERVAL '1 day')`); }

  return { whereCab: w.length ? `WHERE ${w.join(' AND ')}` : '', valuesCab: v };
}

/* ========================= LISTA (OC APROBADAS + REQUIERE CONTRATO) ========================= */
router.get('/ordenes', async (req, res) => {
  const {
    proveedor='-1', numeroSolicitud='-1', numeroOc='-1', compania='-1',
    centroCosto='-1', prioridad='-1', fechaInicio, fechaFin,
    page=1, pageSize=20, sortField='c0.fecha_orden_compra', sortOrder='DESC',
  } = req.query;

  try {
    const pageNum = Math.max(parseInt(page,10)||1, 1);
    const sizeNum = Math.max(parseInt(pageSize,10)||20, 1);
    const offset  = (pageNum - 1) * sizeNum;

    const sortable = {
      'c0.fecha_orden_compra':'c0.fecha_orden_compra',
      'c0.numero_orden_compra':'c0.numero_orden_compra',
      'c0.numero_solicitud':'c0.numero_solicitud',
      'cc.codigo':'cc.codigo',
      'c0.compania':'c0.compania',
      'c0.prioridad_orden':'c0.prioridad_orden',
      'c0.nit_proveedor':'c0.nit_proveedor',
      'c0.total_neto':'c0.total_neto',
    };
    const sf = sortable[sortField] || 'c0.fecha_orden_compra';
    const so = String(sortOrder).toUpperCase()==='ASC' ? 'ASC' : 'DESC';

    const { whereCab, valuesCab } = buildWhereCabecera({
      proveedor, numeroSolicitud, numeroOc, compania, centroCosto, prioridad, fechaInicio, fechaFin
    });
    const EST = await resolveEstadoIds();

    // Solo OCs con al menos una marca APROBADA
    const approvedJoin = `
      JOIN doa2.lista_autorizaccion la
        ON la.cabecera_oc_id_cabe = c0.id_cabe
       AND la.estado_registro='A'
       AND la.estado_oc_id_esta = ${EST.APROBADO}
    `;

    const from = `
      FROM doa2.cabecera_oc c0
      ${approvedJoin}
      LEFT JOIN doa2.centro_costo cc ON cc.id_ceco = c0.centro_costo_id_ceco
      LEFT JOIN doa2.companias co    ON co.codigo_compania = TRIM(c0.compania)
      LEFT JOIN doa2.moneda m        ON m.codigo = c0.moneda
      ${whereCab}
    `;

    const descripcionSub = `
     (SELECT d.descripcion_referencia
        FROM doa2.detalle_oc d
       WHERE d.cabecera_oc_id_cabe = c0.id_cabe
         AND d.estado_registro='A'
       ORDER BY d.id_deta
       LIMIT 1)
    `;

    const sel = `
      SELECT
        c0.id_cabe                         AS "idCabecera",
        c0.numero_solicitud                AS "numeroSolicitud",
        c0.numero_orden_compra             AS "numOrden",
        c0.fecha_orden_compra              AS "fechaOrden",
        to_char(c0.fecha_orden_compra,'YYYY-MM-DD HH24:MI:SS') AS "fechaOrdenString",
        TRIM(cc.codigo)                    AS "centroCosto",
        TRIM(c0.compania)                  AS "compania",
        COALESCE(co.nombre_compania,c0.nombre_empresa) AS "empresa",
        c0.nombre_proveedor                AS "descProveedor",
        c0.nit_proveedor::text             AS "nitProveedor",
        ${descripcionSub}                  AS "descripcion",
        c0.observaciones                   AS "observaciones",
        c0.total_neto                      AS "totalNeto",
        CASE UPPER(c0.prioridad_orden)
          WHEN 'G' THEN 'URGENTE'
          WHEN 'I' THEN 'INVENTARIO'
          WHEN 'N' THEN 'NORMAL'
          WHEN 'P' THEN 'PREVENTIVO'
          WHEN 'U' THEN 'PRIORITARIO'
          ELSE COALESCE(c0.prioridad_orden,'')
        END                                AS "prioridadOrdenStr",
        c0.prioridad_orden                 AS "prioridadOrden",
        c0.moneda                          AS "moneda"
      ${from}
      GROUP BY c0.id_cabe, cc.codigo, co.nombre_compania
      ORDER BY ${sf} ${so}
      LIMIT $${valuesCab.length + 1} OFFSET $${valuesCab.length + 2}
    `;

    const cnt = `SELECT COUNT(DISTINCT c0.id_cabe)::int AS total ${from}`;
    const paramsCnt = [...valuesCab];
    const paramsSel = [...valuesCab, sizeNum, offset];

    const [cRes, dRes] = await Promise.all([
      pool.query(cnt, paramsCnt),
      pool.query(sel, paramsSel),
    ]);

    res.json({
      page: pageNum,
      pageSize: sizeNum,
      total: cRes.rows[0]?.total ?? 0,
      data: (dRes.rows || []).map(r => ({
        ...r,
        totalNetoString: (Number(r.totalNeto) || 0).toLocaleString('es-CO', { minimumFractionDigits: 2 }),
      })),
    });
  } catch (e) {
    console.error('GET /legal/ordenes:', e);
    res.status(500).json({ error: 'Error consultando órdenes' });
  }
});

/* ===================== DETALLE (CABECERA + DETALLE_OC) ===================== */
router.get('/ordenes/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

  try {
    const cab = await pool.query(`
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
      FROM doa2.cabecera_oc c
      LEFT JOIN doa2.centro_costo cc ON cc.id_ceco = c.centro_costo_id_ceco
      WHERE c.id_cabe = $1::bigint
      LIMIT 1
    `,[id]);

    if (!cab.rows.length) return res.status(404).json({ error: 'OC no encontrada' });
    const head = cab.rows[0];

    const det = await pool.query(`
      SELECT
        d.id_deta                        AS "idDetalle",
        d.cabecera_oc_id_cabe           AS "idCabecera",
        d.referencia                     AS "referencia",
        d.descripcion_referencia         AS "descripcion",
        d.unidad_medida                  AS "unidadMedida",
        d.fecha_entrega                  AS "fechaEntrega",
        d.cantidad::numeric              AS "cantidad",
        d.valor_unidad::numeric          AS "valorUnitario",
        d.descuento::numeric             AS "descuentoRef",
        d.iva::numeric                   AS "ivaRef",
        d.valor_descuento::numeric       AS "valorDescuento",
        d.valor_iva::numeric             AS "valorIva",
        d.valor_sin_iva_descuento::numeric  AS "valorSinIvaDesc",
        d.valor_total::numeric           AS "valorTotal",
        d.estado_registro                AS "estadoRegistro"
      FROM doa2.detalle_oc d
      WHERE d.cabecera_oc_id_cabe = $1::bigint
      ORDER BY d.id_deta
    `,[id]);

    let totalBruto=0, dctoGlobal=0, valorIva=0, subTotal=0, totalNeto=0;
    for (const r of det.rows) {
      const c = Number(r.cantidad || 0), vu = Number(r.valorUnitario || 0);
      const dP = Number(r.descuentoRef || 0) / 100, iP = Number(r.ivaRef || 0) / 100;
      const bruto = vu*c, dcto = vu*dP*c;
      const sinIvaDesc = bruto - dcto, ivaVal = sinIvaDesc*iP, total = sinIvaDesc + ivaVal;
      totalBruto += bruto; dctoGlobal += dcto; valorIva += ivaVal; subTotal += sinIvaDesc; totalNeto += total;
    }

    res.json({ cabecera: head, detalle: det.rows, totales: { totalBruto, dctoGlobal, subTotal, valorIva, totalNeto } });
  } catch (e) {
    console.error('GET /legal/ordenes/:id', e);
    res.status(500).json({ error: 'Error consultando la OC' });
  }
});

/* ===================== CATÁLOGOS PARA FILTROS ===================== */
// Centros de costo (desde tabla maestra)
router.get('/filtros/centros-costo', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT TRIM(c.codigo) AS value,
             CONCAT(TRIM(c.codigo),' - ', COALESCE(NULLIF(TRIM(c.descripcion),''), 'Sin descripción')) AS label
      FROM doa2.centro_costo c
      WHERE c.estado_registro='A'
      ORDER BY TRIM(c.codigo)
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /legal/filtros/centros-costo', e);
    res.status(500).json({ error: 'No fue posible cargar centros de costo' });
  }
});

// Compañías (desde tabla maestra)
router.get('/filtros/companias', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT TRIM(c.codigo_compania) AS value,
             COALESCE(NULLIF(TRIM(c.nombre_compania),''), TRIM(c.codigo_compania)) AS label
      FROM doa2.companias c
      WHERE c.estado_registro='A'
      ORDER BY label
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /legal/filtros/companias', e);
    res.status(500).json({ error: 'No fue posible cargar compañías' });
  }
});

// Proveedores (para el modal de selección)
router.get('/proveedores', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT
        TRIM(c0.nit_proveedor::text) AS value,
        COALESCE(NULLIF(TRIM(c0.nombre_proveedor),''), TRIM(c0.nit_proveedor::text)) AS label
      FROM doa2.cabecera_oc c0
      WHERE c0.estado_registro='A'
      ORDER BY label ASC
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /legal/proveedores', e);
    res.status(500).json({ error: 'No fue posible cargar proveedores' });
  }
});

export default router;
