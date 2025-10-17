import nodemailer from 'nodemailer';

/** ====== TÚ mailer original (se respeta) ====== */
export function createTransporter() {
  const host = process.env.SMTP_HOST || 'localhost';
  const port = Number(process.env.SMTP_PORT || 25);
  const secure = String(process.env.SMTP_SECURE || 'false') === 'true';
  const useAuth = String(process.env.SMTP_AUTH || 'false') === 'true';

  /** Config base (sin TLS, sin auth por defecto) */
  const transporterOptions = {
    host,
    port,
    secure, // en 25 debe ser false
    // tls: { rejectUnauthorized: false }, // <- descomenta solo si el relay usa certs internos/autofirmados
  };

  if (useAuth) {
    transporterOptions.auth = {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    };
  }

  const transporter = nodemailer.createTransport(transporterOptions);
  return transporter;
}

export function getDefaultFrom() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || undefined;
}

/** ====== utilidades nuevas, sin romper nada ====== */

// dedup & saneo
function uniq(list) {
  return Array.from(new Set((list || [])
    .filter(Boolean)
    .map(s => String(s).trim())
    .filter(Boolean)));
}

function normalizeAttachments(attachments) {
  return Array.isArray(attachments) ? attachments : (attachments ? [attachments] : []);
}

/**
 * Resuelve parámetros de “modo PRUEBA” y “destinatarios de prueba”.
 * - Permite inyectar un paramResolver asíncrono (ideal para leer de doa2.parametros).
 * - Si no lo pasas, cae a process.env (ES_PRUEBA / CORREO_COPIA_PRUEBA / MASSIVE_EMAIL_CP).
 */
async function resolveTestMode(paramResolver) {
  const getParam = paramResolver || (async k => process.env[k] || null);

  // ES_PRUEBA: 'S' para activar
  const esPruebaRaw =
    (await getParam('ES_PRUEBA')) ??
    process.env.ES_PRUEBA ??
    null;

  const esPrueba = String(esPruebaRaw || '')
    .trim()
    .toUpperCase() === 'S';

  // Copias de prueba
  const copiaRaw =
    (await getParam('CORREO_COPIA_PRUEBA')) ??
    process.env.CORREO_COPIA_PRUEBA ?? '';

  const massiveRaw =
    (await getParam('MASSIVE_EMAIL_CP')) ??
    process.env.MASSIVE_EMAIL_CP ?? '';

  const copia = uniq(String(copiaRaw).split(','));
  const massive = uniq(String(massiveRaw).split(','));

  return { esPrueba, copia, massive };
}

/**
 * Espera ms
 */
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

/**
 * Helper principal para enviar correos.
 *
 * @param {Object} opts
 *   - from, to (array|string), cc, bcc
 *   - subject, html, text
 *   - attachments (array)
 * @param {Object} ctx
 *   - transporter: si no lo pasas, usa createTransporter()
 *   - paramResolver: async (key) => valor | null  (para leer doa2.parametros)
 *   - requireDoubleCheck: default true -> si NO está en PRUEBA, espera 3min y revalida
 */
export async function sendMail(opts, ctx = {}) {
  const {
    from,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    attachments,
  } = opts || {};

  const transporter = ctx.transporter || createTransporter();
  const { esPrueba, copia } = await resolveTestMode(ctx.paramResolver);

  let finalSubject = subject || '';
  let finalTo  = uniq(Array.isArray(to) ? to : (to ? [to] : []));
  let finalCc  = uniq(Array.isArray(cc) ? cc : (cc ? [cc] : []));
  let finalBcc = uniq(Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []));
  const finalFrom = from || getDefaultFrom();

  // === MODO PRUEBA ===
  if (esPrueba) {
    finalSubject = `[PRUEBA] ${finalSubject}`;
    if (copia.length === 0) {
      return { skipped: true, reason: 'PRUEBA_sin_destinatarios' };
    }
    finalTo = copia; // SOLO a copias
    finalCc = [];
    finalBcc = [];
  } else {
    // === DOBLE CHEQUEO 3 MIN ===
    const requireDoubleCheck = ctx.requireDoubleCheck !== false;
    if (requireDoubleCheck) {
      const windowMs = Number(process.env.MAIL_DOUBLECHECK_MS || 180000); // 3 min default
      await sleep(windowMs);
      const again = await resolveTestMode(ctx.paramResolver);
      if (again.esPrueba) {
        // Se activó PRUEBA en la ventana -> evitar envío real
        const subj = `[PRUEBA_ACTIVADA_EN_VENTANA] ${finalSubject}`;
        if (again.copia.length === 0) {
          return { skipped: true, reason: 'PRUEBA_activada_sin_destinatarios' };
        }
        await transporter.sendMail({
          from: finalFrom,
          to: again.copia,
          subject: subj,
          ...(html ? { html } : {}),
          ...(text ? { text } : {}),
          attachments: normalizeAttachments(attachments),
        });
        return { ok: true, to: again.copia, subject: subj, doubleChecked: true };
      }
    }
  }

  if (finalTo.length === 0) {
    return { skipped: true, reason: 'sin_destinatarios' };
  }

  const mail = {
    from: finalFrom,
    to: finalTo,
    subject: finalSubject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    cc: finalCc.length ? finalCc : undefined,
    bcc: finalBcc.length ? finalBcc : undefined,
    attachments: normalizeAttachments(attachments),
  };

  await transporter.sendMail(mail);
  return { ok: true, to: finalTo, subject: finalSubject };
}

/** Azúcar: SOLO HTML */
export async function sendHtmlMail({ from, to, cc, bcc, subject, html, attachments }, ctx = {}) {
  return sendMail({ from, to, cc, bcc, subject, html, attachments }, ctx);
}
