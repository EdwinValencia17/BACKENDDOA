// src/routes/Solicitante/companias_dashboard.js
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();

/* =========================
 * Helpers (fechas y formato)
 * ========================= */

// YYYY-MM-DD o ISO -> Date (UTC 00:00)
function parseDateUTC(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}

function monthStartUTC(y, m1to12) {
  return new Date(Date.UTC(y, m1to12 - 1, 1, 0, 0, 0));
}

function addMonthsUTC(d, k) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1, 0, 0, 0));
}

function mesAbrevES(d) {
  return d.toLocaleString('es-CO', { month: 'short' }).toUpperCase().replace('.', '');
}

function rowsToSerie(rows) {
  const bucket = new Map();
  for (const r of rows) {
    const d = new Date(r.mes_ini);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!bucket.has(key)) bucket.set(key, { mes: mesAbrevES(d), series: [] });
    const label = `${(r.codigo || '').trim()} - ${(r.nombre || '').trim()}`.trim();
    bucket.get(key).series.push({
      id_compania: Number(r.id_compania),
      label,
      gastado: Number(r.gastado_mes || 0),
    });
  }
  return Array.from(bucket.values());
}

/**
 * Si el cliente NO envía dateFrom/dateTo, derivamos por datos de creación:
 * - Tomamos MAX(fecha_creacion)
 * - Rango de 12 meses hacia atrás (mensual)
 */
async function getDataDrivenRangeByCreation() {
  const sql = `
    SELECT date_trunc('month', MAX(c.fecha_creacion)) AS max_month
    FROM doa2.cabecera_oc c
    WHERE c.estado_registro = 'A'
  `;
  const { rows } = await pool.query(sql);
  const maxTs = rows?.[0]?.max_month ? new Date(rows[0].max_month) : null;
  const endMonth = maxTs || new Date();
  const endExclusive = addMonthsUTC(
    monthStartUTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() + 1),
    1
  );
  const startInclusive = addMonthsUTC(endExclusive, -12);
  return { startInclusive, endExclusive };
}

/** Resuelve rango por fecha de creación (mensualizado) */
async function resolveCreationRange(dateFrom, dateTo) {
  const df = parseDateUTC(dateFrom);
  const dt = parseDateUTC(dateTo);

  if (df && dt) {
    let a = df;
    let b = dt;
    if (b < a) [a, b] = [b, a];
    const s = monthStartUTC(a.getUTCFullYear(), a.getUTCMonth() + 1);
    const e = addMonthsUTC(monthStartUTC(b.getUTCFullYear(), b.getUTCMonth() + 1), 1);
    return { startInclusive: s, endExclusive: e };
  }
  return getDataDrivenRangeByCreation();
}

/**
 * Serie por compañías (Top-N o una específica) 100% por FECHA_CREACION.
 * Sin amarrarse a “periodo” ni a otros filtros del dashboard.
 * Fijo: c.estado_registro = 'A'
 */
