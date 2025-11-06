// services/qad-po.js
// Lógica de integración QAD (JSON + SOAP), mapeos y persistencia (OPTIMIZADA)

import pool from '../../config/db.js'

/* ========================= Flags de debug ========================= */
const DEBUG = false // pon en true si quieres ver logs verbosos

/* ========================= Utils ========================= */
const isEmpty = v => v === undefined || v === null || v === '' || v === '-1'
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const s = (v) => (v === undefined || v === null) ? null : (String(v).trim() || null)

const toNum = (x, d = 0) => {
  const n = Number(x)
  return Number.isFinite(n) ? n : d
}

/* ======== Parser de fechas QAD (MM/dd/yy) rápido y robusto ======== */
function parseQADDate(dateStr) {
  const raw = String(dateStr || '').trim()
  if (!raw || raw === ' ') return null
  const [m, d, y] = raw.split('/')
  if (!m || !d || !y) return null
  const fullYear = y.length === 2 ? `20${y}` : y
  // usar Date ISO evita reparseos extra
  return new Date(`${fullYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
}

/* ========================= Parametría (con cache) ========================= */
// Cache in-memory (TTL sencillo)
const paramCache = new Map()
function cacheGet(key) {
  const hit = paramCache.get(key)
  if (!hit) return null
  if (hit.exp && Date.now() > hit.exp) { paramCache.delete(key); return null }
  return hit.val
}
function cacheSet(key, val, ttlMs = 5 * 60 * 1000) { // 5 min por defecto
  paramCache.set(key, { val, exp: Date.now() + ttlMs })
}

async function getParametro(k, ttlMs = 5 * 60 * 1000) {
  const cached = cacheGet(`param:${k}`)
  if (cached !== null) return cached
  const { rows } = await pool.query(
    `SELECT valor FROM doa2.parametros WHERE parametro=$1 AND estado_registro='A' LIMIT 1`,
    [k]
  )
  const out = rows[0]?.valor?.trim() || null
  cacheSet(`param:${k}`, out, ttlMs)
  return out
}

async function getQADConfig() {
  let url  = await getParametro('QAD_OC_URL', 10 * 60 * 1000)
  const port = await getParametro('QAD_OC_PORT', 10 * 60 * 1000)
  let path = await getParametro('QAD_OC_PATH', 10 * 60 * 1000)

  if (DEBUG) console.log('🔧 Parámetros QAD obtenidos:', { url, port, path })
  if (!url || !port || !path) {
    const faltan = [!url && 'QAD_OC_URL', !port && 'QAD_OC_PORT', !path && 'QAD_OC_PATH']
      .filter(Boolean).join(', ')
    throw new Error(`Faltan parámetros QAD: ${faltan}`)
  }
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`
  if (!path.startsWith('/')) path = `/${path}`

  const base = `${url}:${port}${path}` // http(s)://host:9091/ws/simple/queryPurchaseOrders
  if (DEBUG) console.log('🔗 URL QAD construida:', base)
  return { base, url, port, path }
}

async function getQADDomains() {
  const cached = cacheGet('qad:domains')
  if (cached) return cached
  const raw = (await getParametro('QAD_OC_DOMAINS', 10 * 60 * 1000)) || '15,25'
  const domains = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (DEBUG) console.log('🌐 Dominios QAD:', domains)
  cacheSet('qad:domains', domains, 10 * 60 * 1000)
  return domains
}

async function getSoapUrl() {
  const soapUrl = await getParametro('URL_SOAP_UPDATEPO', 10 * 60 * 1000)
  if (!soapUrl) throw new Error('Falta parámetro URL_SOAP_UPDATEPO')
  return soapUrl
}

async function mustRequireSite() {
  const v = (await getParametro('SYNC_REQUIRE_SITE', 5 * 60 * 1000)) || 'N'
  return String(v).trim().toUpperCase() === 'S'
}

/* ========================= Helpers de QAD (claves “raras”) ========================= */
// Normalizador de key
const nk = k => String(k).replace(/[^a-z0-9]/gi, '').toLowerCase()

// Mapeo “flex” por objeto -> O(1)
function makeFlexGetter(obj) {
  if (!obj || typeof obj !== 'object') return () => undefined
  const map = new Map()
  for (const k of Object.keys(obj)) map.set(nk(k), k)
  return (...names) => {
    for (const want of names) {
      const real = map.get(nk(want))
      if (real) return obj[real]
    }
    return undefined
  }
}

// Compat: por si en algún sitio aún lo usan
function getFieldFlex(obj, ...names) {
  const F = makeFlexGetter(obj)
  return F(...names)
}

function hasValidData(po) {
  if (!po) return false
  for (const k of Object.keys(po)) {
    const v = po[k]
    if (typeof v === 'string') {
      if (v.trim() !== '') return true
    } else if (v != null) return true
  }
  return false
}

/* ========================= QAD (JSON) ========================= */
// ⚠️ Por instrucción: mandar COM_NMRO según tu backend (se deja tal cual)
function requestMapperQAD(domain) {
  return {
    PURCHASE_ORDERS_REQUEST: {
      TransactionID: 'YYYYMMDDHHMMSSFFFFFF',
      TargetApp: 'RUP',
      Interface: 'PURCHASE_ORDERS-RUP',
      Domain: String(domain),
      SelectionCriteria: { COM_NMRO: "PO59767 " }
    }
  }
}

async function fetchQADPOsPOST({ base, domain, signal }) {
  if (DEBUG) {
    console.log('🔧 URL completa:', base)
    console.log('🔧 Domain:', domain)
  }

  const payload = requestMapperQAD(domain)
  if (DEBUG) console.log('📤 Payload completo:', JSON.stringify(payload, null, 2))

  // Usar el signal que viene de arriba (AbortSignal.timeout) como preferencia
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'DOA-NodeJS/1.0'
    },
    body: JSON.stringify(payload),
    signal
  })

  const text = await res.text()
  if (DEBUG) {
    console.log('📥 Status:', res.status)
    console.log('📥 Response body:', text)
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

function isEmptyQADResponse(data) {
  if (!data) return true
  const resp = data.PURCHASE_ORDERS_RESPONSE || data.purchaseOrderResponse
  if (!resp) return true
  if ((resp.Result || resp.result) === 'error') return true
  const list = resp.OutboundData || resp.outboundData || []
  if (!Array.isArray(list) || list.length === 0) return true
  for (const it of list) {
    const po = it.PURCHASE_ORDER || it.purchaseOrder
    if (po && hasValidData(po)) return false
  }
  return true
}

// Devuelve [{ header, lines }]
function extractValidQADData(data) {
  if (!data || isEmptyQADResponse(data)) return []
  const resp = data.PURCHASE_ORDERS_RESPONSE || data.purchaseOrderResponse
  const list = resp?.OutboundData || resp?.outboundData || []
  const out = []
  for (const item of list) {
    const poRaw = item.PURCHASE_ORDER || item.purchaseOrder
    if (!poRaw || !hasValidData(poRaw)) continue

    // búsqueda flexible rápida (con makeFlexGetter)
    const F = makeFlexGetter(poRaw)
    let lines = F('purchaseOrderItem', 'PURCHASE_ORDER_ITEM', 'poItem', 'items')
    if (!Array.isArray(lines) || !lines.length) {
      const Fi = makeFlexGetter(item)
      lines = Fi('purchaseOrderItem', 'PURCHASE_ORDER_ITEM')
    }
    if (!Array.isArray(lines)) lines = []

    out.push({ header: poRaw, lines })
  }
  return out
}

/* ========================= SOAP UpdatePo ========================= */
function buildUpdatePoEnvelope({ domain, po, estado }) {
  const st = String(estado || '').trim()
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns="urn:schemas-qad-com:xml-services"
  xmlns:qcom="urn:schemas-qad-com:xml-services:common"
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsa="http://www.w3.org/2005/08/addressing">
  <soapenv:Header>
    <wsa:Action/>
    <wsa:To>urn:services-qad-com:INTEGRATION</wsa:To>
    <wsa:MessageID>urn:services-qad-com::INTEGRATION</wsa:MessageID>
    <wsa:ReferenceParameters>
      <qcom:suppressResponseDetail>false</qcom:suppressResponseDetail>
    </wsa:ReferenceParameters>
    <wsa:ReplyTo><wsa:Address>urn:services-qad-com:</wsa:Address></wsa:ReplyTo>
  </soapenv:Header>
  <soapenv:Body>
    <UpdatePo>
      <qcom:dsSessionContext>
        <qcom:ttContext><qcom:propertyQualifier>QAD</qcom:propertyQualifier><qcom:propertyName>domain</qcom:propertyName><qcom:propertyValue/></qcom:ttContext>
        <qcom:ttContext><qcom:propertyQualifier>QAD</qcom:propertyQualifier><qcom:propertyName>scopeTransaction</qcom:propertyName><qcom:propertyValue>false</qcom:propertyValue></qcom:ttContext>
        <qcom:ttContext><qcom:propertyQualifier>QAD</qcom:propertyQualifier><qcom:propertyName>version</qcom:propertyName><qcom:propertyValue>CUST_1</qcom:propertyValue></qcom:ttContext>
      </qcom:dsSessionContext>
      <dsGetdataInput>
        <tt-criterio>
          <tt-dominio>${domain}</tt-dominio>
          <tt-numpo>${po}</tt-numpo>
          <tt-estado>${st}</tt-estado>
          <tt-fecha></tt-fecha>
          <tt-desestado></tt-desestado>
        </tt-criterio>
      </dsGetdataInput>
    </UpdatePo>
  </soapenv:Body>
</soapenv:Envelope>`
}

async function callUpdatePoSOAP({ domain, po, estado }) {
  const soapUrl = await getSoapUrl()
  const envelope = buildUpdatePoEnvelope({ domain, po, estado })
  if (DEBUG) {
    console.log('🔷 SOAP URL:', soapUrl)
    console.log('📝 SOAP Envelope:\n', envelope)
  }

  const res = await fetch(soapUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: envelope,
    signal: AbortSignal.timeout(60_000)
  })

  const text = await res.text().catch(() => '')
  if (DEBUG) {
    console.log('🔶 SOAP Status:', res.status)
    console.log('🔶 SOAP Body:\n', text)
  }

  if (!res.ok) throw new Error(`SOAP ${res.status}: ${text.slice(0, 500)}`)
  const ok = /Aceptad[oa]|Success|<faultcode>\s*0/i.test(text)
  return { ok, status: res.status, body: text }
}

/* ========================= Mapeo QAD → Pendiente ========================= */
function getCompaniaByDomain(domain) {
  return String(domain) === '15' ? 'MP' : 'BM'
}
function getEstadoFromFlag(flag) {
  const f = String(flag || '').trim().toUpperCase()
  if (f === 'C' || f === 'X') return 6
  return 0
}

function mapQADItemToPendiente(po = {}, domain, fallbackBodegaFromLines = null) {
  const F = makeFlexGetter(po)
  const numero = s(F('COMNMRO','COM_NMRO'))

  return {
    numero_orden_compra: numero,
    numero_solicitud:    s(F('COMSOLI','COM_SOLI')),
    nombre_proveedor:    s(F('PRODESC','PRO_DESC')),
    nit_proveedor:       s(F('PROCODI','PRO_CODI')),

    // 👇 correos/contactos con claves que traen punto
    contacto_proveedor:  s(F('NFUNDESC','N.FUN_DESC')),
    correo_solicitante:  s(F('NFUNDELE','N.FUN_DELE','NFUNDELEREQ','N.FUN_DELE_REQ')),
    usuario_creador:     s(F('USRCREA','USR_CREA','USRCREAREQ','USR_CREA_REQ')),

    fecha_orden_compra:  F('COMFECH','COM_FECH') ? parseQADDate(F('COMFECH','COM_FECH')) : null,
    fecha_sugerida:      F('COMFENT','COM_FENT') ? parseQADDate(F('COMFENT','COM_FENT')) : null,

    total_bruto: toNum(F('COMTOTALBRUTO','COM_TOTAL_BRUTO')),
    total_neto:  toNum(F('COMTOTALNETO','COM_TOTAL_NETO')),
    moneda:      s(F('MONEDA')) || 'COP',
    forma_de_pago: s(F('TGPCODI','TGP_CODI')) || null,

    bodega:        s(F('SITEENTREGA','SITE_ENTREGA')) || (fallbackBodegaFromLines || null),
    lugar_entrega: s(F('SHIPVIA')),

    observaciones: s(F('COMOBSE','COM_OBSE')),

    centrocosto:   s(F('COMCECO','COM_CECO','CC')),
    solicitante:   s(F('COMSOLI','COM_SOLI')),

    sistema:  String(domain),
    compania: getCompaniaByDomain(domain),

    estado_oc_id_esta: getEstadoFromFlag(F('COMFLAG','COM_FLAG')),
    comFlag: (s(F('COMFLAG','COM_FLAG')) || '').toUpperCase() || null
  }
}

function asPct(val) {
  const n = Number(val ?? 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  if (n <= 1) return n * 100
  if (n <= 100) return n
  return 0
}

function isNear(a, b, eps = 1) {
  const na = Number(a ?? 0), nb = Number(b ?? 0)
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false
  return Math.abs(na - nb) <= eps
}

function mapQADLineToDetalle(line = {}) {
  const F = makeFlexGetter(line)
  const ref  = s(F('REPCODI','rEPCODI','ITEM','CODIGO'))
  const desc = s(F('REPDESC','rEPDESC','DESCRIPCION'))
  const um   = s(F('REPUNID','rEPUNID','UM','UNIDAD_MEDIDA'))

  const fEntL = F('COMFENTITEM','cOMFENTITEM','FECHA_ENTREGA')
  const fechaEntrega = fEntL ? parseQADDate(fEntL) : null

  const cantidad    = toNum(F('COMCORD','cOMCORD','CANTIDAD'))
  const valorUnidad = toNum(F('COMVUNI','cOMVUNI','VALOR_UNIDAD','PRECIO'))

  const descPct = asPct(F('COMVDESC','cOMVDESC','DESCUENTO'))
  const ivaPct  = asPct(F('COMPIVA','cOMPIVA','IVA'))

  const bruto = valorUnidad * cantidad
  let valorDescuento = (descPct/100) * bruto

  // Base sin usar VREA
  let sinIvaDesc = bruto - valorDescuento

  // Tomar VREA si es coherente (evita "inventar" descuentos)
  const vreaQAD = toNum(F('COMVREA','cOMVREA','VALOR_SIN_IVA_DESCUENTO'))
  if (vreaQAD > 0 && isNear(vreaQAD, sinIvaDesc, 1)) {
    sinIvaDesc = vreaQAD
    valorDescuento = Math.max(0, bruto - sinIvaDesc)
  }

  // IVA: usar cálculo, o el explícito si viene positivo
  let valorIva = (ivaPct/100) * sinIvaDesc
  const ivaQAD = toNum(F('COMVIVA','cOMVIVA','VALOR_IVA'))
  if (ivaQAD > 0) valorIva = ivaQAD

  const valorTotal = sinIvaDesc + valorIva

  return {
    referencia: ref,
    descripcion_referencia: desc,
    unidad_medida: um,
    fecha_entrega: fechaEntrega,
    cantidad,
    valor_unidad: valorUnidad,
    descuento: descPct,
    iva: ivaPct,
    valor_descuento: valorDescuento,
    valor_iva: valorIva,
    valor_sin_iva_descuento: sinIvaDesc,
    valor_total: valorTotal,
    _bodega_linea: s(F('BODCODI','bODCODI'))
  }
}

/* ========================= Persistencia (upsert) ========================= */
async function upsertPendienteFromQAD(client, it) {
  const estado = (it.comFlag === 'C' || it.comFlag === 'X') ? 6 : (Number(it.estado_oc_id_esta) || 0)

  const sel = await client.query(
    `SELECT id_cabepen FROM doa2.cabecera_oc_pendientes
      WHERE TRIM(COALESCE(numero_orden_compra,'')) = TRIM($1)
        AND TRIM(COALESCE(sistema,'')) = TRIM($2)
        AND estado_registro = 'A' LIMIT 1`,
    [it.numero_orden_compra || '', it.sistema || '']
  )

  if (sel.rows.length) {
    const id = sel.rows[0].id_cabepen
    await client.query(
      `UPDATE doa2.cabecera_oc_pendientes
         SET numero_solicitud = COALESCE($2, numero_solicitud),
             nombre_proveedor = COALESCE($3, nombre_proveedor),
             nit_proveedor = COALESCE($4, nit_proveedor),
             contacto_proveedor = COALESCE($5, contacto_proveedor),
             correo_solicitante = COALESCE($6, correo_solicitante),
             usuario_creador = COALESCE($7, usuario_creador),
             fecha_orden_compra = COALESCE($8, fecha_orden_compra),
             fecha_sugerida = COALESCE($9, fecha_sugerida),
             total_bruto = COALESCE($10, total_bruto),
             total_neto = COALESCE($11, total_neto),
             moneda = COALESCE($12, moneda),
             forma_de_pago = COALESCE($13, forma_de_pago),
             bodega = COALESCE($14, bodega),
             lugar_entrega = COALESCE($15, lugar_entrega),
             observaciones = COALESCE($16, observaciones),
             centrocosto = COALESCE($17, centrocosto),
             solicitante = COALESCE($18, solicitante),
             compania = COALESCE($19, compania),
             estado_oc_id_esta = $20,
             fecha_modificacion = NOW(),
             oper_modifica = 'WS_QAD'
       WHERE id_cabepen = $1::bigint`,
      [
        id,
        it.numero_solicitud,
        it.nombre_proveedor,
        it.nit_proveedor,
        it.contacto_proveedor,
        it.correo_solicitante,
        it.usuario_creador,
        it.fecha_orden_compra,
        it.fecha_sugerida,
        it.total_bruto,
        it.total_neto,
        it.moneda,
        it.forma_de_pago,
        it.bodega,
        it.lugar_entrega,
        it.observaciones,
        it.centrocosto,
        it.solicitante,
        it.compania,
        estado
      ]
    )
    return { action: 'update', id }
  } else {
    const ins = await client.query(
      `INSERT INTO doa2.cabecera_oc_pendientes
        (numero_solicitud, numero_orden_compra, nombre_proveedor, nit_proveedor,
         contacto_proveedor, correo_solicitante, usuario_creador,
         fecha_orden_compra, fecha_sugerida, total_bruto, total_neto,
         moneda, forma_de_pago, bodega, lugar_entrega, observaciones,
         centrocosto, solicitante, sistema, compania, estado_oc_id_esta,
         fecha_creacion, oper_creador, estado_registro, prioridad_orden)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, NOW()),$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
         NOW(),'WS_QAD','A','N')
       RETURNING id_cabepen`,
      [
        it.numero_solicitud,
        it.numero_orden_compra,
        it.nombre_proveedor,
        it.nit_proveedor,
        it.contacto_proveedor,
        it.correo_solicitante,
        it.usuario_creador,
        it.fecha_orden_compra, // si viene null: NOW()
        it.fecha_sugerida,
        it.total_bruto,
        it.total_neto,
        it.moneda,
        it.forma_de_pago,
        it.bodega,
        it.lugar_entrega,
        it.observaciones,
        it.centrocosto,
        it.solicitante,
        it.sistema,
        it.compania,
        estado
      ]
    )
    return { action: 'insert', id: ins.rows[0].id_cabepen }
  }
}

/* ======== Insert de detalle en batch (un solo INSERT) ======== */
async function replaceDetallePendiente(client, idCabepen, detalle = [], usuario = 'WS_QAD') {
  await client.query(`DELETE FROM doa2.detalle_oc_pendiente WHERE id_cabepen = $1`, [idCabepen])
  if (!Array.isArray(detalle) || !detalle.length) return 0

  const cols = [
    'id_cabepen','referencia','descripcion_referencia','unidad_medida','fecha_entrega',
    'cantidad','valor_unidad','descuento','iva','valor_descuento','valor_iva',
    'valor_sin_iva_descuento','valor_total','estado_registro','fecha_creacion','oper_creador'
  ]

  // Construimos VALUES multi-fila con parámetros numerados
  const values = []
  const params = []
  let i = 1
  const now = new Date()

  for (const d of detalle) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, 'A', NOW(), $${i++})`)
    params.push(
      idCabepen,
      d.referencia ?? null,
      d.descripcion_referencia ?? null,
      d.unidad_medida ?? null,
      d.fecha_entrega ?? null,
      toNum(d.cantidad, 0),
      toNum(d.valor_unidad, 0),
      toNum(d.descuento, 0),
      toNum(d.iva, 0),
      toNum(d.valor_descuento, 0),
      toNum(d.valor_iva, 0),
      toNum(d.valor_sin_iva_descuento, 0),
      toNum(d.valor_total, 0),
      usuario
    )
  }

  const sql = `
    INSERT INTO doa2.detalle_oc_pendiente
      (${cols.join(',')})
    VALUES
      ${values.join(',')}
  `
  await client.query(sql, params)
  return detalle.length
}

