// src/repositories/presupuestoRepo.js
import pool from '../config/db.js';

// Inserta / actualiza una fila en doa2.presup_mes
export async function upsertPresupuestoRow(row, user = 'SYNC_QAD') {
  const sql = `
    INSERT INTO doa2.presup_mes (
      id_ceco,
      cc_codigo,
      cuenta_contable,
      periodo_yyyymm,
      presupuesto_mes,
      flex_porc,
      source_code,
      source_desc,
      last_sync_at,
      last_upd_by,
      last_upd_at
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8, NOW(), $9, NOW()
    )
    ON CONFLICT (cc_codigo, cuenta_contable, periodo_yyyymm)
    DO UPDATE SET
      presupuesto_mes = EXCLUDED.presupuesto_mes,
      flex_porc       = EXCLUDED.flex_porc,
      source_code     = EXCLUDED.source_code,
      source_desc     = EXCLUDED.source_desc,
      last_sync_at    = NOW(),
      last_upd_by     = EXCLUDED.last_upd_by,
      last_upd_at     = NOW()
  `;

  const params = [
    row.id_ceco ?? null,
    row.cc_codigo,
    row.cuenta_contable,
    row.periodo_yyyymm,
    row.presupuesto_mes,
    row.flex_porc ?? null,
    row.source_code ?? null,
    row.source_desc ?? null,
    user,
  ];

  await pool.query(sql, params);
}

/**
 * Retorna [{ cc_codigo, cc_descripcion, periodo, presupuesto_mes, gastado_mes, disponible }]
 * para un CECO y un periodo YYYYMM.
 *
 * Lógica:
 *  - presupSQL: suma presupuesto_mes de ese ceco en ese periodo (todas las cuentas)
 *  - gastadoSQL: suma valor_total de detalle_oc para ese ceco en ese mes (solo registros activos)
 */
export async function getPresupuestoVsGastado({ ceco, periodo }) {
  const yearStr = periodo.slice(0, 4);   // "2025"
  const monthStr = periodo.slice(4, 6);  // "11"
  const yearInt = Number(yearStr);       // 2025
  const monthInt = Number(monthStr);     // 11

  // 1. presupuesto total del mes para ese centro
  const presupSQL = `
    SELECT
      p.cc_codigo,
      ce.descripcion         AS cc_descripcion,
      SUM(p.presupuesto_mes) AS presupuesto_total_mes
    FROM doa2.presup_mes p
    LEFT JOIN doa2.centro_costo ce
      ON ce.codigo = p.cc_codigo
    WHERE p.cc_codigo = $1
      AND p.periodo_yyyymm = $2
    GROUP BY p.cc_codigo, ce.descripcion
  `;

  // 2. gasto real en ese mes
  // detalle_oc.cabecera_oc_id_cabe -> cabecera_oc.id_cabe
  // cabecera_oc.centro_costo_id_ceco -> centro_costo.id_ceco
  // centro_costo.codigo -> "770-001"
  // filtro por estado_registro='A'
  const gastadoSQL = `
    SELECT
      ce.codigo          AS cc_codigo,
      ce.descripcion     AS cc_descripcion,
      SUM(d.valor_total) AS gastado_mes
    FROM doa2.detalle_oc d
    JOIN doa2.cabecera_oc c
      ON c.id_cabe = d.cabecera_oc_id_cabe
    JOIN doa2.centro_costo ce
      ON ce.id_ceco = c.centro_costo_id_ceco
    WHERE ce.codigo = $1
      AND EXTRACT(YEAR  FROM c.fecha_creacion)::int = $2
      AND EXTRACT(MONTH FROM c.fecha_creacion)::int = $3
      AND c.estado_registro = 'A'
      AND d.estado_registro = 'A'
    GROUP BY ce.codigo, ce.descripcion
  `;

  const [presupRes, gastadoRes] = await Promise.all([
    pool.query(presupSQL, [ceco, periodo]),
    pool.query(gastadoSQL, [ceco, yearInt, monthInt]),
  ]);

  const presupRow = presupRes.rows[0] || {
    cc_codigo: ceco,
    cc_descripcion: null,
    presupuesto_total_mes: 0,
  };

  const gastoRow = gastadoRes.rows[0] || {
    cc_codigo: ceco,
    cc_descripcion: presupRow.cc_descripcion || null,
    gastado_mes: 0,
  };

  const cc_codigo = presupRow.cc_codigo || gastoRow.cc_codigo || ceco;
  const cc_descripcion =
    presupRow.cc_descripcion ||
    gastoRow.cc_descripcion ||
    null;

  const presupuesto = Number(presupRow.presupuesto_total_mes || 0);
  const gastado = Number(gastoRow.gastado_mes || 0);
  const disponible = presupuesto - gastado;

  return [
    {
      cc_codigo,
      cc_descripcion,
      periodo,
      presupuesto_mes: presupuesto,
      gastado_mes: gastado,
      disponible,
    },
  ];
}

