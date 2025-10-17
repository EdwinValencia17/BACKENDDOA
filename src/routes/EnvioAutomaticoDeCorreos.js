import express from "express";
import ExcelJS from "exceljs";
import { format, subMonths } from "date-fns";
import pool from "../config/db.js";

// usa tu mailer unificado
import { sendHtmlMail } from "../lib/mailer.js";

// builders de Excel separados
import { buildReporteContingencia } from "../lib/excel/contingencia.js";
import { buildReporteCerradas3M } from "../lib/excel/cerradas3m.js";
import { buildExcelPendientesPorAutorizador } from "../lib/excel/pendientesPorAutorizador.js";

const router = express.Router();

/* =============================
   HELPERS DE PARÁMETROS & UTIL
============================= */

async function getParametro(valor) {
  const { rows } = await pool.query(
    `SELECT valor FROM doa2.parametros WHERE parametro = $1 AND estado_registro = 'A' LIMIT 1`,
    [valor]
  );
  return rows[0]?.valor?.trim() || null;
}

// ctx para que el mailer consulte doa2.parametros (ES_PRUEBA, CORREO_COPIA_PRUEBA…)
const mailCtx = { paramResolver: getParametro };

function uniqueEmails(list) {
  return Array.from(new Set((list || []).filter(Boolean).map(s => s.trim()))).filter(Boolean);
}

// Estados “pendientes” parametrizables (p.ej. "0,1")
async function getPendingStates() {
  const val = (await getParametro("PENDING_STATES")) || "0,1";
  return val.split(",").map(s => Number(s.trim())).filter(n => !Number.isNaN(n));
}

// Estados “cerradas” parametrizables (p.ej. "6")
async function getClosedStates() {
  const val = (await getParametro("CLOSED_STATES")) || "6";
  return val.split(",").map(s => Number(s.trim())).filter(n => !Number.isNaN(n));
}

// Lista de “iniciadores” (equipo de Compras), separados por coma
async function getIniciadoresEmails() {
  const val = (await getParametro("CORREOS_INICIADORES")) || "";
  return uniqueEmails(val.split(","));
}

// Traducciones
function textosPendientes(idioma) {
  if ((idioma || "").toUpperCase() === "E") {
    return {
      saludo: "Mr(s) Authorizer,",
      asunto: "Purchase Orders pending for your approval",
      tabla: { oc: "PO Number", prov: "Vendor", valor: "Value", sol: "Requester" },
      intro: "The following Purchase Orders are pending your approval:",
    };
  }
  return {
    saludo: "Sr(a) Autorizador,",
    asunto: "Órdenes de compra pendientes por autorizar",
    tabla: { oc: "Orden Compra", prov: "Proveedor", valor: "Valor", sol: "Solicitante" },
    intro: "Las siguientes órdenes de compra están pendientes por su autorización:",
  };
}

function textosCerradas(idioma) {
  if ((idioma || "").toUpperCase() === "E") {
    return {
      saludo: "Mr(s) Authorizer,",
      asunto: "Purchase Orders closed/cancelled",
      tabla: { oc: "PO Number", prov: "Vendor", valor: "Value", sol: "Requester" },
      intro: "The following Purchase Orders were closed/cancelled:",
    };
  }
  return {
    saludo: "Sr(a) Autorizador,",
    asunto: "Órdenes de compra cerradas/canceladas",
    tabla: { oc: "Orden Compra", prov: "Proveedor", valor: "Valor", sol: "Solicitante" },
    intro: "Las siguientes órdenes de compra fueron cerradas/canceladas:",
  };
}

