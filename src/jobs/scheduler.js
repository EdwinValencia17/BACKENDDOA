import cron from "node-cron";

const BASE = process.env.AUTO_BASE_URL || "http://localhost:3001/auto";
const TZ = process.env.JOB_TZ || "America/Bogota";

// Si usas Node 18+ tienes fetch global. En Node <=16 instala node-fetch.
async function post(pathWithQs) {
  const url = `${BASE}${pathWithQs}`;
  try {
    const res = await fetch(url, { method: "POST" });
    const txt = await res.text();
    console.log(`[JOB] ${url} -> ${res.status} ${txt}`);
  } catch (e) {
    console.error(`[JOB] ${url} ERROR`, e);
  }
}

export function startSchedulers() {
  // === Horarios por ENV (fallbacks) ===
  // Ejemplos de formato CRON:
  //  "0 8 * * *"  -> a las 08:00 todos los días
  //  "30 7 * * 1-5" -> 07:30 de lunes a viernes
  const CRON_INICIADAS    = process.env.CRON_INICIADAS    || "0 8 * * *";   // 08:00
  const CRON_SIN_INICIAR  = process.env.CRON_SIN_INICIAR  || "45 7 * * *";  // 07:45
  const CRON_CERRAR_3M    = process.env.CRON_CERRAR_3M    || "0 6 * * *";   // 06:00
  const CRON_DESACTIVAR   = process.env.CRON_DESACTIVAR   || "1 0 * * *";   // 00:01
  const CRON_CONTINGENCIA = process.env.CRON_CONTINGENCIA || "30 7 * * *";  // 07:30

  // 1) 08:00 — INICIADAS (estado = 1) ➜ autorizadores (con Excel por persona si quieres)
  
  //cron.schedule(CRON_INICIADAS, () => post("/envio/iniciadas?attachExcel=1"), { timezone: TZ });

  // 2) 07:45 — SIN INICIAR (estado = 0) ➜ iniciadores (Compras)
  //cron.schedule(CRON_SIN_INICIAR, () => post("/envio/sin-iniciar?attachExcel=1"), { timezone: TZ });

  // 3) 06:00 — cierre OCs iniciadas ≥ 3 meses
  // cron.schedule(CRON_CERRAR_3M, () => post("/tareas/cerrar-iniciadas-3m"), { timezone: TZ });

  // 4) 00:01 — desactivar permisos temporales vencidos
  // cron.schedule(CRON_DESACTIVAR, () => post("/tareas/desactivar-permisos-temporales"), { timezone: TZ });

  // 5) Reporte de contingencia diario 07:30
  // cron.schedule(CRON_CONTINGENCIA, () => post("/envio/reporte-contingencia"), { timezone: TZ });

  // (Pendientes de implementar cuando conectes QAD real)
  // cron.schedule("0 6,14,22 * * *", () => post("/tareas/qad-actualizar"), { timezone: TZ });
  // cron.schedule("*/15 * * * *", () => post("/tareas/actualizar-estado-po"), { timezone: TZ });

  console.log(`[JOB] Schedulers ON (TZ=${TZ}, BASE=${BASE})`);
}