async function getSerieCompaniasByCreation({ startInclusive, endExclusive, topN = 3, companiaId = null }) {
  const limitTop = companiaId ? 1 : Number(topN);

  const sql = `
    WITH series AS (
      SELECT generate_series(
        date_trunc('month', $1::timestamp),
        date_trunc('month', $2::timestamp) - interval '1 month',
        interval '1 month'
      ) AS mes_ini
    ),
    base AS (
      SELECT
        date_trunc('month', c.fecha_creacion) AS mes_ini,
        comp.id_compania,
        TRIM(comp.codigo_compania) AS codigo,
        TRIM(comp.nombre_compania) AS nombre,
        SUM(COALESCE(c.total_neto, 0)) AS gastado_mes
      FROM doa2.cabecera_oc c
      JOIN doa2.companias comp ON comp.id_compania = c.id_compania
      WHERE c.estado_registro = 'A'
        AND c.fecha_creacion >= $1
        AND c.fecha_creacion <  $2
      GROUP BY 1,2,3,4
    ),
    totals AS (
      SELECT b.id_compania, MAX(b.codigo) AS codigo, MAX(b.nombre) AS nombre, SUM(b.gastado_mes) AS total_rango
      FROM base b GROUP BY b.id_compania
    ),
    pick_top AS (
      SELECT id_compania, codigo, nombre, total_rango
      FROM totals
      ORDER BY total_rango DESC
      LIMIT ${limitTop}
    ),
    pick_fallback AS (
      -- Si el rango viene pelado, usamos un top de los últimos 24 meses para poblar la leyenda
      SELECT t.id_compania, t.codigo, t.nombre, t.total_rango
      FROM (
        SELECT
          comp.id_compania,
          TRIM(comp.codigo_compania) AS codigo,
          TRIM(comp.nombre_compania) AS nombre,
          SUM(COALESCE(c.total_neto,0)) AS total_rango
        FROM doa2.cabecera_oc c
        JOIN doa2.companias comp ON comp.id_compania = c.id_compania
        WHERE c.estado_registro = 'A'
          AND c.fecha_creacion >= $3
          AND c.fecha_creacion <  $4
        GROUP BY comp.id_compania, comp.codigo_compania, comp.nombre_compania
        ORDER BY SUM(COALESCE(c.total_neto,0)) DESC
        LIMIT ${limitTop}
      ) t
    ),
    pick AS (
      ${
        // Si se pide una compañía concreta: forzamos esa (aunque tenga 0s)
        `SELECT * FROM (
           SELECT
             $5::int AS id_compania,
             COALESCE(t.codigo, comp.codigo_compania) AS codigo,
             COALESCE(t.nombre, comp.nombre_compania) AS nombre,
             COALESCE(t.total_rango, 0) AS total_rango
           FROM doa2.companias comp
           LEFT JOIN totals t ON t.id_compania = $5::int
           WHERE comp.id_compania = $5::int
         ) x
         UNION ALL
         SELECT * FROM (
           SELECT * FROM pick_top
           UNION ALL
           SELECT * FROM pick_fallback
           WHERE NOT EXISTS (SELECT 1 FROM pick_top)
         ) y
         WHERE $5::int IS NULL`
      }
    )
    SELECT
      s.mes_ini,
      p.id_compania,
      p.codigo,
      p.nombre,
      COALESCE(b.gastado_mes, 0) AS gastado_mes
    FROM series s
    CROSS JOIN pick p
    LEFT JOIN base b
      ON b.mes_ini = s.mes_ini
     AND b.id_compania = p.id_compania
    ORDER BY s.mes_ini ASC, p.id_compania ASC;
  `;

  // Ventana “fallback” 24m hacia atrás desde el fin del rango.
  const fallbackStart = addMonthsUTC(startInclusive, -12);
  const fallbackEnd = endExclusive;

  const params = companiaId
    ? [startInclusive.toISOString(), endExclusive.toISOString(), fallbackStart.toISOString(), fallbackEnd.toISOString(), Number(companiaId)]
    : [startInclusive.toISOString(), endExclusive.toISOString(), fallbackStart.toISOString(), fallbackEnd.toISOString(), null];

  const { rows } = await pool.query(sql, params);
  return rowsToSerie(rows);
}

/* ========== Rutas (¡el orden importa!) ========== */

/**
 * GET /api/companias_dashboard/tendencia
 * Query:
 *  - dateFrom=YYYY-MM-DD (opcional)
 *  - dateTo=YYYY-MM-DD   (opcional)
 *  - topN=3              (opcional)
 *  - compania=ID         (opcional)
 */
router.get('/tendencia', async (req, res) => {
  try {
    const { dateFrom, dateTo, topN, compania } = req.query;

    const { startInclusive, endExclusive } = await resolveCreationRange(dateFrom, dateTo);

    const companiaId =
      compania !== undefined && compania !== null && String(compania).trim() !== ''
        ? Number(compania)
        : null;

    if (companiaId !== null && !Number.isInteger(companiaId)) {
      return res.status(400).json({ ok: false, message: 'Parametro "compania" debe ser entero.' });
    }

    const serie = await getSerieCompaniasByCreation({
      startInclusive,
      endExclusive,
      topN: topN ? Number(topN) : 3,
      companiaId,
    });

    // Meta legible
    const fromISO = startInclusive.toISOString().slice(0, 10);
    const endPrev = addMonthsUTC(endExclusive, -1);
    const lastDay = new Date(Date.UTC(endPrev.getUTCFullYear(), endPrev.getUTCMonth() + 1, 0));
    const toISO = lastDay.toISOString().slice(0, 10);

    return res.json({
      ok: true,
      meta: {
        fromDate: fromISO,
        toDate: toISO,
        startISO: startInclusive.toISOString(),
        endISO: endExclusive.toISOString(),
        topN: topN ? Number(topN) : 3,
        compania: companiaId,
      },
      serie,
    });
  } catch (err) {
    console.error('GET /api/companias_dashboard/tendencia error:', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Error obteniendo tendencia de compañías.' });
  }
});

/** GET /api/companias_dashboard/:id  (solo numérico) */
router.get('/:id', async (req, res, next) => {
  if (isNaN(Number(req.params.id))) return next();
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT id_compania, codigo_compania, nombre_compania
       FROM doa2.companias
       WHERE id_compania = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, message: 'No existe' });
    return res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('Error obteniendo compañía:', err);
    return res.status(500).json({ ok: false, message: 'Error obteniendo compañía' });
  }
});

/** GET /api/companias_dashboard/  listado */
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id_compania, codigo_compania, nombre_compania, estado_registro, fecha_creacion, usuario_creador
       FROM doa2.companias
       ORDER BY nombre_compania ASC`
    );
    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('Error listando compañías:', err);
    return res.status(500).json({ ok: false, message: 'Error listando compañías' });
  }
});

export default router;
