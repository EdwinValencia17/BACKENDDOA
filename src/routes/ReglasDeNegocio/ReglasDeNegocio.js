// 💜 Backend — DOA Reglas de Negocio (ESM)

import express from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import authMiddleware from "../../middlewares/auth.middleware.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

/* =============== Utils base =============== */
const PARAM_NAME = "REGLAS_OC"; // donde persistimos la matriz importada

const S = (v) => String(v ?? "").trim();
const U = (v) => S(v).toUpperCase();
const NORM = (v) =>
  S(v)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,;:]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
const NOW_ISO = () => new Date().toISOString();

// ⛑️ la que faltaba
const toNumber = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const parseNivelNum = (n) => {
  const s = S(n);
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : Number.POSITIVE_INFINITY;
};

const dedupeSteps = (arr = []) => {
  const seen = new Set(), out = [];
  for (const a of arr || []) {
    const tipo = U(a?.tipo || "");
    const nivel = S(a?.nivel || "");
    if (!tipo || !nivel) continue;
    const k = `${tipo}|${nivel}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ tipo, nivel });
  }
  return out;
};
const sortSteps = (arr = []) =>
  [...arr].sort(
    (a, b) => parseNivelNum(a.nivel) - parseNivelNum(b.nivel) || S(a.nivel).localeCompare(S(b.nivel))
  );

/* =============== Helpers auth =============== */
const readVerTodo = (req) =>
  String((req.query?.verTodo ?? req.body?.verTodo ?? req.headers["x-ver-todo"]) ?? "N").toUpperCase() === "S";

async function authOrSuper(req, res, next) {
  try {
    if (readVerTodo(req)) { req.user = req.user || { globalId: "SUPER" }; return next(); }
    return authMiddleware(req, res, next);
  } catch (e) { next(e); }
}
async function adminOrSuper(req, res, next) {
  try {
    if (readVerTodo(req)) { req.user = req.user || { globalId: "SUPER" }; return next(); }
    return authMiddleware(req, res, next);
  } catch (e) { next(e); }
}

/* =============== Introspección simple de columnas =============== */
async function hasColumn(schema, table, column, client = pool) {
  const { rows } = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 AND column_name=$3
      LIMIT 1`,
    [schema, table, column]
  );
  return rows.length > 0;
}

/* =============== Acceso a BD “tal cual” =============== */
async function existsCentro(codigo, client = pool) {
  await client.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
  const { rows } = await client.query(
    `SELECT 1
       FROM doa2.centro_costo
      WHERE estado_registro='A' AND UPPER(TRIM(codigo))=UPPER(TRIM($1))
      LIMIT 1`,
    [codigo]
  );
  return rows.length > 0;
}
async function existsCategoria(nombre, client = pool) {
  await client.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
  const { rows } = await client.query(
    `SELECT 1
       FROM doa2.categoria
      WHERE estado_registro='A'
        AND (UPPER(TRIM(categoria))=UPPER(TRIM($1)) OR UPPER(TRIM(descripcion))=UPPER(TRIM($1)))
      LIMIT 1`,
    [nombre]
  );
  return rows.length > 0;
}
async function getTipos(client = pool) {
  await client.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
  const { rows } = await client.query(
    `SELECT UPPER(TRIM(codigo)) AS v
       FROM doa2.tipo_autorizador
      WHERE estado_registro='A'
      ORDER BY v`
  );
  return rows.map(r => r.v);
}
async function getNiveles(client = pool) {
  await client.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
  const { rows } = await client.query(
    `SELECT UPPER(TRIM(nivel)) AS v
       FROM doa2.nivel
      WHERE estado_registro='A'
      ORDER BY v`
  );
  return rows.map(r => r.v);
}

/* ------ autorizadores: batch ------ */
function kStep(a){ return `${U(a.tipo)}|${S(a.nivel)}`; }
// ------ autorizadores: batch (preferir por centro-ID y dedupe) ------


