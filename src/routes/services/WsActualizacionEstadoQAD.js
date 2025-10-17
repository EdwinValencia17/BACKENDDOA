// src/routes/services/WsActualizacionEstadoQAD.js
// QAD SOAP service (Node 22+ con fetch nativo) — sin dependencias externas
// Usa EXCLUSIVAMENTE la URL de `URL_SOAP_UPDATEPO` (env o tabla doa2.parametros)

import pool from "../../config/db.js";
import { TextDecoder } from "node:util";

const LOG = String(process.env.QAD_SOAP_LOG ?? "1").trim() !== "0";
const LOG_NS = "[QAD SOAP]";

/* ========================= Utilidades ========================= */

function ddMMyyBogota(date = new Date()) {
  const tz = "America/Bogota";
  const d = new Intl.DateTimeFormat("es-CO", { timeZone: tz, day: "2-digit" }).format(date);
  const m = new Intl.DateTimeFormat("es-CO", { timeZone: tz, month: "2-digit" }).format(date);
  const y = new Intl.DateTimeFormat("es-CO", { timeZone: tz, year: "2-digit" }).format(date);
  return `${d}${m}${y}`; // ddMMyy
}

/** Acepta Date | 'YYYY-MM-DD' | 'ddMMyy' | vacío -> retorna ddMMyy */
function toQADDate(fecha) {
  if (fecha instanceof Date) return ddMMyyBogota(fecha);
  const s = String(fecha ?? "").trim();
  if (!s) return ddMMyyBogota(); // default: hoy
  // ddMMyy ya
  if (/^\d{6}$/.test(s)) return s;
  // YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00-05:00`);
    return ddMMyyBogota(d);
  }
  // fallback: hoy
  return ddMMyyBogota();
}

async function getSoapUrl(client) {
  const env = process.env.URL_SOAP_UPDATEPO?.trim();
  if (env) return env;

  const { rows } = await client.query(
    `SELECT valor
       FROM doa2.parametros
      WHERE parametro = $1
        AND estado_registro = 'A'
      LIMIT 1`,
    ["URL_SOAP_UPDATEPO"]
  );
  const url = rows[0]?.valor?.trim();
  if (!url) {
    throw new Error(
      "URL_SOAP_UPDATEPO no configurado: defínelo en variable de entorno o en doa2.parametros."
    );
  }
  return url;
}

const excerpt = (s, n = 600) => (s || "").replace(/\s+/g, " ").slice(0, n);

/** Extrae <tt-estado>...</tt-estado> ignorando namespaces */
function extractEstado(xml) {
  const re = /<(?:\w+:)?tt-estado>([^<]+)<\/(?:\w+:)?tt-estado>/i;
  return xml.match(re)?.[1]?.trim() || null; // típico: "Aceptado"
}

/** Extrae <faultstring> si existe (para diagnósticos) */
function extractFault(xml) {
  const m = xml.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/i);
  return m?.[1]?.trim() || null;
}

/* ========================= XML Builders ========================= */

