// src/repositories/parametrosRepo.js
import pool from '../config/db.js';

// Lee valor de doa2.parametros
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

// arma "202511" dado "2025" y "11"
function buildPeriodo(year, mm) {
  return `${year}${mm}`;
}

// normaliza algo que puede venir como objeto único o arreglo
function ensureArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Sincroniza TODO el presupuesto de un año desde QAD hacia doa2.presup_mes.
 *
 * @param {Object} opts
 * @param {string} opts.year  Ej "2025"
 * @param {string} [opts.user]  Ej "SYNC_QAD"
 */
export async function syncPresupuestoDesdeQAD({ year, user = 'SYNC_QAD' }) {
  // 1. Traer URL del WS desde parametros
  const wsUrl = await getParametroValor('URL_PRESUPUESTO_MES');
  // ejemplo actual en tu BD:
  // http://b9586s21:8111/bridge_QAD/rest/CoexitoIntegration/obtenerPresupuesto

  // 2. Llamar el WS.
  //    El 405 que viste es QAD diciéndonos "no POST", o sea: lo correcto es GET.
  //    Vamos a probar GET con query param year.
  //
  //    Si tu WS realmente no recibe 'year' sino devuelve TODO el año fiscal por defecto,
  //    igual este GET va a ignorar el parámetro extra y devolver algo útil.
  //
  //    Si algún día en QA descubres que el parámetro no se llama 'year' sino 'anio',
  //    cambias aquí mismo.
  let data;
  try {
    const resp = await axios.get(`${wsUrl}?year=${encodeURIComponent(year)}`, {
      // si QAD necesita headers especiales, auth básica, etc., se agregan aquí
    });
    data = resp.data;
  } catch (err) {
    // Si QAD aún así pateó, déjame algo útil en log:
    console.error('[syncPresupuestoDesdeQAD] fallo llamando WS QAD:', err.message);
    throw new Error(`No pude obtener presupuesto desde QAD: ${err.message}`);
  }

  // 3. Validar estructura esperada
  //    Según tu dump wsPresupuesto.txt:
  //    data["ns1:ttBudget"]["ns1:ttCentroCosto"][i]["ns1:ttCuenta"][j]
  //
  //    Cada ttCuenta tiene:
  //      ns1:BudgetWBSCode (cuenta/rubro)
  //      ns1:Monto01TC ... ns1:Monto12TC
  //
  const ttBudget = data?.['ns1:ttBudget'];
  if (!ttBudget) {
    throw new Error('Respuesta WS sin ns1:ttBudget (estructura inesperada)');
  }

  const budgetCode = ttBudget['ns1:BudgetCode'] ?? null;

  // centros de costo
  const centros = ensureArray(ttBudget['ns1:ttCentroCosto']);

  // 4. Recorrer cada centro de costo
  for (const cecoNode of centros) {
    const cc_codigo = String(cecoNode['ns1:CentroCostoCode'] || '').trim();
    const cc_desc   = String(cecoNode['ns1:CentroCostoDesc'] || '').trim();

    // buscar id_ceco interno (tabla doa2.centro_costo)
    const { rows: cecoRows } = await pool.query(
      `
      SELECT id_ceco
      FROM doa2.centro_costo
      WHERE codigo = $1
      LIMIT 1
    `,
      [cc_codigo]
    );
    const id_ceco = cecoRows.length ? cecoRows[0].id_ceco : null;

    // cada cuenta contable / rubro presupuestal
    const cuentas = ensureArray(cecoNode['ns1:ttCuenta']);

    for (const cuentaNode of cuentas) {
      const cuenta_contable_raw = cuentaNode['ns1:BudgetWBSCode'];
      const cuenta_contable = cuenta_contable_raw != null
        ? String(cuenta_contable_raw).trim()
        : null;

      // Recorremos los 12 meses
      for (let mes = 1; mes <= 12; mes++) {
        const mm = mes.toString().padStart(2, '0'); // "01","02",...
        const campoMonto = `ns1:Monto${mm}TC`;
        const valorMes = Number(cuentaNode[campoMonto] || 0);

        const periodo_yyyymm = buildPeriodo(year, mm); // ej '202511'

        const row = {
          id_ceco,
          cc_codigo,
          cuenta_contable,
          periodo_yyyymm,
          presupuesto_mes: valorMes,
          flex_porc: null,
          source_code: budgetCode,
          source_desc: cc_desc,
        };

        await upsertPresupuestoRow(row, user);
      }
    }
  }

  return {
    ok: true,
    message: 'Sincronización presupuesto QAD -> DOA completada',
    year,
    centros: centros.length,
  };
}