async function findAutorizadoresBatch(steps, centroCodigo, client = pool) {
  if (!steps?.length) return new Map();
  const tipos   = [...new Set(steps.map(s => U(s.tipo)))];
  const niveles = [...new Set(steps.map(s => S(s.nivel)))];

  // resolver id del centro (por código)
  let idCentro = null;
  if (centroCodigo) {
    const r = await client.query(
      `SELECT id_ceco AS id
         FROM doa2.centro_costo
        WHERE estado_registro='A' AND UPPER(TRIM(codigo))=UPPER(TRIM($1))
        LIMIT 1`,
      [centroCodigo]
    );
    idCentro = r.rows[0]?.id ?? null;
  }

  const params = [];
  let where = `
    a.estado_registro='A'
    AND t.codigo = ANY($${params.push(tipos)})
    AND n.nivel  = ANY($${params.push(niveles)})
    AND (a.temporal IS NULL OR a.temporal <> 'S'
         OR (now() BETWEEN COALESCE(a.fecha_inicio_temporal, now()) AND COALESCE(a.fecha_fin_temporal, now())))
  `;
  if (idCentro) {
    // preferir los del centro; si no hay, tomar globales (NULL)
    where += ` AND (a.centro_costo_id_ceco = $${params.push(idCentro)} OR a.centro_costo_id_ceco IS NULL)`;
  }

  await client.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
  const { rows } = await client.query(
    `SELECT t.codigo AS tipo, n.nivel AS nivel,
            p.id_pers, p.identificacion, p.nombre, p.email,
            CASE WHEN a.centro_costo_id_ceco IS NULL THEN 1 ELSE 0 END AS prioridad
       FROM doa2.autorizador a
       JOIN doa2.tipo_autorizador t ON t.id_tiau=a.tipo_autorizador_id_tiau AND t.estado_registro='A'
       JOIN doa2.nivel n            ON n.id_nive=a.nivel_id_nive           AND n.estado_registro='A'
       JOIN doa2.persona p          ON p.id_pers=a.persona_id_pers         AND p.estado_registro='A'
      WHERE ${where}
      ORDER BY prioridad ASC, p.nombre`,
    params
  );

  const map = new Map();
  for (const r of rows) {
    const k = `${U(r.tipo)}|${S(r.nivel)}`;
    let arr = map.get(k);
    if (!arr) map.set(k, (arr = []));
    // dedupe por persona (puede salir por centro y global)
    if (!arr.some(x => x.id === String(r.id_pers))) {
      arr.push({ id: String(r.id_pers), globalId: r.identificacion, nombre: r.nombre, email: r.email });
    }
  }
  return map;
}

/* =============== Persistencia de MATRIZ (parametros) =============== */
async function loadRulesParam(client = pool) {
  await client.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
  const { rows } = await client.query(
    `SELECT valor
       FROM doa2.parametros
      WHERE parametro=$1 AND estado_registro='A'
      LIMIT 1`,
    [PARAM_NAME]
  );
  if (!rows.length) return { version: 1, updatedAt: NOW_ISO(), reglas: [] };
  try {
    const data = JSON.parse(rows[0].valor || "{}");
    data.reglas = Array.isArray(data.reglas) ? data.reglas : [];
    return data;
  } catch {
    return { version: 1, updatedAt: NOW_ISO(), reglas: [] };
  }
}
async function saveRulesParam(obj, user = "SYSTEM", client = pool) {
  const payload = JSON.stringify({
    version: Number(obj.version || 1),
    updatedAt: NOW_ISO(),
    reglas: Array.isArray(obj.reglas) ? obj.reglas : [],
  });
  const oper = (S(user) || "SYSTEM").slice(0, 10);

  await client.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
  const upd = await client.query(
    `UPDATE doa2.parametros
        SET valor=$2, fecha_creacion=now(), oper_creador=$3, estado_registro='A'
      WHERE parametro=$1`,
    [PARAM_NAME, payload, oper]
  );
  if (upd.rowCount > 0) return;

  try {
    await client.query(
      `INSERT INTO doa2.parametros (parametro, valor, fecha_creacion, oper_creador, estado_registro)
       VALUES ($1,$2,now(),$3,'A')`,
      [PARAM_NAME, payload, oper]
    );
  } catch (e) {
    if (e && e.code === "23505") {
      await client.query(
        `UPDATE doa2.parametros
            SET valor=$2, fecha_creacion=now(), oper_creador=$3, estado_registro='A'
          WHERE parametro=$1`,
        [PARAM_NAME, payload, oper]
      );
      return;
    }
    throw e;
  }
}