function buildUpdatePoXML({ dominio, numpo, estado, fecha, desestado }) {
  return `\
<soapenv:Envelope xmlns="urn:schemas-qad-com:xml-services"
  xmlns:qcom="urn:schemas-qad-com:xml-services:common"
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:wsa="http://www.w3.org/2005/08/addressing">
  <soapenv:Header>
    <wsa:Action/>
    <wsa:To>urn:services-qad-com:INTEGRATION</wsa:To>
    <wsa:MessageID>urn:services-qad-com::INTEGRATION</wsa:MessageID>
    <wsa:ReferenceParameters>
      <qcom:suppressResponseDetail>false</qcom:suppressResponseDetail>
    </wsa:ReferenceParameters>
    <wsa:ReplyTo>
      <wsa:Address>urn:services-qad-com:</wsa:Address>
    </wsa:ReplyTo>
  </soapenv:Header>
  <soapenv:Body>
    <UpdatePo>
      <qcom:dsSessionContext>
        <qcom:ttContext>
          <qcom:propertyQualifier>QAD</qcom:propertyQualifier>
          <qcom:propertyName>domain</qcom:propertyName>
          <qcom:propertyValue>${dominio ?? ""}</qcom:propertyValue>
        </qcom:ttContext>
        <qcom:ttContext>
          <qcom:propertyQualifier>QAD</qcom:propertyQualifier>
          <qcom:propertyName>scopeTransaction</qcom:propertyName>
          <qcom:propertyValue>false</qcom:propertyValue>
        </qcom:ttContext>
        <qcom:ttContext>
          <qcom:propertyQualifier>QAD</qcom:propertyQualifier>
          <qcom:propertyName>version</qcom:propertyName>
          <qcom:propertyValue>CUST_1</qcom:propertyValue>
        </qcom:ttContext>
      </qcom:dsSessionContext>
      <dsGetdataInput>
        <tt-criterio>
          <tt-dominio>${dominio ?? ""}</tt-dominio>
          <tt-numpo>${numpo ?? ""}</tt-numpo>
          <tt-estado>${estado ?? ""}</tt-estado>
          <tt-fecha>${fecha ?? ""}</tt-fecha>
          <tt-desestado>${desestado ?? ""}</tt-desestado>
        </tt-criterio>
      </dsGetdataInput>
    </UpdatePo>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildUpdatePoDetailXML({ dominio, numpo, estado }) {
  return `\
<soapenv:Envelope xmlns="urn:schemas-qad-com:xml-services"
  xmlns:qcom="urn:schemas-qad-com:xml-services:common"
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:wsa="http://www.w3.org/2005/08/addressing">
  <soapenv:Header>
    <wsa:Action/>
    <wsa:To>urn:services-qad-com:INTEGRATION</wsa:To>
    <wsa:MessageID>urn:services-qad-com::INTEGRATION</wsa:MessageID>
    <wsa:ReferenceParameters>
      <qcom:suppressResponseDetail>false</qcom:suppressResponseDetail>
    </wsa:ReferenceParameters>
    <wsa:ReplyTo>
      <wsa:Address>urn:services-qad-com:</wsa:Address>
    </wsa:ReplyTo>
  </soapenv:Header>
  <soapenv:Body>
    <dsUpdatePoDetail>
      <qcom:dsSessionContext>
        <qcom:ttContext>
          <qcom:propertyQualifier>QAD</qcom:propertyQualifier>
          <qcom:propertyName>domain</qcom:propertyName>
          <qcom:propertyValue>${dominio ?? ""}</qcom:propertyValue>
        </qcom:ttContext>
        <qcom:ttContext>
          <qcom:propertyQualifier>QAD</qcom:propertyQualifier>
          <qcom:propertyName>scopeTransaction</qcom:propertyName>
          <qcom:propertyValue>false</qcom:propertyValue>
        </qcom:ttContext>
        <qcom:ttContext>
          <qcom:propertyQualifier>QAD</qcom:propertyQualifier>
          <qcom:propertyName>version</qcom:propertyName>
          <qcom:propertyValue>CUST_1</qcom:propertyValue>
        </qcom:ttContext>
        <qcom:ttContext>
          <qcom:propertyQualifier>QAD</qcom:propertyQualifier>
          <qcom:propertyName>mnemonicsRaw</qcom:propertyName>
          <qcom:propertyValue>false</qcom:propertyValue>
        </qcom:ttContext>
      </qcom:dsSessionContext>
      <dsUpdatePoDetail>
        <tt-criterio>
          <tt-dominio>${dominio ?? ""}</tt-dominio>
          <tt-numpo>${numpo ?? ""}</tt-numpo>
          <tt-estado>${estado ?? ""}</tt-estado>
        </tt-criterio>
      </dsUpdatePoDetail>
    </dsUpdatePoDetail>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/* ========================= HTTP helper ========================= */

// POST SOAP con fetch nativo. Decodifica como latin1.
async function postSoap(url, xml) {
  const t0 = Date.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=iso-8859-1", SOAPAction: "" },
    body: Buffer.from(xml, "latin1"),
    signal: AbortSignal.timeout(60_000),
  });
  const buf = await resp.arrayBuffer();
  const text = new TextDecoder("latin1").decode(buf);
  const ms = Date.now() - t0;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${excerpt(text)}`);
  return { text, ms, status: resp.status };
}

/* ========================= API principal ========================= */

// Llama UpdatePo; si estado es "C" o "X", también UpdatePoDetail.
// Devuelve el texto de estado del primer SOAP ("Aceptado", usualmente).
export async function updatePo({ dominio, numpo, estado, fecha, desestado }) {
  const client = await pool.connect();
  try {
    const url = await getSoapUrl(client);

    // 👉 asegurar fecha QAD SIEMPRE (ddMMyy) y desestado por defecto
    const fechaQAD = toQADDate(fecha);
    const des = (desestado ?? (String(estado).trim().toUpperCase() === "X" ? "Rechazada" : "")).trim();

    const xml = buildUpdatePoXML({
      dominio,
      numpo,
      estado,
      fecha: fechaQAD,
      desestado: des
    });

    const { text, ms, status } = await postSoap(url, xml);
    const estadoResp = extractEstado(text);
    const fault = extractFault(text);
    const ok = /aceptad/i.test(estadoResp || "");

  const humanEstado = String(estado || '').trim().toUpperCase() === 'C'
  ? 'APROBADA (C)'
  : String(estado || '').trim().toUpperCase() === 'X'
  ? 'RECHAZADA (X)'
  : String(estado || '').trim();

if (LOG) {
  console.info(
    `${LOG_NS} UpdatePo ⇒ ACK="${estadoResp ?? ""}" · ENVIADO=${humanEstado} ` +
    `(dom=${dominio} po=${numpo} fecha=${fechaQAD} des="${des}") · ${ms}ms`
  );
  if (!estadoResp && fault) {
    console.warn(`${LOG_NS} Fault: ${fault}`);
  } else if (!estadoResp) {
    console.warn(`${LOG_NS} tt-estado no encontrado. Resp: ${excerpt(text)}`);
  }
}

    // 👉 Reglas de negocio: si es RECHAZO (X) o APROBADO (C), impactar de INMEDIATO el detalle
   if (LOG) {
  console.info(
    `${LOG_NS} UpdatePoDetail ⇒ ACK="${estadoResp ?? ""}" · ENVIADO=${humanEstado} ` +
    `(dom=${dominio} po=${numpo}) · ${ms}ms`
  );
  if (!estadoResp) {
    const fault = extractFault(text);
    if (fault) console.warn(`${LOG_NS} Fault: ${fault}`);
    else console.warn(`${LOG_NS} tt-estado no encontrado. Resp: ${excerpt(text)}`);
  }
}

    return estadoResp;
  } finally {
    client.release();
  }
}

export async function updatePoDetail({ dominio, numpo, estado }) {
  const client = await pool.connect();
  try {
    const url = await getSoapUrl(client);
    const xml = buildUpdatePoDetailXML({ dominio, numpo, estado });
    const { text, ms } = await postSoap(url, xml);
    const estadoResp = extractEstado(text);
    const ok = /aceptad/i.test(estadoResp || "");

    if (LOG) {
      console.info(
        `${LOG_NS} UpdatePoDetail → url=${url} | dominio=${dominio} po=${numpo} estado=${estado} | ${ms}ms ` +
        `| tt-estado="${estadoResp ?? ""}" ${ok ? "✔️ OK" : "⚠️ revisar"}`
      );
      if (!estadoResp) {
        const fault = extractFault(text);
        if (fault) console.warn(`${LOG_NS} Fault: ${fault}`);
        else console.warn(`${LOG_NS} tt-estado no encontrado. Resp: ${excerpt(text)}`);
      }
    }

    return estadoResp;
  } finally {
    client.release();
  }
}

// Export util para formatear fecha para QAD (ddMMyy en zona Bogotá)
export { ddMMyyBogota };
