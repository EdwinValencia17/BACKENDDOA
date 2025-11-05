// src/api/services/AdjuntosOC.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HINTS = [
  "/www/data/adjuntosdoa",
  "/www/data/AdjuntosDOA",
  "C:\\Data\\AdjuntosDOA",
  "D:\\Data\\AdjuntosDOA",
];

function normSlash(p) {
  return String(p || "")
    .replaceAll("\\", path.sep)
    .replaceAll("/", path.sep)
    .trim();
}

function isHttpUrl(s) {
  try { const u = new URL(String(s || "")); return ["http:", "https:"].includes(u.protocol); }
  catch { return false; }
}

function safeJoin(base, target) {
  const full = path.resolve(base, target);
  if (!full.startsWith(path.resolve(base))) {
    throw new Error("Ruta inválida (path traversal detectado).");
  }
  return full;
}

/**
 * Lee el parámetro PATH de doa2.parametros y arma el set de “bases” válidas.
 * También permite sobreescribir por ENV DOA_ADJUNTOS_BASE (se puede poner varias separadas por ;).
 */
export async function getBasePaths(client) {
  const bases = new Set();

  // 1) ENV opcional
  const envRaw = process.env.DOA_ADJUNTOS_BASE || "";
  envRaw.split(";").map(s => s.trim()).filter(Boolean).forEach(s => bases.add(normSlash(s)));

  // 2) Parametro PATH en BD
  try {
    const { rows } = await client.query(
      `SELECT valor FROM doa2.parametros WHERE parametro='PATH' AND estado_registro='A' LIMIT 1`
    );
    if (rows[0]?.valor) bases.add(normSlash(rows[0].valor));
  } catch {
    // ignoramos error de parametros, seguimos con hints
  }

  // 3) Hints razonables
  DEFAULT_HINTS.forEach(h => bases.add(normSlash(h)));

  // Limpieza
  return Array.from(bases)
    .map(p => p.endsWith(path.sep) ? p.slice(0, -1) : p)
    .filter(Boolean);
}

/**
 * Devuelve un descriptor del stream o una orden de redirección.
 * - Si row.archivo no es null → sirve el buffer.
 * - Si row.ubicacion es URL → redirect.
 * - Si row.ubicacion es ruta → busca archivo en ubicacion (absoluta o relativa a basePaths).
 */
export async function openAdjunto({ row, basePaths = [] }) {
  const nombre = String(row?.nombre_archivo || "adjunto").trim();
  const ext = (row?.extension ? String(row.extension).trim() : "") || "";
  const rawUb = String(row?.ubicacion || "").trim();
  const hasBlob = row?.archivo != null;

  // 1) BLOB en BD
  if (hasBlob) {
    const buf = row.archivo; // BYTEA
    const filename = ext ? `${nombre}.${ext.replace(/^\./, "")}` : nombre;
    const mime = guessMime(filename);
    return { kind: "buffer", buffer: buf, filename, contentType: mime };
  }

  // 2) URL absoluta → redirect
  if (isHttpUrl(rawUb)) {
    return { kind: "redirect", url: rawUb };
  }

  // 3) Ruta de FS
  const ub = normSlash(rawUb);
  const candidates = new Set();

  // a) si es absoluta, probamos tal cual y con extensión
  if (path.isAbsolute(ub)) {
    candidates.add(ub);
    if (ext) candidates.add(`${ub}.${ext.replace(/^\./, "")}`);
  } else {
    // b) relativa → probamos contra todas las bases
    for (const base of basePaths) {
      try {
        candidates.add(safeJoin(base, ub));
        if (ext) candidates.add(safeJoin(base, `${ub}.${ext.replace(/^\./, "")}`));
        // algunas bases guardan nombre_archivo separado
        candidates.add(safeJoin(base, normSlash(path.join(ub, nombre))));
        if (ext) candidates.add(safeJoin(base, normSlash(path.join(ub, `${nombre}.${ext.replace(/^\./, "")}`))));
      } catch {
        /* path traversal bloqueado; ignorar candidate */
      }
    }
  }

  // También consideramos si ubicacion ya es carpeta y nombre_archivo es el archivo
  if (path.isAbsolute(ub) && nombre) {
    candidates.add(normSlash(path.join(ub, nombre)));
    if (ext) candidates.add(normSlash(path.join(ub, `${nombre}.${ext.replace(/^\./, "")}`)));
  }

  // Busca el primero que exista
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) {
        const filename = path.basename(c);
        const mime = guessMime(filename);
        const stream = fs.createReadStream(c);
        return { kind: "stream", stream, filename, contentType: mime, size: st.size };
      }
    } catch {
      // probar siguiente
    }
  }

  const tried = Array.from(candidates).slice(0, 5); // para logs
  throw new Error(`Archivo no encontrado. Ejemplos probados: ${tried.join(" | ")}`);
}

function guessMime(filename = "") {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".rar")) return "application/vnd.rar";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".doc")) return "application/msword";
  return "application/octet-stream";
}
