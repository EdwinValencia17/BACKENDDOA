// src/jobs/schedulers.js
import cron from "node-cron";

// OJO:
// - BASE es la URL base de TU backend (el mismo que expone /api/presupuesto/sync)
// - TZ se usa para programar en hora local de planta
const BASE = process.env.AUTO_BASE_URL || "http://localhost:3001";
const TZ   = process.env.JOB_TZ || "America/Bogota";

// =====================================
// Helper POST JSON
// =====================================
// Node 18+ ya trae fetch global. Si estás en Node <=16, instala node-fetch
// y cámbialo por: import fetch from 'node-fetch';
async function postJson(path, payload) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    });

    const txt = await res.text();
    console.log(`[JOB] ${url} -> ${res.status} ${txt}`);
  } catch (e) {
    console.error(`[JOB] ${url} ERROR`, e);
  }
}

// =====================================
// startSchedulers
// Esta función se llama UNA SOLA VEZ
// cuando levantas el servidor Express
// =====================================
export function startSchedulers() {
  // =====================================================
  // Schedules "legacy" que ya manejabas (mailers, etc.)
  // Los dejo como blueprint. Si quieres activarlos,
  // quitas los comentarios.
  // =====================================================

  const CRON_INICIADAS    = process.env.CRON_INICIADAS    || "0 8 * * *";   // 08:00 todos los días
  const CRON_SIN_INICIAR  = process.env.CRON_SIN_INICIAR  || "45 7 * * *";  // 07:45 todos los días
  const CRON_CERRAR_3M    = process.env.CRON_CERRAR_3M    || "0 6 * * *";   // 06:00 todos los días
  const CRON_DESACTIVAR   = process.env.CRON_DESACTIVAR   || "1 0 * * *";   // 00:01 todos los días
  const CRON_CONTINGENCIA = process.env.CRON_CONTINGENCIA || "30 7 * * *";  // 07:30 todos los días

  // Ejemplo: notificar órdenes INICIADAS (estado=1) a los autorizadores
  // cron.schedule(
  //   CRON_INICIADAS,
  //   () => postJson("/envio/iniciadas?attachExcel=1", {}),
  //   { timezone: TZ }
  // );

  // Ejemplo: notificar SIN INICIAR (estado=0) a Compras
  // cron.schedule(
  //   CRON_SIN_INICIAR,
  //   () => postJson("/envio/sin-iniciar?attachExcel=1", {}),
  //   { timezone: TZ }
  // );

  // Ejemplo: cerrar OCs iniciadas hace >=3 meses
  // cron.schedule(
  //   CRON_CERRAR_3M,
  //   () => postJson("/tareas/cerrar-iniciadas-3m", {}),
  //   { timezone: TZ }
  // );

  // Ejemplo: desactivar permisos temporales vencidos
  // cron.schedule(
  //   CRON_DESACTIVAR,
  //   () => postJson("/tareas/desactivar-permisos-temporales", {}),
  //   { timezone: TZ }
  // );

  // Ejemplo: reporte de contingencia diario
  // cron.schedule(
  //   CRON_CONTINGENCIA,
  //   () => postJson("/envio/reporte-contingencia", {}),
  //   { timezone: TZ }
  // );

  // =====================================================
  // 🔥 NUESTRO BEBÉ: SYNC PRESUPUESTO MENSUAL
  // =====================================================
  //
  // Objetivo:
  //   - Cada inicio de mes, traernos los montos actualizados desde QAD
  //   - Guardarlos en doa2.presup_mes vía /api/presupuesto/sync
  //
  // CRON_PRESUP_MENSUAL:
  //   "5 4 1 * *"
  //   └─ minuto 5
  //      hora   4 AM
  //      día    1 de cada mes
  //
  // Hora fría, antes de que empiece el baile de las OCs.
  //
  const CRON_PRESUP_MENSUAL =
    process.env.CRON_PRESUP_MENSUAL || "5 4 1 * *";

  cron.schedule(
    CRON_PRESUP_MENSUAL,
    async () => {
      const now = new Date();
      const yearStr = String(now.getFullYear()); // ej "2025"

      console.log(
        `[JOB][PRESUP] Disparando sync presupuesto para year=${yearStr} ...`
      );

      await postJson("/api/presupuesto/sync", {
        year: yearStr,
        user: "SYNC_CRON", // Auditoría en last_upd_by
      });
    },
    { timezone: TZ }
  );

  // =====================================================
  // OPCIONAL CORPORATE MOVE:
  // Pre-cargar el presupuesto del año siguiente
  // una vez en octubre (15/oct 04:10 AM).
  //
  // Esto sirve para arrancar el año nuevo
  // SIN quedarnos sin tope en enero.
  //
  // Si no lo quieres aún, puedes comentar todo este bloque.
  // =====================================================
  const CRON_PRELOAD_NEXT =
    process.env.CRON_PRESUP_PRELOAD_NEXT || "10 4 15 10 *";

  cron.schedule(
    CRON_PRELOAD_NEXT,
    async () => {
      const now = new Date();
      const nextYear = String(now.getFullYear() + 1); // ej "2026"

      console.log(
        `[JOB][PRESUP_NEXT] Precargando presupuesto del año siguiente=${nextYear} ...`
      );

      await postJson("/api/presupuesto/sync", {
        year: nextYear,
        user: "SYNC_PRELOAD",
      });
    },
    { timezone: TZ }
  );

  // =====================================================
  // LOG FINAL
  // =====================================================
  console.log(
    `[JOB] Schedulers ON (TZ=${TZ}, BASE=${BASE})`
  );
}
