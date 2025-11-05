// src/controllers/presupuesto.controller.js
import {
  getPresupuestoVsGastado,
  getPresupuestoResumenPeriodo,
} from '../repositories/presupuestoRepo.js';
import { syncPresupuestoDesdeQAD } from '../../src/routes/services/qad/presupuesto.service.js';

// GET /api/presupuesto/:ceco/:periodo
export async function getPresupuestoHandler(req, res) {
  try {
    const { ceco, periodo } = req.params;
    const data = await getPresupuestoVsGastado({ ceco, periodo });
    return res.json({ ok: true, ceco, periodo, data });
  } catch (e) {
    console.error('[getPresupuestoHandler] error:', e);
    return res.status(500).json({ ok: false, msg: e.message });
  }
}

// GET /api/presupuesto/periodo/:periodo
// -> dame TODOS los centros de costo de ese periodo YYYYMM
// GET /api/presupuesto/periodo/:periodo
// Ej: /api/presupuesto/periodo/202511
// Retorna TODOS los CECO con su presupuesto, gastado, disponible
export async function getPresupuestoPeriodoHandler(req, res) {
  try {
    const { periodo } = req.params;

    if (!periodo || periodo.length !== 6) {
      return res
        .status(400)
        .json({ ok: false, msg: 'periodo debe ser YYYYMM, ej 202511' });
    }

    const data = await getPresupuestoResumenPeriodo({ periodo });

    return res.json({
      ok: true,
      periodo,
      total_centros: data.length,
      data,
    });
  } catch (e) {
    console.error('[getPresupuestoPeriodoHandler] error:', e);
    return res.status(500).json({ ok: false, msg: e.message });
  }
}

// POST /api/presupuesto/sync
export async function syncPresupuestoHandler(req, res) {
  try {
    const { year, user } = req.body || {};
    if (!year) {
      return res
        .status(400)
        .json({ ok: false, msg: 'Falta year en el body (YYYY ej "2025")' });
    }

    const syncInfo = await syncPresupuestoDesdeQAD({
      year,
      user: user || 'SYNC_QAD',
    });

    return res.json({ ok: true, sync: syncInfo });
  } catch (e) {
    console.error('[syncPresupuestoHandler] error:', e);
    return res.status(500).json({ ok: false, msg: e.message });
  }
}
