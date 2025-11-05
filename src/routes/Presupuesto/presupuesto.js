// src/routes/Presupuesto/presupuesto.js
import { Router } from 'express';
import {
  getPresupuestoHandler,
  syncPresupuestoHandler,
  getPresupuestoPeriodoHandler,
} from '../../controllers/presupuesto.controller.js';

const router = Router();

// 1. ⏫ primero la más específica (sin :ceco)
router.get('/presupuesto/periodo/:periodo', getPresupuestoPeriodoHandler);

// 2. luego la que recibe CECO puntual
router.get('/presupuesto/:ceco/:periodo', getPresupuestoHandler);

// 3. sync QAD -> presup_mes
router.post('/presupuesto/sync', syncPresupuestoHandler);

export default router;
