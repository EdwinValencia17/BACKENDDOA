// src/routes/gestiondetalles-oc.js
import express from "express";
import pool from "../../config/db.js";
import multer from "multer";
import path from "path";
import { sendHtmlMail } from "../../lib/mailer.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() }); // guardamos en memoria para BYTEA

/* ========= helpers ========= */
const extOf = (name = "") =>
  (path.extname(String(name)).replace(".", "") || "").toLowerCase();

const safe = (v) => (v ?? "").toString().trim();

// === Parametría para que el mailer unificado lea doa2.parametros ===
async function getParametro(valor) {
  const { rows } = await pool.query(
    `SELECT valor FROM doa2.parametros WHERE parametro = $1 AND estado_registro = 'A' LIMIT 1`,
    [valor]
  );
  return rows[0]?.valor?.trim() || null;
}
const mailCtx = { paramResolver: getParametro };

const who = (req) => String(req.headers["x-user"] || "web");

// --- Catálogo de tipos de póliza
router.get("/polizas", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        tp.id_tipo     AS "id",
        tp.descripcion AS "label",
        tp.porcentaje  AS "porcentaje",
        tp.posicion    AS "posicion"
      FROM doa2.tipo_poliza tp
      WHERE tp.estado_registro = 'A'
      ORDER BY COALESCE(tp.posicion, 999), tp.descripcion
    `);
    res.json(rows);
  } catch (e) {
    console.error("[GET /polizas]", e);
    res.status(500).json({ error: "Error obteniendo tipos de póliza" });
  }
});

// --- Leer flags + selección real de la OC ACTIVA
router.get("/ordenes/:id/poliza", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  try {
    // Flags desde cabecera_oc (ACTIVA)
    const cab = await pool.query(`
      SELECT
        COALESCE(c.requiere_poliza,'N')   AS "requiere_poliza",
        COALESCE(c.requiere_contrato,'N') AS "requiere_contrato"
      FROM doa2.cabecera_oc c
      WHERE c.id_cabe = $1::bigint
      LIMIT 1
    `, [id]);
    if (!cab.rows.length) return res.status(404).json({ error: "OC no encontrada" });

    // Selección real en tipo_poliza_x_oc (ACTIVA) + label
    const sel = await pool.query(`
      SELECT
        x.tipo_poliza_id_tipo            AS "tipoId",
        tp.descripcion                   AS "tipo",
        COALESCE(x.porcentaje,0)::numeric AS "porcentaje"
      FROM doa2.tipo_poliza_x_oc x
      JOIN doa2.tipo_poliza tp ON tp.id_tipo = x.tipo_poliza_id_tipo
      WHERE x.estado_registro = 'A'
        AND x.cabecera_oc_id_cabe = $1::bigint
      ORDER BY COALESCE(tp.posicion, 999), tp.descripcion
    `, [id]);

    res.json({
      requierePoliza:   cab.rows[0].requiere_poliza === "S",
      requiereContrato: cab.rows[0].requiere_contrato === "S",
      seleccion: sel.rows,
    });
  } catch (e) {
    console.error("[GET /ordenes/:id/poliza]", e);
    res.status(500).json({ error: "Error leyendo póliza/contrato" });
  }
});

// --- Guardar flags + selección para OC ACTIVA
router.put("/ordenes/:id/poliza", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const requierePoliza   = !!req.body?.requierePoliza;
  const requiereContrato = !!req.body?.requiereContrato;
  const tipos            = Array.isArray(req.body?.tipos) ? req.body.tipos : [];
  const user = who(req);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout='45s'; SET LOCAL lock_timeout='5s';`);

    // 1) Flags en cabecera_oc (ACTIVA)
    await client.query(`
      UPDATE doa2.cabecera_oc
         SET requiere_poliza   = $2,
             requiere_contrato = $3,
             fecha_modificacion = NOW(),
             oper_modifica = $4
       WHERE id_cabe = $1::bigint
    `, [id, requierePoliza ? "S" : "N", requiereContrato ? "S" : "N", user]);

    // 2) Inactivar selección previa (histórico) en tipo_poliza_x_oc
    await client.query(`
      UPDATE doa2.tipo_poliza_x_oc
         SET estado_registro = 'I',
             fecha_modificacion = NOW(),
             oper_modifica = $2
       WHERE cabecera_oc_id_cabe = $1::bigint
         AND estado_registro = 'A'
    `, [id, user]);

    // 3) Insertar nueva selección (si viene)
    for (const t of tipos) {
      const tipoId = Number(t?.tipoId);
      if (!Number.isFinite(tipoId)) continue;
      const pct = Number(t?.porcentaje);
      await client.query(`
        INSERT INTO doa2.tipo_poliza_x_oc
          (porcentaje, fecha_creacion, oper_creador, estado_registro,
           tipo_poliza_id_tipo, cabecera_oc_id_cabe, cabecera_oc_pendientes_id_cabe)
        VALUES
          ($1::numeric, NOW(), $2, 'A',
           $3::bigint, $4::bigint, NULL)
      `, [Number.isFinite(pct) ? pct : 0, user, tipoId, id]);
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[PUT /ordenes/:id/poliza]", e);
    res.status(500).json({ error: "Error guardando póliza/contrato" });
  } finally {
    client.release();
  }
})
/* =========================================================
   ADJUNTOS EN BD (doa2.archivos_adjuntos)
   - Subir (BYTEA)
   - Listar
   - Descargar
   - Eliminar (soft)
========================================================= */

