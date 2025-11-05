// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

// Rutas existentes
import companiasRouter from './src/routes/Solicitante/companias.js';
import centroCostoRoutes from './src/routes/Solicitante/centroCostos.js';
import estadoOcRoutes from './src/routes/Solicitante/EstadosOc.js';
import cabeceraOCRoutes from './src/routes/Solicitante/cabeceraoc.js';
import gestionarPersonasRoute from './src/routes/CatalogosOC/gestionarPersonas.js';
import monedasRouter from './src/routes/CatalogosOC/monedas.js';
import homologacionRoutes from './src/routes/homologaciones.js';
import historialAutorizacion from './src/routes/HistorialDeAutorizacion.js';
import bandejaNivelCero from './src/routes/BandejaNivelCero/bandeja-nivel-cero.js';
import gestionDetallesOC from './src/routes/BandejaNivelCero/gestiondetalles-oc.js';
import { createTransporter } from './src/lib/mailer.js';
import envioAuto from './src/routes/EnvioAutomaticoDeCorreos.js';
import { startSchedulers } from './src/jobs/scheduler.js';
import inicioMasivoRoutes from './src/routes/InicioMasivo.js';
import anulacionRouter from './src/routes/AnulacioOrdenesCompra.js';
import bandejaAutorizacion from './src/routes/BandejaAutorizacion/BandejaAutorizacion.js';
import DetallesDeAutorizacion from './src/routes/BandejaAutorizacion/DetallesDeAutorizacion.js';
import bandejaJuridico from './src/routes/Legal/BandejaJuridico.js';
import gestionarParametros from './src/routes/Gestiones/GestionarParametros.js';
import gestionPermisoTemporales from './src/routes/Admin/GestionPermisoTemporales.js';
import historialPermisosRouter from './src/routes/Admin/HistorialDepermisos.js';
import ordenesCompraRouter from './src/routes/Admin/OrdenesCompra.js';
import gestionTipoAutorizadorRouter from './src/routes/Gestiones/GestionTipoAutorizador.js';
import gestionNivelesRouter from './src/routes/Gestiones/GestionNiveles.js';
import gestionCentroCostoRouter from './src/routes/Gestiones/GestionCentroCosto.js';
import gestionTipoPolizaRouter from './src/routes/Gestiones/GestionDePoliza.js';
import gestionMotivoRechazoRouter from './src/routes/Gestiones/GestionMotivoRechazo.js';
import gestionCategoriasRouter from './src/routes/Gestiones/GestionCategorias.js';
import reglas from './src/routes/ReglasDeNegocio/ReglasDeNegocio.js';
import authSeguridad from './src/routes/Home/auth.seguridadjci.js';
import presupuestoRouter from './src/routes/Presupuesto/presupuesto.js';
import { buildDashboardRouter } from './src/routes/Dashboard/dashboard.logic.js';


const app = express();
// Network & CORS
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3001);

// (tu config actual: permitir todo origen)
const corsOptions = {
  origin: /.*/,
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  optionsSuccessStatus: 204,
};

app.set('trust proxy', 1);

// Middlewares base
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// SMTP check (best effort)
;(async () => {
  try {
    const t = createTransporter();
    await t.verify();
    console.log('[mailer] SMTP OK: listo para enviar');
  } catch (e) {
    console.error('[mailer] SMTP verify failed:', e?.message || e);
  }
})();

// Healthcheck global
app.get('/health', (_req, res) => res.json({ ok: true }));

// Rutas
app.use('/api/companias', companiasRouter);
app.use('/api/centros-costo', centroCostoRoutes);
app.use('/api/estados-oc', estadoOcRoutes);
app.use('/api/cabecera-oc', cabeceraOCRoutes);
app.use('/api/personas', gestionarPersonasRoute);
app.use('/api/monedas', monedasRouter);
app.use('/api/homologaciones', homologacionRoutes);
app.use('/api/historial-autorizacion', historialAutorizacion);
app.use('/api', bandejaNivelCero);
app.use('/api/gestion-oc', gestionDetallesOC);
app.use('/auto', envioAuto);
app.use('/api/inicio-masivo', inicioMasivoRoutes);
app.use('/api', anulacionRouter);
app.use('/api/bandeja-autorizacion', bandejaAutorizacion);
app.use('/api/detalles-bandeja-autorizacion', DetallesDeAutorizacion);
app.use('/api/legal/bandeja-juridico', bandejaJuridico);
app.use('/api', gestionarParametros);
app.use('/api/admin', gestionPermisoTemporales);
app.use('/api', historialPermisosRouter);
app.use('/api/autorizaciones-solicitante', ordenesCompraRouter);
app.use('/api/gestion-tipo-autorizador', gestionTipoAutorizadorRouter);
app.use('/api/gestion-niveles', gestionNivelesRouter);
app.use('/api/gestion-centro-costo', gestionCentroCostoRouter);
app.use('/api/gestion-tipo-poliza', gestionTipoPolizaRouter);
app.use('/api/gestion-motivo-rechazo', gestionMotivoRechazoRouter);
app.use('/api/gestion-categorias', gestionCategoriasRouter);
app.use('/api', authSeguridad);
app.use('/api', reglas);
app.use('/api', presupuestoRouter);
app.use('/api/dashboard', buildDashboardRouter({ express }));


// Arranque
app.listen(PORT, HOST, () => {
  const local = `http://localhost:${PORT}`;
  const lan = process.env.API_PUBLIC_URL || `http://${HOST}:${PORT}`;
  console.log(`API arriba: ${local}`);
  console.log(`API LAN:   ${lan}`);

  try {
    if (typeof startSchedulers === 'function') {
      startSchedulers();
      console.log('[JOB] schedulers iniciados');
    } else {
      console.warn('[JOB] startSchedulers no es una función (¿mal importado?)');
    }
  } catch (e) {
    console.error('[JOB] fallo iniciando schedulers:', e);
  }
});