function htmlTablaPendientes({ titulo, saludo, intro, items, t }) {
  const rows = items.map(x => `
    <tr>
      <td style="padding:8px;border:1px solid #ddd;">${x.numero_orden_compra || ""}</td>
      <td style="padding:8px;border:1px solid #ddd;">${x.nombre_proveedor || ""}</td>
      <td style="padding:8px;border:1px solid #ddd;text-align:right;">
        ${new Intl.NumberFormat("es-CO",{style:"currency",currency:"COP"}).format(Number(x.total_neto||0))}
      </td>
      <td style="padding:8px;border:1px solid #ddd;">${x.solicitante || ""}</td>
    </tr>`).join("");

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;">
    <h2 style="color:#6d28d9;margin:0 0 12px;">${titulo}</h2>
    <p>${saludo}</p>
    <p>${intro}</p>
    <table style="border-collapse:collapse;width:100%;max-width:860px;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">${t.oc}</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">${t.prov}</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:right;">${t.valor}</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">${t.sol}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px;color:#6b7280;">DOA · Notificación automática</p>
  </div>
  `;
}

/* ===================================================
   PENDIENTES REALES POR AUTORIZADOR (desde LA=INICIADO)
=================================================== */

// Trae OCs pendientes por persona, basadas en lista_autorizaccion = INICIADO
async function fetchPendientesPorPersonaDesdeLA() {
  const { rows } = await pool.query(`
    SELECT
      p.id_pers                 AS id_persona,
      NULLIF(TRIM(p.email),'')  AS email,
      NULLIF(TRIM(p.idioma),'') AS idioma,

      c.numero_solicitud,
      c.numero_orden_compra,
      c.nombre_proveedor,
      c.total_neto,
      c.solicitante

    FROM doa2.lista_autorizaccion la
    JOIN doa2.cabecera_oc c
      ON c.id_cabe = la.cabecera_oc_id_cabe
     AND c.estado_registro = 'A'
    -- A quién le toca: coincidir rol (tipo/nivel/ceco) de la marca con autorizadores activos
    JOIN doa2.autorizador a
      ON a.estado_registro = 'A'
     AND a.tipo_autorizador_id_tiau = la.tipo_autorizador_id_tiau
     AND a.nivel_id_nive            = la.nivel_id_nive
     AND a.centro_costo_id_ceco     = la.centro_costo_id_ceco
     AND (
       COALESCE(a.temporal,'N')='N'
       OR (a.temporal='S' AND (NOW()::date BETWEEN a.fecha_inicio_temporal AND a.fecha_fin_temporal))
     )
    JOIN doa2.persona p
      ON p.id_pers = a.persona_id_pers
     AND p.estado_registro='A'
     AND NULLIF(TRIM(p.email),'') IS NOT NULL

    WHERE la.estado_registro='A'
      AND la.estado_oc_id_esta = 1   -- INICIADO
    ORDER BY c.fecha_orden_compra DESC NULLS LAST
  `);
  return rows;
}

// Arma y envía el digest agrupado por persona (aprovecha builder de Excel opcional)
async function enviarDigestPendientesAutorizadores({ attachExcel = false } = {}) {
  const base = await fetchPendientesPorPersonaDesdeLA();
  if (base.length === 0) return { ok: true, sent: 0, skipped: 'sin_pendientes' };

  // agrupar por persona
  const porPersona = new Map(); // key = personaId|email
  for (const r of base) {
    const key = `${r.id_persona}|${(r.email||'').trim()}`;
    if (!porPersona.has(key)) porPersona.set(key, { persona: r, items: [] });
    porPersona.get(key).items.push(r);
  }

  let enviados = 0;
  for (const [, { persona, items }] of porPersona) {
    const email = (persona.email || '').trim();
    if (!email || items.length === 0) continue;

    const t = textosPendientes(persona.idioma);
    const html = htmlTablaPendientes({
      titulo: t.asunto,
      saludo: t.saludo,
      intro: t.intro,
      items,
      t: t.tabla,
    });

    const attachments = [];
    if (attachExcel) {
      const buf = await buildExcelPendientesPorAutorizador({ items, idioma: persona.idioma });
      attachments.push({ filename: 'pendientes_por_autorizador.xlsx', content: buf });
    }

    await sendHtmlMail({
      from: process.env.MAIL_FROM || 'noreply-DOA@clarios.com',
      to: [email],
      subject: t.asunto,
      html,
      attachments,
    }, mailCtx); // <- usa paramResolver => ES_PRUEBA / COPIAS
    enviados++;
  }

  return { ok: true, sent: enviados };
}

// Endpoint para el scheduler: INICIADAS (1) -> a autorizadores reales de cada nivel
router.post('/envio/iniciadas', async (req, res) => {
  try {
    const attachExcel = String(req.query.attachExcel || '0') === '1';
    const r = await enviarDigestPendientesAutorizadores({ attachExcel });
    res.json({ ...r, estado: 1 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});


// 2) SIN INICIAR (estado = 0) ➜ a iniciadores (Compras)
router.post("/envio/sin-iniciar", async (req, res) => {
  try {
    // Trae todas estado = 0
    const { rows } = await pool.query(`
      SELECT numero_orden_compra, numero_solicitud, nombre_proveedor, total_neto, solicitante
      FROM doa2.cabecera_oc_pendientes
      WHERE estado_registro='A' AND estado_oc_id_esta = 0
      ORDER BY fecha_orden_compra DESC NULLS LAST
    `);

    if (rows.length === 0) return res.json({ ok: true, sent: 0, skipped: "sin_oc_estado_0" });

    // Destinatarios “iniciadores”
    const to = await getIniciadoresEmails();
    if (to.length === 0) return res.json({ ok: true, sent: 0, skipped: "sin_correo_iniciadores" });

    const t = {
      saludo: "Equipo de Compras,",
      asunto: "Órdenes de compra pendientes por iniciar",
      tabla: { oc: "Orden Compra", prov: "Proveedor", valor: "Valor", sol: "Solicitante" },
      intro: "Las siguientes órdenes de compra están en estado SIN INICIAR:",
    };

    const html = htmlTablaPendientes({
      titulo: t.asunto,
      saludo: t.saludo,
      intro: t.intro,
      items: rows,
      t: t.tabla,
    });

    // Adjuntar Excel si así lo piden vía query
    const attachExcel = String(req.query.attachExcel || "0") === "1";
    const attachments = [];
    if (attachExcel) {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("sin_iniciar");
      ws.columns = [
        { header: "Orden", key: "numero_orden_compra", width: 20 },
        { header: "Solicitud", key: "numero_solicitud", width: 20 },
        { header: "Proveedor", key: "nombre_proveedor", width: 40 },
        { header: "Total Neto", key: "total_neto", width: 18 },
        { header: "Solicitante", key: "solicitante", width: 30 },
      ];
      rows.forEach(r => ws.addRow(r));
      const buf = await wb.xlsx.writeBuffer();
      attachments.push({ filename: "oc_sin_iniciar.xlsx", content: Buffer.from(buf) });
    }

    const send = await sendHtmlMail({
      from: process.env.MAIL_FROM || "noreply-DOA@clarios.com",
      to,
      subject: t.asunto,
      html,
      attachments,
    }, mailCtx);

    res.json({ ok: true, sent: Array.isArray(send.to) ? send.to.length : 1, estado: 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

/* =========================================
   (lo que ya tenías) ENVÍO MASIVO CAMBIO DE ESTADO
========================================= */

async function enviarCambioEstadoMasivo() {
  const { rows } = await pool.query(`
    SELECT
      ha.id_hiau                           AS id_historial,
      ha.estado                            AS estado,
      ha.observacion                       AS observacion,
      co.id_cabe                           AS id_cabe,
      co.numero_orden_compra               AS numero_orden_compra,
      co.numero_solicitud                  AS numero_solicitud,
      co.email_solicitante                 AS mail_solicitante,
      co.centro_costo_id_ceco              AS id_ceco,
      la.tipo_autorizador_id_tiau          AS id_tiau,
      la.nivel_id_nive                     AS id_nive
    FROM doa2.historial_autorizacion ha
    JOIN doa2.cabecera_oc co ON co.id_cabe = ha.cabecera_oc_id_cabe
    LEFT JOIN doa2.lista_autorizaccion la ON la.cabecera_oc_id_cabe = co.id_cabe
    WHERE ha.estado_registro='A'
      AND co.estado_registro='A'
  `);

  let enviados = 0;

  for (const h of rows) {
    const correos = new Set();
    if (h.mail_solicitante) correos.add(h.mail_solicitante.trim());

    const auth = await pool.query(
      `SELECT p.email
       FROM doa2.autorizador a
       JOIN doa2.persona p ON p.id_pers = a.persona_id_pers
       WHERE a.estado_registro='A'
         AND p.estado_registro='A'
         AND a.centro_costo_id_ceco = $1
         AND a.tipo_autorizador_id_tiau = $2
         AND a.nivel_id_nive = $3`,
      [h.id_ceco, h.id_tiau, h.id_nive]
    );
    auth.rows.forEach((r) => r.email && correos.add(r.email.trim()));

    const emails = uniqueEmails(Array.from(correos));
    if (emails.length === 0) continue;

    const asunto = "Ordenes de Compra DOA";
    const mensaje = `
      <div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
        <p>Después de la revisión, la orden de compra <b>${h.numero_orden_compra || ""}</b>
        (solicitud <b>${h.numero_solicitud || ""}</b>) quedó en estado: <b>${h.estado || ""}</b>.</p>
        ${h.observacion ? `<p>Observación: ${h.observacion}</p>` : ""}
        <p style="margin-top:12px;color:#6b7280">DOA · Notificación automática</p>
      </div>
    `;

    await sendHtmlMail({
      from: process.env.MAIL_FROM || "noreply-DOA@clarios.com",
      to: emails,
      subject: asunto,
      html: mensaje,
    }, mailCtx);
    enviados++;
  }

  return { ok: true, enviados };
}

router.post("/envio/cambio-estado", async (req, res) => {
  try {
    const r = await enviarCambioEstadoMasivo();
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

/* ===========================
   3) REPORTE DE CONTINGENCIA
=========================== */

async function enviarReporteContingencia() {
  const { rows } = await pool.query(`
    SELECT numero_orden_compra, numero_solicitud, nombre_proveedor, total_neto, estado_oc_id_esta, fecha_orden_compra
    FROM doa2.cabecera_oc
    WHERE estado_registro='A'
    ORDER BY fecha_orden_compra DESC NULLS LAST
  `);
  const buf = await buildReporteContingencia(rows);

  const { rows: recips } = await pool.query(`
    SELECT email FROM doa2.persona
    WHERE estado_registro='A' AND email IS NOT NULL AND trim(email) <> ''
  `);
  const to = uniqueEmails(recips.map(r => r.email));
  if (to.length === 0) return { ok: true, skipped: "sin destinatarios" };

  const asunto = `Reporte de contingencia ${format(new Date(), "yyyy-MM-dd HH:mm")}`;
  const html = `<div style="font-family:Arial,sans-serif">Adjuntamos el reporte de contingencia con todas las OC.</div>`;

  await sendHtmlMail({
    from: process.env.MAIL_FROM || "noreply-DOA@clarios.com",
    to,
    subject: asunto,
    html,
    attachments: [{ filename: "reporte_contingencia.xlsx", content: buf }],
  }, mailCtx);

  return { ok: true, enviados: to.length };
}

router.post("/envio/reporte-contingencia", async (req, res) => {
  try {
    const r = await enviarReporteContingencia();
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

/* =====================================================
   4) CIERRE DE OCs INICIADAS ≥ 3 MESES + REPORTE XLSX
===================================================== */

// Adapter de QAD (placeholder)
async function actualizarEstadoQAD({ sistema, numero_orden_compra, estado, fecha, comentario }) {
  return { resultado: "Aceptado" };
}

// Cerrar OCs INICIADAS (1) en cabecera_oc_pendientes (≥ 3 meses)
async function cerrarOcsIniciadasTresMeses() {
  const { rows } = await pool.query(
    `
    SELECT
      cop.id_cabepen,
      cop.numero_orden_compra,
      cop.numero_solicitud,
      cop.sistema,
      cop.fecha_orden_compra,
      co.id_cabe AS id_cabe
    FROM doa2.cabecera_oc_pendientes cop
    LEFT JOIN doa2.cabecera_oc co
           ON co.estado_registro='A'
          AND co.numero_solicitud    = cop.numero_solicitud
          AND co.numero_orden_compra = cop.numero_orden_compra
    WHERE cop.estado_registro='A'
      AND cop.estado_oc_id_esta = 1           -- INICIADO
      AND cop.fecha_orden_compra IS NOT NULL
      AND cop.fecha_orden_compra <= $1
    ORDER BY cop.fecha_orden_compra
    `,
    [subMonths(new Date(), 3)]
  );

  if (rows.length === 0) {
    return { ok: true, cerradas: 0, errores: [], skipped: 'sin iniciadas ≥3m en pendientes' };
  }

  let cerradas = 0;
  const errores = [];
  const cerradasOk = [];

  for (const oc of rows) {
    const r = await actualizarEstadoQAD({
      sistema: oc.sistema,
      numero_orden_compra: oc.numero_orden_compra,
      estado: "C",
      fecha: "",
      comentario: "",
    });

    if (r?.resultado === "Aceptado") {
      if (oc.id_cabe) {
        await pool.query(
          `UPDATE doa2.cabecera_oc
             SET estado_oc_id_esta = 6,
                 fecha_modificacion = NOW(),
                 oper_modifica = 'JOB'
           WHERE id_cabe = $1`,
          [oc.id_cabe]
        );
      }

      await pool.query(
        `UPDATE doa2.cabecera_oc_pendientes
            SET estado_oc_id_esta = 6,
                fecha_modificacion = NOW(),
                oper_modifica = 'JOB'
          WHERE id_cabepen = $1`,
        [oc.id_cabepen]
      );

      cerradas++;
      cerradasOk.push({
        numero_orden_compra: oc.numero_orden_compra,
        numero_solicitud: oc.numero_solicitud,
        fecha_cierre: new Date(),
      });
    } else {
      errores.push(`${oc.numero_orden_compra}-${oc.numero_solicitud}`);
    }
  }

  const buf = await buildReporteCerradas3M(cerradasOk);
  const to = ["colombia-compras@clarios.com"];
  const asunto = "CIERRE DE POs INICIADAS SIN APROBAR";
  const html = `
    <div style="font-family:Arial,sans-serif">
      <p>Se han cancelado ${cerradas} órdenes.</p>
      <p>Errores en QAD: ${errores.length}</p>
      ${errores.length ? `<p>${errores.join(", ")}</p>` : ""}
    </div>
  `;

  await sendHtmlMail({
    from: process.env.MAIL_FROM || "noreply-DOA@clarios.com",
    to,
    subject: asunto,
    html,
    attachments: [{ filename: "reporte_canceladas_tarea_programada.xlsx", content: buf }],
  }, mailCtx);

  return { ok: true, cerradas, errores };
}

router.post("/tareas/cerrar-iniciadas-3m", async (req, res) => {
  try {
    const r = await cerrarOcsIniciadasTresMeses();
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

/* =========================================
   5) DESACTIVAR PERMISOS TEMPORALES VENCIDOS
========================================= */

async function desactivarPermisosTemporales() {
  const { rows } = await pool.query(`
    SELECT a.id_auto, p.id_pers, p.nombre, p.email
    FROM doa2.autorizador a
    JOIN doa2.persona p ON p.id_pers = a.persona_id_pers
    WHERE a.estado_registro='A'
      AND a.temporal='S'
      AND a.fecha_fin_temporal IS NOT NULL
      AND a.fecha_fin_temporal < NOW()
  `);

  if (rows.length === 0) return { ok: true, desactivados: 0 };

  const personas = new Map(); // id_pers -> {nombre,email}
  for (const r of rows) {
    await pool.query(
      `UPDATE doa2.autorizador
       SET estado_registro='I', temporal='I', fecha_modificacion=NOW(), oper_modifica='JOB'
       WHERE id_auto=$1`,
      [r.id_auto]
    );
    personas.set(r.id_pers, { nombre: r.nombre, email: r.email });
  }

  const admin = (await getParametro("CORREOS_ADMINISTRATIVOS")) || "";
  const comp = (await getParametro("CORREOS_COMPLIANCE")) || "";
  const adminList = admin.split(",").map(s => s.trim()).filter(Boolean);
  const compList = comp.split(",").map(s => s.trim()).filter(Boolean);

  for (const [, per] of personas.entries()) {
    const to = uniqueEmails([...adminList, ...compList, per.email]);
    const asunto = "Desactivación de permisos temporales";
    const html = `
      <div style="font-family:Arial,sans-serif">
        <p>Se informa que se han retirado los permisos temporales correspondientes al usuario <b>${per.nombre}</b>.</p>
        <p style="margin-top:12px;color:#6b7280">DOA · Notificación automática</p>
      </div>
    `;
    await sendHtmlMail({ from: process.env.MAIL_FROM || "noreply-DOA@clarios.com", to, subject: asunto, html }, mailCtx);
  }

  return { ok: true, desactivados: personas.size };
}

router.post("/tareas/desactivar-permisos-temporales", async (req, res) => {
  try {
    const r = await desactivarPermisosTemporales();
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

export default router;