// SUBIR: multipart/form-data con campo "files"
router.post("/ordenes/:id/adjuntos", upload.array("files", 12), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });
  if (!req.files?.length) return res.status(400).json({ error: "Sin archivos" });

  try {
    const inserted = [];
    for (const f of req.files) {
      const nombre = safe(f.originalname);
      const extension = extOf(nombre);
      const buffer = f.buffer;

      const { rows } = await pool.query(
        `INSERT INTO doa2.archivos_adjuntos
           (nombre_archivo, ubicacion, fecha_creacion, oper_creador,
            estado_registro, cabecera_oc_pendientes_id_cabe, archivo, "extension")
         VALUES ($1, NULL, NOW(), 'web', 'A', $2::bigint, $3, $4)
         RETURNING id_arad, nombre_archivo, "extension",
                   octet_length(archivo) AS size, fecha_creacion`,
        [nombre, id, buffer, extension]
      );
      inserted.push(rows[0]);
    }
    res.json({ ok: true, files: inserted });
  } catch (e) {
    console.error("[POST /ordenes/:id/adjuntos]", e);
    res.status(500).json({ error: "Error subiendo adjuntos" });
  }
});

// LISTAR
router.get("/ordenes/:id/adjuntos", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });
  try {
    const { rows } = await pool.query(
      `SELECT id_arad, nombre_archivo, "extension",
              octet_length(archivo) AS size, fecha_creacion
       FROM doa2.archivos_adjuntos
       WHERE cabecera_oc_pendientes_id_cabe = $1::bigint
         AND estado_registro = 'A'
       ORDER BY fecha_creacion DESC, id_arad DESC`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error("[GET /ordenes/:id/adjuntos]", e);
    res.status(500).json({ error: "Error listando adjuntos" });
  }
});