/* =============== Endpoints =============== */

// Catálogos “tipo y nivel”
router.get("/reglasdn/catalogos", authOrSuper, async (_req, res) => {
  try {
    const [tipos, niveles] = await Promise.all([getTipos(), getNiveles()]);
    res.json({ tipos, niveles });
  } catch (e) {
    console.error("GET /reglasdn/catalogos", e);
    res.json({ tipos: [], niveles: [] });
  }
});

// Centros desde BD
router.get("/reglasdn/centros", authOrSuper, async (_req, res) => {
  try {
    // 1) mapa centro -> compania (desde el parámetro REGLAS_OC)
    const data = await loadRulesParam();
    const compByCc = new Map();
    for (const r of (data.reglas || [])) {
      const cc  = U(r?.centroCosto);
      const cmp = S(r?.compania || "");
      if (!cc) continue;
      if (cmp && !compByCc.has(cc)) compByCc.set(cc, cmp); // primer valor gana
    }

    // 2) traemos descripciones de los centros que aparecen en reglas
    const codes = [...compByCc.keys()];
    let rows = [];
    if (codes.length) {
      await pool.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
      const { rows: rs } = await pool.query(
        `SELECT TRIM(codigo) AS codigo,
                COALESCE(TRIM(descripcion),'') AS descripcion
           FROM doa2.centro_costo
          WHERE estado_registro='A'
            AND TRIM(codigo)<>'' 
            AND UPPER(TRIM(codigo)) = ANY($1::text[])`,
        [codes]
      );
      rows = rs;
    } else {
      // fallback: si aún no hay reglas, lista todos los centros (sin compañía)
      const { rows: rs } = await pool.query(
        `SELECT TRIM(codigo) AS codigo,
                COALESCE(TRIM(descripcion),'') AS descripcion
           FROM doa2.centro_costo
          WHERE estado_registro='A' AND TRIM(codigo)<>''
          ORDER BY 1`
      );
      rows = rs;
    }

    const out = rows
      .map(r => ({
        centroCosto: U(r.codigo || ''),
        descripcion: String(r.descripcion || ''),
        compania: compByCc.get(U(r.codigo || '')) || ''
      }))
      .sort((a,b) => a.centroCosto.localeCompare(b.centroCosto));

    res.json(out);
  } catch (e) {
    console.error("GET /reglasdn/centros", e);
    res.status(500).json({ error: "No se pudieron listar centros" });
  }
});

// Categorías desde BD
router.get("/reglasdn/categorias", authOrSuper, async (_req, res) => {
  try {
    await pool.query(`SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';`);
    const { rows } = await pool.query(
      `SELECT id_cate AS id, categoria, COALESCE(descripcion,'') AS descripcion
         FROM doa2.categoria
        WHERE estado_registro='A'
        ORDER BY categoria`
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /reglasdn/categorias", e);
    res.status(500).json({ error: "No se pudieron listar categorías" });
  }
});

// Listar reglas (usa min del Excel, orden min→max)
// Listar reglas (usa min del Excel, orden min→max) con ETag por representación
router.get("/reglasdn/reglas", authOrSuper, async (req, res) => {
  try {
    const data = await loadRulesParam();

    // Parámetros de la representación solicitada
    const centro   = U(req.query.centro || "");
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(200, parseInt(req.query.pageSize, 10) || 20));

    // ETag dependiente de: última actualización + centro + paginación
    const etagKey = `${data.updatedAt || ""}|${centro}|${page}|${pageSize}`;
    const etag    = `"${Buffer.from(etagKey).toString("base64")}"`;

    // Si el cliente ya tiene esta misma representación, respondemos 304
    if (req.headers["if-none-match"] === etag) {
      res.setHeader("ETag", etag);
      return res.status(304).end();
    }

    // Construimos el dataset
    const rowsAll = (data.reglas || [])
      .map(r => ({
        id: S(r.id),
        reglaNegocio: U(r.reglaNegocio || "INDIRECT"),
        centroCosto: U(r.centroCosto),
        compania: S(r.compania || ""),
        categoria: U(r.categoria || ""),
        minExp: Number(r.minExp || 0),
        montoMax: Number(r.montoMax || 0),
        aprobadores: sortSteps(dedupeSteps(Array.isArray(r.aprobadores) ? r.aprobadores : [])),
        vigente: r.vigente !== false,
        updatedAt: r.updatedAt || NOW_ISO(),
        ccNivel: S(r.ccNivel || "")
      }))
      .filter(r => (centro ? r.centroCosto === centro : true));

    rowsAll.sort((a,b) => {
      if (a.centroCosto !== b.centroCosto) return a.centroCosto.localeCompare(b.centroCosto);
      if (a.categoria   !== b.categoria)   return a.categoria.localeCompare(b.categoria);
      if (a.minExp      !== b.minExp)      return a.minExp - b.minExp;
      return a.montoMax - b.montoMax;
    });

    const total  = rowsAll.length;
    const offset = (page - 1) * pageSize;
    const slice  = rowsAll.slice(offset, offset + pageSize).map(r => ({ ...r, __min: r.minExp }));

    // Devolvemos ETag de esta representación
    res.setHeader("ETag", etag);
    res.json({ rows: slice, total });
  } catch (e) {
    console.error("GET /reglasdn/reglas", e);
    res.status(500).json({ error: "No se pudieron listar reglas" });
  }
});



