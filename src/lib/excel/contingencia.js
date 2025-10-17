import ExcelJS from "exceljs";
import { format } from "date-fns";

export async function buildReporteContingencia(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Contingencia");

  ws.columns = [
    { header: "Orden Compra", key: "oc", width: 18 },
    { header: "Solicitud", key: "sol", width: 16 },
    { header: "Proveedor", key: "prov", width: 32 },
    { header: "Total Neto", key: "total", width: 16 },
    { header: "Estado", key: "estado", width: 10 },
    { header: "Fecha OC", key: "fecha", width: 18 },
  ];

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  rows.forEach(r => ws.addRow({
    oc: r.numero_orden_compra,
    sol: r.numero_solicitud,
    prov: r.nombre_proveedor,
    total: Number(r.total_neto || 0),
    estado: r.estado_oc_id_esta,
    fecha: r.fecha_orden_compra ? format(new Date(r.fecha_orden_compra), "yyyy-MM-dd HH:mm") : "",
  }));

  ws.getColumn('total').numFmt = '#,##0;[Red]-#,##0';
  ws.views = [{ state: "frozen", ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