// DESCARGAR
router.get("/ordenes/:id/adjuntos/:adjId/download", async (req, res) => {
  const id = Number(req.params.id);
  const adjId = Number(req.params.adjId);
  if (!Number.isFinite(id) || !Number.isFinite(adjId))
    return res.status(400).json({ error: "Parámetros inválidos" });

  try {
    const { rows } = await pool.query(
      `SELECT nombre_archivo, archivo, "extension"
       FROM doa2.archivos_adjuntos
       WHERE id_arad = $1::bigint
         AND cabecera_oc_pendientes_id_cabe = $2::bigint
         AND estado_registro = 'A'
       LIMIT 1`,
      [adjId, id]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Archivo no encontrado" });

    const ext = (r.extension || "").toLowerCase();
    const name = r.nombre_archivo || `archivo.${ext || "bin"}`;

    const map = {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
      txt: "text/plain",
      csv: "text/csv",
      zip: "application/zip",
      rar: "application/vnd.rar",
      msg: "application/vnd.ms-outlook",
      eml: "message/rfc822",
    };
    res.setHeader("Content-Type", map[ext] || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}"`);
    res.send(r.archivo);
  } catch (e) {
    console.error("[GET /download adjunto]", e);
    res.status(500).json({ error: "Error descargando adjunto" });
  }
});

// ELIMINAR (soft)
router.delete("/ordenes/:id/adjuntos/:adjId", async (req, res) => {
  const id = Number(req.params.id);
  const adjId = Number(req.params.adjId);
  if (!Number.isFinite(id) || !Number.isFinite(adjId))
    return res.status(400).json({ error: "Parámetros inválidos" });

  try {
    const { rowCount } = await pool.query(
      `UPDATE doa2.archivos_adjuntos
         SET estado_registro = 'I', fecha_modificacion = NOW(), oper_modifica = 'web'
       WHERE id_arad = $1::bigint
         AND cabecera_oc_pendientes_id_cabe = $2::bigint
         AND estado_registro = 'A'`,
      [adjId, id]
    );
    if (!rowCount) return res.status(404).json({ error: "No encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE adjunto]", e);
    res.status(500).json({ error: "Error eliminando adjunto" });
  }
});

/* =========================================================
   ENVIAR CORREO AL PROVEEDOR (adjuntos desde BD)
   body: { to?, cc?, subject?, html?, attachAll?:boolean, adjIds?: number[] }
========================================================= */
router.post("/ordenes/:id/enviar-po", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  try {
    const cab = await getCabPend(id);
    if (!cab) return res.status(404).json({ error: "OC no encontrada" });

    const {
      to,
      cc,
      subject,
      html,
      attachAll,
      adjIds = [],
    } = req.body || {};

    const emailTo = (to ?? cab.email_proveedor ?? "").toString().trim();
    if (!emailTo) return res.status(400).json({ error: "Falta correo (to)" });

    // ------- Adjuntos desde BD -------
    let q, params;
    if (attachAll) {
      q = `SELECT id_arad, nombre_archivo, archivo
           FROM doa2.archivos_adjuntos
           WHERE cabecera_oc_pendientes_id_cabe = $1::bigint AND estado_registro='A'
           ORDER BY fecha_creacion DESC`;
      params = [id];
    } else if (Array.isArray(adjIds) && adjIds.length) {
      q = `SELECT id_arad, nombre_archivo, archivo
           FROM doa2.archivos_adjuntos
           WHERE cabecera_oc_pendientes_id_cabe = $1::bigint
             AND id_arad = ANY($2::bigint[])
             AND estado_registro='A'`;
      params = [id, adjIds];
    } else {
      // sin adjuntos
      q = `SELECT id_arad, nombre_archivo, archivo
           FROM doa2.archivos_adjuntos
           WHERE cabecera_oc_pendientes_id_cabe = $1::bigint AND estado_registro='A'
           ORDER BY fecha_creacion DESC LIMIT 0`;
      params = [id];
    }

    const { rows: adj } = await pool.query(q, params);
    const attachments = adj.map(r => ({
      filename: r.nombre_archivo || "adjunto",
      content: r.archivo,
    }));

    // ------- Personalización -------
    const provNombre = (cab.nombre_proveedor ?? "").toString().trim();
    const provNit = (cab.nit_proveedor ?? "").toString().trim();
    const nroOC = (cab.numero_orden_compra ?? "").toString().trim();

    const defaultSubject =
      `OC ${nroOC}${provNombre ? ` - ${provNombre}` : ""}${provNit ? ` (NIT ${provNit})` : ""}`;

    const defaultHtml = `
      <div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#222">
        <p>Estimad${provNombre ? "@" : "o/a"} ${provNombre || "proveedor"},</p>
        <p>Adjuntamos la <strong>Orden de Compra ${nroOC} ha sido iniciada</strong>.</p>
        ${provNit ? `<p><strong>NIT proveedor:</strong> ${provNit}</p>` : ""}
        <p>Saludos cordiales.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
        <div style="font-size:12px;color:#666">
          <div>Este es un mensaje generado automáticamente por DOA.</div>
        </div>
      </div>
    `;

    // Enviar respetando ES_PRUEBA / CORREO_COPIA_PRUEBA (desde doa2.parametros)
    const mail = await sendHtmlMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: emailTo,
      cc: (cc ?? "").toString().trim() || undefined,
      subject: subject || defaultSubject,
      html: html || defaultHtml,
      attachments,
    }, mailCtx);

    await pool.query(
      `UPDATE doa2.cabecera_oc_pendientes
         SET envio_correo = 'S', fecha_modificacion = NOW()
       WHERE id_cabepen = $1::bigint`,
      [id]
    );

    res.json({ ok: true, messageId: mail?.messageId || null });
  } catch (e) {
    console.error("[POST /ordenes/:id/enviar-po]", e);
    res.status(500).json({ error: "Error enviando correo" });
  }
});


/* =========================================================
   CAMPOS SIMPLES DE CABECERA (observaciones, gestionada…)
========================================================= */
router.patch("/ordenes/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const { observaciones, observacionCompras, ordenGestionada } = req.body || {};
  const sets = [];
  const vals = [];
  const ph = (v) => {
    vals.push(v);
    return `$${vals.length}`;
  };

  if (observaciones !== undefined) sets.push(`observaciones = ${ph(observaciones)}`);
  if (observacionCompras !== undefined) sets.push(`observacion_compras = ${ph(observacionCompras)}`);
  if (ordenGestionada !== undefined) sets.push(`orden_gestionada = ${ph(ordenGestionada ? "S" : "N")}`);

  if (!sets.length) return res.json({ ok: true, noop: true });

  try {
    await pool.query(
      `UPDATE doa2.cabecera_oc_pendientes
         SET ${sets.join(", ")}, fecha_modificacion = NOW()
       WHERE id_cabepen = ${ph(id)}::bigint`,
      vals
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("[PATCH /ordenes/:id]", e);
    res.status(500).json({ error: "Error actualizando cabecera" });
  }
});

export default router;
