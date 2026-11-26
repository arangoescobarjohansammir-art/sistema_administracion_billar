import type PDFDocument from 'pdfkit';
import type { AccountingReport } from './accounting.js';
import { accountingDate, accountingTables, accountingTotals, type AccountingTable } from './accounting-tables.js';

const left = 46;
const width = 520;
const bottom = 737;
const ink = '#172a30';
const dark = '#174b57';
const brand = 'Club de Tejo Patio Bonito';
const palette = { light: '#e3eeed', pale: '#f8f5ee', rule: '#d8d7cd', accent: '#a45130' };

export function writeAccountingPdf(doc: InstanceType<typeof PDFDocument>, report: AccountingReport, generatedAt = new Date(), demo = false) {
  let y = 0;
  function page(cover = false) {
    doc.addPage();
    doc.rect(left, 44, 4, cover ? 57 : 38).fill(palette.accent);
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(cover ? 22 : 15).text(brand, left + 13, 44, { lineBreak: false });
    doc.fillColor(dark).font('Helvetica').fontSize(cover ? 13 : 9)
      .text('Reporte de cuentas y cuadre · ' + report.from + ' al ' + report.to, left + 13, cover ? 74 : 65, { lineBreak: false });
    y = cover ? 116 : 100;
  }
  function paragraph(text: string) {
    doc.fillColor(ink).font('Helvetica').fontSize(9).text(text, left, y, { width, lineGap: 3 });
    y = doc.y + 10;
  }
  function table({ title, headers, widths, rows, right = [] }: AccountingTable) {
    const padding = 8;
    function header(continued = false) {
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(12).text(title + (continued ? ' (continuación)' : ''), left, y, { lineBreak: false });
      y += 19;
      doc.rect(left, y, width, 24).fill(palette.light);
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(8.5);
      let x = left;
      for (const [index, label] of headers.entries()) {
        doc.text(label, x + padding, y + 8, { width: widths[index] - padding * 2, lineBreak: false, align: right.includes(index) ? 'right' : 'left' });
        x += widths[index];
      }
      y += 24;
    }
    if (y + 98 > bottom) page();
    header();
    if (!rows.length) { paragraph('Sin registros en este periodo.'); return; }
    for (const [index, row] of rows.entries()) {
      doc.font('Helvetica').fontSize(9);
      const height = Math.max(13, ...row.map((cell, col) => doc.heightOfString(cell, { width: widths[col] - padding * 2 }))) + 12;
      if (y + height > bottom) { page(); header(true); }
      if (index % 2) doc.rect(left, y, width, height).fill(palette.pale);
      doc.fillColor(ink).font('Helvetica').fontSize(9);
      let x = left;
      for (const [col, cell] of row.entries()) {
        doc.text(cell, x + padding, y + 6, { width: widths[col] - padding * 2, align: right.includes(col) ? 'right' : 'left' });
        x += widths[col];
      }
      y += height;
      doc.moveTo(left, y).lineTo(left + width, y).strokeColor(palette.rule).lineWidth(0.5).stroke();
    }
    y += 16;
  }

  page(true);
  paragraph((demo ? 'Demostración · Datos ficticios\n' : '') + 'Encargado Humberto Escobar\nDatos al ' + accountingDate(report.asOf) + ' · Emitido el ' +
    accountingDate(generatedAt.toISOString()) + ' · Hora de Colombia · Pesos (COP)');
  const items = accountingTotals(report);
  table({ title: 'Resumen del periodo', headers: ['Concepto', 'Total', 'Concepto', 'Total'],
    widths: [178, 82, 178, 82], right: [1, 3],
    rows: Array.from({ length: Math.ceil(items.length / 2) }, (_, i) => [...items[i * 2], ...(items[i * 2 + 1] ?? [])]) });
  if (y + 95 > bottom) page();
  paragraph('Las operaciones siguen la fecha en que se registraron. Las anulaciones se reflejan en su propia fecha. ' +
    'Los abonos ya están incluidos en los cobros.\nEl cuadre muestra esperado / contado o verificado, con su diferencia, ' +
    'y agrupa cada turno completo por su fecha de cierre.\n¹ El efectivo entregado de ventas se calcula después de descontar la base dejada.');
  for (const detail of accountingTables(report)) table(detail);

  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index++) {
    doc.switchToPage(index);
    doc.moveTo(left, 752).lineTo(left + width, 752).strokeColor(palette.rule).lineWidth(0.5).stroke();
    doc.fillColor(dark).font('Helvetica').fontSize(8).text(brand + ' / Reporte de cuentas', left, 760, { lineBreak: false });
    const footer = 'Página ' + (1 + index - pages.start) + ' de ' + pages.count;
    doc.text(footer, left + width - doc.widthOfString(footer), 760, { lineBreak: false });
  }
  doc.end();
}

export const accountingPdfOptions = {
  size: 'LETTER', margins: { top: 42, bottom: 42, left: 46, right: 46 }, autoFirstPage: false, bufferPages: true,
  info: { Title: 'Reporte de cuentas y cuadre', Author: brand },
};