// 🔥 NUEVA
// Trae TODOS los centros de costo con su presupuesto y gastado para un periodo dado (YYYYMM)
export async function getPresupuestoResumenPeriodo({ periodo }) {
  const yearStr = periodo.slice(0, 4);   // "2025"
  const monthStr = periodo.slice(4, 6);  // "11"
  const yearInt = Number(yearStr);
  const monthInt = Number(monthStr);

  // 1. Presupuesto mensual total por CECO en ese periodo
  const presupSQL = `
    SELECT
      p.cc_codigo,
      ce.descripcion         AS cc_descripcion,
      SUM(p.presupuesto_mes) AS presupuesto_total_mes
    FROM doa2.presup_mes p
    LEFT JOIN doa2.centro_costo ce
      ON ce.codigo = p.cc_codigo
    WHERE p.periodo_yyyymm = $1
    GROUP BY p.cc_codigo, ce.descripcion
  `;

  // 2. Gastado real de las OCs vivas ese mismo mes/año por CECO
  const gastadoSQL = `
    SELECT
      ce.codigo          AS cc_codigo,
      ce.descripcion     AS cc_descripcion,
      SUM(d.valor_total) AS gastado_mes
    FROM doa2.detalle_oc d
    JOIN doa2.cabecera_oc c
      ON c.id_cabe = d.cabecera_oc_id_cabe
    JOIN doa2.centro_costo ce
      ON ce.id_ceco = c.centro_costo_id_ceco
    WHERE EXTRACT(YEAR  FROM c.fecha_creacion)::int = $1
      AND EXTRACT(MONTH FROM c.fecha_creacion)::int = $2
      AND c.estado_registro = 'A'
      AND d.estado_registro = 'A'
    GROUP BY ce.codigo, ce.descripcion
  `;

  // 3. Ejecutar en paralelo
  const [presRes, gastRes] = await Promise.all([
    pool.query(presupSQL, [periodo]),
    pool.query(gastadoSQL, [yearInt, monthInt]),
  ]);

  // 4. Indexar gasto por centro de costo
  const gastoMap = new Map();
  for (const g of gastRes.rows) {
    gastoMap.set(g.cc_codigo, {
      gastado_mes: Number(g.gastado_mes || 0),
      cc_descripcion: g.cc_descripcion || null,
    });
  }

  // 5. Fusionar
  const out = presRes.rows.map((p) => {
    const codigo = p.cc_codigo;

    const presupuesto_mes = Number(p.presupuesto_total_mes || 0);

    const gastoInfo = gastoMap.get(codigo) || {
      gastado_mes: 0,
      cc_descripcion: p.cc_descripcion || null,
    };

    const gastado_mes = gastoInfo.gastado_mes;
    const disponible = presupuesto_mes - gastado_mes;

    return {
      cc_codigo: codigo,
      cc_descripcion:
        gastoInfo.cc_descripcion || p.cc_descripcion || null,
      periodo,
      presupuesto_mes,
      gastado_mes,
      disponible,
    };
  });

  // Nota: si hay gasto sin presupuesto, no lo metemos aún.
  // (Si quieres eso también dime y lo integramos.)
  return out;
}