// ====== Importar matriz de Reglas de Negocio (Excel) ======
router.post("/reglasdn/import", adminOrSuper, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Falta archivo" });

    const OPEN_MAX = Number.MAX_SAFE_INTEGER;  9007199254740991
    const TIPOS_DB = await getTipos();        // ej: ['COMPRAS', 'FINANZAS', ...]

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: "El Excel no tiene hojas" });

    // Cabeceras mínimas que debo encontrar (en cualquier orden)
    const MUST = [
      "REGLAS DE NEGOCIO",
      "SI LA CATEGORIA ES",
      "SI EL VALOR DE LA ORDEN DE COMPRA ES MAYOR O IGUAL A",
      "SI EL VALOR DE LA ORDEN DE COMPRA ES MENOR O IGUAL A",
      "SI EL CENTRO DE COSTO ES",
      "EL TIPO DE AUTORIZADOR Y NIVEL AUTORIZADOR ES",
    ];

    // === localizar fila de cabeceras y mapear columnas ===
    const headerMap = new Map();
    let headerRowIdx = 1;
    for (let r = 1; r <= Math.min(ws.rowCount, 30); r++) {
      const row = ws.getRow(r);
      const texts = row.values.filter(v => typeof v !== "object").map(NORM).filter(Boolean);
      if (texts.length && MUST.every(m => texts.some(x => x.includes(NORM(m))))) {
        headerRowIdx = r;
        row.eachCell((cell, c) => { const key = NORM(cell.value); if (key) headerMap.set(c, key); });
        break;
      }
    }
    if (headerMap.size === 0) return res.status(400).json({ error: "No encontré la fila de cabeceras" });

    const H = (row, ...aliases) => {
      for (const [c, text] of headerMap.entries()) {
        const u = NORM(text);
        for (const a of aliases) {
          const ua = NORM(a);
          if (u.includes(ua) || ua.includes(u)) {
            return String(row.getCell(c).value ?? "").trim();
          }
        }
      }
      return "";
    };

    const AL = {
      reglaNegocio: "Reglas de negocio",
      categoria: "Si la categoria es",
      min: "Si el valor de la orden de compra es mayor o igual a",
      max: "Si el valor de la orden de compra es menor o igual a",
      cc:  "Si el centro de costo es",
      combCcNivel: "El centro de costo y nivel autorizador es",
      combTipoNivelBase: "El tipo de autorizador y nivel autorizador es",
      vigente: "vigente",
      compania: "Compañia", // (si tu Excel usa "Compañia", NORM lo normaliza igual)
    };

    // === detectar columnas "tipo y nivel" (dinámicas por cada tipo en BD) ===
    const tipoNivelCols = [];
    for (const [c, text] of headerMap.entries()) {
      const u = NORM(text);
      if (u.includes(NORM(AL.combTipoNivelBase))) {
        const found = (TIPOS_DB || []).find(t => u.endsWith(NORM(t)) || u.includes(` ${NORM(t)}`));
        tipoNivelCols.push({ col: c, expectedTipo: found });
      }
    }

    const parseTipoNivel = (raw) => {
      const s = NORM(raw).replace(/\s+/g, " ").trim();
      if (!s) return null;
      let m = s.match(/^([A-Z0-9 ÁÉÍÓÚÑ]+?)[\s,:\-–]*([0-9]+)\s*$/);
      if (m) return { tipo: NORM(m[1]), nivel: String(m[2]) };
      m = s.match(/^([A-Z0-9 ÁÉÍÓÚÑ]+?)[\s,:\-–]+([A-Z0-9 ]{2,})$/);
      if (m) return { tipo: NORM(m[1]), nivel: NORM(m[2]) };
      if (/^[0-9]+$/.test(s) || /^[A-Z0-9 ]{2,}$/.test(s)) return { nivel: s };
      return null;
    };

    const parsed = [];

    // === recorrer filas de datos ===
    for (let r = headerRowIdx + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);

      const reglaNegocio = NORM(H(row, AL.reglaNegocio)) || "INDIRECT";
      const categoria    = NORM(H(row, AL.categoria));
      const centroCosto  = NORM(H(row, AL.cc));
      const compania     = S(H(row, AL.compania));
      const minVal       = toNumber(H(row, AL.min));

      const rawMax = H(row, AL.max);
      const hasMax = S(rawMax) !== "";
      const maxVal = hasMax ? toNumber(rawMax) : OPEN_MAX; // ⬅️ rango abierto
      const openEnded = !hasMax;

      const ccNivel      = S(H(row, AL.combCcNivel));
      const vigRaw       = NORM(H(row, AL.vigente));
      const vigente      = vigRaw ? (vigRaw.startsWith("T") || vigRaw === "1" || vigRaw === "SI") : true;

      // ignorar filas totalmente vacías
      const filaVacia = !reglaNegocio && !categoria && !centroCosto && !hasMax && !(minVal > 0);
      if (filaVacia) continue;

      // requeridos
      if (!reglaNegocio || !centroCosto) continue;

      // sanidad de rango
      if (minVal > maxVal) continue;

      // ---- aprobadores (dedupe + sort) ----
      const aprob = [];
      for (const { col, expectedTipo } of tipoNivelCols) {
        const tn = parseTipoNivel(row.getCell(col).value);
        if (!tn) continue;
        const tipo = U(tn.tipo || expectedTipo || "");
        const nivel = S(tn.nivel || "");
        if (!nivel) continue;
        aprob.push({ tipo: tipo || (expectedTipo ? U(expectedTipo) : "COMPRAS"), nivel });
      }
      const aprobadores = sortSteps(dedupeSteps(aprob));

      parsed.push({
        id: `${centroCosto}|${reglaNegocio}|${minVal}|${maxVal}|${categoria}`, // clave determinista
        reglaNegocio, centroCosto, compania, categoria,
        minExp: minVal, montoMax: maxVal,
        openEnded,                // ⬅️ para que el front sepa mostrar “∞”
        aprobadores, vigente,
        updatedAt: NOW_ISO(), ccNivel,
      });
    }

    // sobrescribir parámetro completo con la nueva matriz
    await saveRulesParam({ version: 1, reglas: parsed }, req.user?.globalId || "SYSTEM");
    return res.json({ ok: true, imported: parsed.length, total: parsed.length });
  } catch (e) {
    console.error("POST /reglasdn/import", e);
    res.status(500).json({ error: "No se pudo importar" });
  }
});


