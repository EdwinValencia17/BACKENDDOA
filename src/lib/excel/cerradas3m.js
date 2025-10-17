import ExcelJS from "exceljs";
import { format } from "date-fns";

export async function buildReporteCerradas3M(items) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Cerradas");

  ws.columns = [
    { header: "Orden Compra", key: "oc", width: 18 },
    { header: "Solicitud", key: "sol", width: 16 },
    { header: "Fecha Cierre", key: "fecha", width: 20 },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

  (items || []).forEach(r => ws.addRow({
    oc: r.numero_orden_compra,
    sol: r.numero_solicitud,
    fecha: r.fecha_cierre ? format(r.fecha_cierre, "yyyy-MM-dd HH:mm") : "",
  }));

  ws.views = [{ state: "frozen", ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
