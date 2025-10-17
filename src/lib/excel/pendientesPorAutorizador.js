import ExcelJS from "exceljs";
import { format } from "date-fns";

export async function buildExcelPendientesPorAutorizador({ items, idioma }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Pendientes");

  ws.columns = [
    { header: idioma?.toUpperCase()==="E" ? "PO Number" : "Orden Compra", key: "oc", width: 18 },
    { header: idioma?.toUpperCase()==="E" ? "Vendor"    : "Proveedor",    key: "prov", width: 28 },
    { header: idioma?.toUpperCase()==="E" ? "Value"     : "Total Neto",   key: "total", width: 16 },
    { header: idioma?.toUpperCase()==="E" ? "Requester" : "Solicitante",  key: "sol", width: 24 },
  ];

  // header style
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6D28D9" } };
  ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

  (items || []).forEach(r => {
    ws.addRow({
      oc: r.numero_orden_compra,
      prov: r.nombre_proveedor,
      total: Number(r.total_neto || 0),
      sol: r.solicitante,
    });
  });

  ws.getColumn("total").numFmt = '#,##0;[Red]-#,##0';
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
