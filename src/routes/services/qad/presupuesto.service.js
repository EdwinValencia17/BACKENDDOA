// src/services/qad/presupuesto.service.js
import axios from 'axios';
import pool from '../../../config/db.js';
import { upsertPresupuestoRow } from '../../../repositories/presupuestoRepo.js';
import { flattenPresupuestoQAD } from './transformPresupuestoQAD.js';

// Lee el valor de un parámetro activo en doa2.parametros
async function getParametroValor(nombre) {
  const sql = `
    SELECT valor
    FROM doa2.parametros
    WHERE parametro = $1
      AND estado_registro = 'A'
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [nombre]);
  if (!rows.length) {
    throw new Error(`Parametro ${nombre} no encontrado o inactivo`);
  }
  return rows[0].valor;
}

/**
 * syncPresupuestoDesdeQAD
 *
 * @param {Object} opts
 * @param {string} opts.year   Ej "2025"
 * @param {string} [opts.user] Ej "EVENAV" o "SYNC_QAD"
 *
 * Flujo:
 *   1. Trae la URL del bridge desde doa2.parametros ('URL_PRESUPUESTO_MES')
 *   2. GET al bridge
 *   3. Aplana el JSON QAD → filas CECO+cuenta+mes (solo valores != 0)
 *   4. Resuelve id_ceco para cada cc_codigo usando centro_costo
 *   5. upsertPresupuestoRow(...) por cada fila
 */
export async function syncPresupuestoDesdeQAD({ year, user = 'SYNC_QAD' }) {
  if (!year) {
    throw new Error('syncPresupuestoDesdeQAD requiere year (YYYY)');
  }

  // 1. URL del WS QAD sacada de parametros
  const wsUrl = await getParametroValor('URL_PRESUPUESTO_MES');
  // ej: http://b9586s21:8111/bridge_QAD/rest/CoexitoIntegration/obtenerPresupuesto

  // 2. Consumimos QAD
  let data;
  try {
    console.log('[SYNC][QAD] GET', wsUrl);
    const resp = await axios.get(wsUrl);
    data = resp.data;
  } catch (err) {
    console.error('[SYNC][QAD] Error consumiendo bridge_QAD:', err.message);
    throw new Error(`No pude obtener presupuesto desde bridge_QAD: ${err.message}`);
  }

  // 3. Aplanar el JSON bruto en filas listas para DB
  const planos = flattenPresupuestoQAD(data, year);
  // planos = [
  //   {
  //     ceco_codigo,
  //     ceco_desc,
  //     cuenta_contable,
  //     periodo_yyyymm,
  //     monto_presupuesto,
  //     budget_code,
  //     budget_description,
  //     ...
  //   },
  //   ...
  // ]

  if (!planos.length) {
    console.warn('[SYNC][QAD] No se generaron filas (posible presupuesto vacío para ese año)');
    return {
      ok: true,
      message: 'Sin filas de presupuesto con valor distinto de cero',
      year,
      centros: 0,
      rows: 0,
    };
  }

  // 4. Cachear CECOs de BD UNA sola vez -> { codigo CECO => id_ceco }
  const cecoMap = new Map();
  const sqlCeco = `
    SELECT id_ceco, codigo
    FROM doa2.centro_costo
  `;
  const { rows: cecoRows } = await pool.query(sqlCeco);
  for (const r of cecoRows) {
    cecoMap.set(String(r.codigo).trim(), r.id_ceco);
  }

  // 5. Insert/Upsert fila por fila en doa2.presup_mes
  let insertCount = 0;
  const centrosVistos = new Set();

  for (const row of planos) {
    const cc_codigo = row.ceco_codigo;
    const id_ceco = cecoMap.get(cc_codigo) || null;

    const payloadDB = {
      id_ceco,
      cc_codigo,
      cuenta_contable: row.cuenta_contable,
      periodo_yyyymm: row.periodo_yyyymm,          // "202511"
      presupuesto_mes: row.monto_presupuesto,      // number
      flex_porc: null,                             // reservado futuro
      source_code: row.budget_code || null,        // p.ej "PPTO YUMBO Q2Q4 FY25"
      source_desc: row.budget_description || null, // descripción presupuesto
    };

    await upsertPresupuestoRow(payloadDB, user);
    insertCount++;
    centrosVistos.add(cc_codigo);
  }

  console.log('[SYNC][QAD] filas procesadas =', insertCount);
  console.log('[SYNC][QAD] centros distintos =', centrosVistos.size);

  return {
    ok: true,
    message: 'Sincronización presupuesto QAD -> DOA completada',
    year,
    centros: centrosVistos.size,
    rows: insertCount,
  };
}
