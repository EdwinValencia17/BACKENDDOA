// src/routes/Dashboard/dashboard.routes.js
import { Router } from 'express';
import authMiddleware from '../../middlewares/auth.middleware.js';
import { dashboardResumenHandler } from '../../controllers/dashboard.controller.js';
import { dashboardOpcionesHandler } from '../../controllers/dashboard.options.controller.js';

const router = Router();

// Dashboard resumen con filtros (?periodo=YYYYMM&ceco=...&compania=...&proveedor=...&estado=...)
router.get('/dashboard/resumen', authMiddleware, dashboardResumenHandler);

// Listas para filtros (proveedores, cecos, compañías)
router.get('/dashboard/opciones', authMiddleware, dashboardOpcionesHandler);

export default router;
