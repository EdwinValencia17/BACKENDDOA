// src/services/qad/transformPresupuestoQAD.js

// Convierte 4.131801E7 -> "41318010"
function normalizeCuenta(raw) {
  if (raw === null || raw === undefined) return '';
  // Number(raw).toFixed(0) nos da string sin decimales, útil pa' notación científica
  return Number(raw).toFixed(0);
}

// arma periodo AAAAMM (number o string? -> vamos string porque tu repo usa strings tipo "202511")
function buildPeriodo(year, mesIdx1) {
  // year viene "2025" (string) desde el body
  // mesIdx1 es 1..12
  const mm = mesIdx1 < 10 ? `0${mesIdx1}` : `${mesIdx1}`;
  return `${year}${mm}`; // "202511"
}

/**
 * Aplana la respuesta de QAD a filas mensuales por CECO+cuenta
 *
 * @param {object} qadData = data cruda devuelta por QAD
 * @param {string|number} fiscalYear = año que estás sincronizando, ej "2025"
 *
 * Devuelve un array de objetos así:
 * [
 *   {
 *     ceco_codigo: "BQ32",
 *     ceco_desc: "DESC CECO",
 *     cuenta_contable: "41335712",
 *     periodo_yyyymm: "202509",
 *     monto_presupuesto: 4494000.0,
 *     budget_id: 1994574005,
 *     wbs_parent_id: 2115888308,
 *     budget_code: "PPTO YUMBO Q2Q4 FY25",
 *     budget_description: "PPTO YUMBO Q2Q4 FY25",
 *     fecha_carga: Date(...)
 *   },
 *   ...
 * ]
 */
export function flattenPresupuestoQAD(qadData, fiscalYear) {
  const out = [];
  const fechaCarga = new Date();

  const ttBudgetArr = qadData?.['ns1:ttBudget'];
  if (!Array.isArray(ttBudgetArr)) {
    // si no es array, devuelvo vacío
    return out;
  }

  for (const budget of ttBudgetArr) {
    if (!budget) continue;

    const budgetCode = budget['ns1:BudgetCode'] || '';
    const budgetDesc = budget['ns1:BudgetDescription'] || '';

    const centros = budget['ns1:ttCentroCosto'];
    if (!Array.isArray(centros)) continue;

    for (const centro of centros) {
      if (!centro) continue;

      const cecoCodigo = centro['ns1:BudgetWBSCode'] || '';   // "BQ32"
      const cecoDesc   = centro['ns1:BudgetWBSDesc'] || '';   // desc CECO
      const budgetId   = centro['ns1:Budget_ID'];             // ej 1.9945E9
      const parentId   = centro['ns1:BudgetWBSParent_ID'] || centro['ns1:BudgetWBS_ID'];

      let cuentas = centro['ns1:ttCuenta'] || [];
      if (!Array.isArray(cuentas)) {
        cuentas = [cuentas];
      }

      for (const cuenta of cuentas) {
        if (!cuenta) continue;

        const cuentaContable = normalizeCuenta(cuenta['ns1:BudgetWBSCode']);

        // montos mensuales indexados enero..dic
        const montosMensuales = [
          cuenta['ns1:Monto01TC'],
          cuenta['ns1:Monto02TC'],
          cuenta['ns1:Monto03TC'],
          cuenta['ns1:Monto04TC'],
          cuenta['ns1:Monto05TC'],
          cuenta['ns1:Monto06TC'],
          cuenta['ns1:Monto07TC'],
          cuenta['ns1:Monto08TC'],
          cuenta['ns1:Monto09TC'],
          cuenta['ns1:Monto10TC'],
          cuenta['ns1:Monto11TC'],
          cuenta['ns1:Monto12TC'],
        ];

        montosMensuales.forEach((monto, idx) => {
          const montoNum = Number(monto || 0);

          // regla de oro: no metemos basura en cero
          if (montoNum === 0) {
            return;
          }

          const periodo = buildPeriodo(String(fiscalYear), idx + 1); // "2025" + idx

          out.push({
            ceco_codigo: cecoCodigo.trim(),
            ceco_desc: cecoDesc ? cecoDesc.trim() : null,
            cuenta_contable: cuentaContable,
            periodo_yyyymm: periodo,
            monto_presupuesto: montoNum,
            budget_id: budgetId,
            wbs_parent_id: parentId,
            budget_code: budgetCode,
            budget_description: budgetDesc,
            fecha_carga: fechaCarga,
          });
        });
      }
    }
  }

  return out;
}