// Evaluación
router.post("/reglasdn/evaluar", authOrSuper, async (req, res) => {
  try {
    const centroCosto  = U(req.body?.centroCosto);
    const categoria    = U(req.body?.categoria);
    const monto        = Number(req.body?.valorOrdenCompra ?? req.body?.monto ?? 0);
    const compania     = S(req.body?.compania || ""); // opcional
    const reglaNegocio = U(req.body?.reglaNegocio || "INDIRECT");

    const errors = [];
    if (!centroCosto) errors.push("El centro de costo es obligatorio.");
    if (!categoria)   errors.push("La categoría es obligatoria.");
    if (!(monto >= 0)) errors.push("El monto es inválido.");
    if (errors.length) return res.status(400).json({ errors });

    const [okCentro, okCategoria] = await Promise.all([
      existsCentro(centroCosto),
      existsCategoria(categoria),
    ]);
    if (!okCentro)     return res.status(404).json({ error: `Centro de costo no existe: ${centroCosto}` });
    if (!okCategoria)  return res.status(404).json({ error: `Categoría no existe: ${categoria}` });

    const data = await loadRulesParam();
    const reglas = (data.reglas || [])
      .map(r => ({
        id: S(r.id),
        reglaNegocio: U(r.reglaNegocio || "INDIRECT"),
        centroCosto: U(r.centroCosto),
        compania: S(r.compania || ""),
        categoria: U(r.categoria || ""),
        minExp: Number(r.minExp || 0),
        montoMax: Number(r.montoMax || 0),
        aprobadores: sortSteps(dedupeSteps(Array.isArray(r.aprobadores) ? r.aprobadores : [])),
        vigente: r.vigente !== false,
        updatedAt: r.updatedAt || NOW_ISO(),
      }))
      .filter(r =>
        r.vigente &&
        r.reglaNegocio === reglaNegocio &&
        r.centroCosto === centroCosto &&
        r.categoria === categoria &&
        r.compania === compania
      );

    if (!reglas.length) {
      return res.status(404).json({ error: "No hay reglas para esos criterios (centro/categoría/regla/compañía)." });
    }

    const elegida = reglas.find(r => r.minExp <= monto && monto <= r.montoMax);
    if (!elegida) return res.status(404).json({ error: "No hay regla que cubra ese monto." });

    const pasos = sortSteps(dedupeSteps(elegida.aprobadores));
    const personasMap = await findAutorizadoresBatch(pasos, centroCosto);
    const aprobadores = pasos.map(step => ({
      tipo: step.tipo, nivel: step.nivel, centroCosto,
      personas: personasMap.get(kStep(step)) || []
    }));

    return res.json({
      ok: true,
      regla: {
        id: elegida.id,
        reglaNegocio: elegida.reglaNegocio,
        centroCosto: elegida.centroCosto,
        compania: elegida.compania,
        categoria: elegida.categoria,
        rango: { min: elegida.minExp, max: elegida.montoMax },
      },
      aprobadores,
    });
  } catch (e) {
    console.error("POST /reglasdn/evaluar", e);
    res.status(500).json({ error: "No se pudo evaluar" });
  }
});