/* ========================= Orquestador de Sync ========================= */
export async function actualizarOrdenesComprasQAD() {
  // Un solo AbortSignal global para todos los fetch
  const networkSignal = AbortSignal.timeout(120_000)
  let client
  try {
    const [cfg, dominios, requireSite] = await Promise.all([
      getQADConfig(),
      getQADDomains(),
      mustRequireSite()
    ])

    // 1) Descarga en paralelo (red)
    const payloads = await Promise.allSettled(
      dominios.map(d => fetchQADPOsPOST({ base: cfg.base, domain: d, signal: networkSignal })
        .then(p => ({ domain: d, payload: p }))
      )
    )

    client = await pool.connect()
    await client.query('BEGIN')
    // timeouts cortos locales de la transacción
    await client.query(`SET LOCAL statement_timeout='90s'; SET LOCAL lock_timeout='10s';`)

    let totalRecibidos = 0, inserts = 0, updates = 0, errors = 0
    const domains = {}

    // 2) Procesamiento en DB (secuencial para coherencia)
    for (let idx = 0; idx < payloads.length; idx++) {
      const r = payloads[idx]
      const d = dominios[idx] // dominio correspondiente
      if (r.status !== 'fulfilled') {
        const msg = r.reason?.message || String(r.reason || 'Error desconocido')
        console.error(`❌ [QAD] Error dominio ${d}:`, msg)
        domains[d] = { error: msg }
        errors++
        continue
      }

      const { payload } = r.value
      const lista = extractValidQADData(payload)
      if (DEBUG) console.log(`📊 Dominio ${d}: ${lista.length} OCs válidas recibidas`)
      domains[d] = { recibidos: lista.length }
      totalRecibidos += lista.length

      for (const { header, lines } of lista) {
        try {
          const mappedLines = (Array.isArray(lines) ? lines : []).map(mapQADLineToDetalle)
          const fallbackSite = mappedLines.find(x => x._bodega_linea)?.['_bodega_linea'] || null
          const it = mapQADItemToPendiente(header, d, fallbackSite)
          if (!it.numero_orden_compra) { if (DEBUG) console.warn('⚠️ OC sin número'); continue }

          const bodegaFinal = it.bodega && String(it.bodega).trim() !== '' ? it.bodega : null
          if (requireSite && !bodegaFinal) {
            if (DEBUG) console.warn(`⚠️ OC ${it.numero_orden_compra} d${d} sin SITE (config exige site)`)
            continue
          }

          const rCab = await upsertPendienteFromQAD(client, it)
          if (rCab.action === 'insert') inserts++; else updates++;
          if (DEBUG) console.log(`✅ ${rCab.action.toUpperCase()} OC ${it.numero_orden_compra} d${d}`)

          const inserted = await replaceDetallePendiente(client, rCab.id, mappedLines, 'WS_QAD')
          if (DEBUG) console.log(`   ↳ Detalle: ${inserted} líneas`)
        } catch (e) {
          console.error(`❌ Error procesando OC d${d}:`, e)
          errors++
        }
      }
    }

    await client.query('COMMIT')
    return { ok:true, totalRecibidos, inserts, updates, errors, domains }
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK') } catch(_){} }
    console.error('❌ [QAD] Fallo general sync:', e)
    return { ok:false, error:String(e.message||e), stack:e.stack }
  } finally { if (client) client.release() }
}

/* ========================= Exponer SOAP desde el service ========================= */
export async function updatePoStateSOAP({ domain, po, estado }) {
  return await callUpdatePoSOAP({ domain, po, estado })
}
