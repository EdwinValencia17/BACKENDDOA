import ExcelJS from "exceljs";

export async function buildPlantillaReglas() {
  const TIPOS_VISIBLES = [
    "COMPRAS",
    "FINANZAS AM",
    "GERENTE OPS",
    "FINANZAS",
    "COMPRAS DIRECTOS",
    "INTERCOMPANY",
  ];

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Reglas");

  while (ws.rowCount < 8) ws.addRow([]);

  const base = [
    "Reglas de negocio",
    "Si la categoria es",
    "Si el valor de la orden de compra es mayor o igual a",
    "Si el valor de la orden de compra es menor o igual a",
    "Si el centro de costo es",
    "El centro de costo y nivel autorizador es",
  ];
  const aprobHeaders = TIPOS_VISIBLES.map(
    (t) => `El tipo de autorizador y nivel autorizador es ${t}`
  );
  const headers = [...base, ...aprobHeaders, "vigente"];

  const headerRow = ws.addRow(headers); // fila 9
  headerRow.eachCell((cell, colNumber) => {
    cell.font = { bold: true };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    let color = "CCF5FF";
    if (colNumber === 6) color = "FFEAD6";
    if (colNumber >= 7 && colNumber < 7 + aprobHeaders.length) color = "FFFACD";
    if (colNumber === 7 + aprobHeaders.length) color = "E8F5E9";
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.border = {
      top: { style: "thin" }, bottom: { style: "thin" },
      left: { style: "thin" }, right: { style: "thin" },
    };
  });

  const widths = [24, 26, 38, 38, 18, 30, ...new Array(aprobHeaders.length).fill(28), 12];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  // util para letra de columna
  const colLetter = (n) => {
    let s = "";
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };

  const START = 10, END = 1000;

  ws.dataValidations.add(`A${START}:A${END}`, {
    type: "list",
    formulae: ['"INDIRECT,DIRECT,INTERCOMPANY,PLOMO,DIRECTOPACIFICO"'],
    allowBlank: true, showErrorMessage: true,
    errorTitle: "Valor inválido", error: "Selecciona una opción de la lista."
  });

  // Vigente en última columna real
  const lastCol = base.length + aprobHeaders.length + 1; // +1 por "vigente"
  const vig = colLetter(lastCol);
  ws.dataValidations.add(`${vig}${START}:${vig}${END}`, {
    type: "list", formulae: ['"TRUE,FALSE"'], allowBlank: true
  });

  // filas de ejemplo (opcional)
  const ejemplo = [
    ["INDIRECT","INDIRECTO",0,5000,"AF25","AF25, 10","COMPRAS, 10","FINANZAS AM, 30","GERENTE OPS, 30","","","",true],
    ["INDIRECT","INDIRECTO",5001,100000,"AF25","AF25, 20","COMPRAS, 10","FINANZAS AM, 30","GERENTE OPS, 30","","","",true],
  ];
  for (const r of ejemplo) ws.addRow(r);

  return wb.xlsx.writeBuffer();
}