// ====== Plantilla de Excel (descarga) ======
router.get(['/reglasdn/plantilla','/reglas/plantilla'], adminOrSuper, async (_req, res) => {
  try {
    const TIPOS_DB = await getTipos();         // ej: ['COMPRAS','JEFE',...]
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Matriz');

    // Cabeceras base
    const baseHeaders = [
      'Reglas de negocio',
      'Si la categoria es',
      'Si el valor de la orden de compra es mayor o igual a',
      'Si el valor de la orden de compra es menor o igual a',
      'Si el centro de costo es',
      'Compañia',
      'El centro de costo y nivel autorizador es',
    ];

    // Una columna genérica + columnas por cada tipo de autorizador
    const headers = [
      ...baseHeaders,
      'El tipo de autorizador y nivel autorizador es', // genérica
      ...TIPOS_DB.map(t => `El tipo de autorizador y nivel autorizador es ${t}`),
      'Vigente'
    ];

    ws.addRow(headers);

    // fila ejemplo (vacía) para guiar
    ws.addRow([
      'INDIRECT', 'INDIRECTO', 0, 999999999, 'HQ06', 'BM', '', 'COMPRAS 1', ...TIPOS_DB.map(()=>''), 'SI'
    ]);

    // estilos sencillos
    ws.getRow(1).font = { bold: true };

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename="plantilla_reglas.xlsx"');
    return res.send(Buffer.from(buf));
  } catch (e) {
    console.error('GET /reglasdn/plantilla', e);
    res.status(500).json({ error: 'No se pudo generar la plantilla' });
  }
});

export default router;
