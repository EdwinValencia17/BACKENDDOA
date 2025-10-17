import express from "express";
import multer from "multer";
import { loadRulesFromBuffer } from "../../routes/ReglasDeNegocio/ReglasDeNegocio.js";
import { generarFlujoParaOC } from "../../routes/ReglasDeNegocio/AutorizacionOCService.js";

const router = express.Router();
const upload = multer(); // memoria

// POST /api/rules/reload  (similar a RuleReloadView.java)
router.post("/rules/reload", upload.single("file"), async (req, res) => {
  try {
    const ruleType = (req.body?.ruleType || "OC").toString();
    if (!req.file?.buffer) return res.status(400).json({ errors: ["Falta archivo de reglas"] });
    loadRulesFromBuffer(req.file.buffer, ruleType);
    return res.json({ ok: true, message: `Reglas ${ruleType} recargadas` });
  } catch (e) {
    return res.status(400).json({ errors: [e.message || "Archivo inválido"] });
  }
});

// POST /api/autorizaciones/oc/:fuente/:id/run
router.post("/oc/:fuente/:id/run", async (req, res) => {
  try {
    const fuente = String(req.params.fuente || "ACTIVA").toUpperCase();
    const idCab = Number(req.params.id);
    if (!Number.isFinite(idCab)) return res.status(400).json({ ok:false, message: "ID inválido" });

    const out = await generarFlujoParaOC({ fuente, idCab, operador: (req.headers["x-user"] || "WEB").toString() });
    return res.json(out);
  } catch (e) {
    console.error("RUN RULES error:", e);
    return res.status(500).json({ ok:false, message: e?.message || "Error ejecutando reglas" });
  }
});

export default router;
