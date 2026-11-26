import PDFDocument from 'pdfkit';
import type { DatabaseSync } from 'node:sqlite';
import { cashMovementCorrectionText, cashMovements, type CashMovementCorrection, type CashMovementKind, type SavedCashCount } from '../shared/cash.js';

type RecordRow = Record<string, unknown>;
type ReportData = {
  shift: RecordRow; totals: RecordRow; movements: (RecordRow & CashMovementCorrection)[]; payments: RecordRow[]; counts: SavedCashCount[];
};
type Column = { label: string; width: number; right?: boolean };
type DetailTable = { title: string; columns: Column[]; rows: string[][] };

const club = 'Club de Tejo Patio Bonito';
const manager = 'Humberto Escobar';
const zone = 'America/Bogota';
const ink = '#172a30';
const muted = '#46585a';
const petrol = '#174b57';
const copper = '#a45130';
const tint = '#e3eeed';
const rule = '#d8d7cd';
const pageLeft = 46;
const pageWidth = 520;
const pageBottom = 736;
const lineHeight = 12;
const currency = new Intl.NumberFormat('es-CO', { useGrouping: true, maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'medium', timeZone: zone });
const dayParts = new Intl.DateTimeFormat('es-CO', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zone });
const text = (value: unknown) => String(value ?? '').replace(/[\u00a0\u202f]/g, ' ').replace(/\r/g, '');
const money = (value: unknown) => value == null ? 'Sin dato' : (Number(value) < 0 ? '-$' : '$') + currency.format(Math.abs(Number(value)));
const count = (value: unknown) => value == null ? 'Sin conteo' : currency.format(Number(value));
const date = (value: unknown) => text(dateTime.format(new Date(String(value))));
const difference = (value: unknown, format: (value: number) => string) => value == null ? 'Sin conteo' :
  Number(value) === 0 ? 'Cuadrado' : (Number(value) < 0 ? 'Faltan ' : 'Sobran ') + format(Math.abs(Number(value)));
const column = (label: string, width: number, right = false): Column => ({ label, width, right });

export function cashReportFilename(id: number, closedAt: string) {
  const parts = Object.fromEntries(dayParts.formatToParts(new Date(closedAt)).map(({ type, value }) => [type, value]));
  return ['cierre-caja', id, parts.year, parts.month, parts.day].join('-') + '.pdf';
}

function detailTables(database: DatabaseSync, data: ReportData): DetailTable[] {
  const id = Number(data.shift.id);
  const sales = database.prepare([
    'SELECT sales.id, sales.total, sales.created_at AS createdAt, customer_accounts.name, v.reason AS voidReason,',
    '(SELECT share.sale_id FROM sale_credit_shares share WHERE share.share_sale_id = sales.id) AS splitFrom,',
    'EXISTS (SELECT 1 FROM sale_credit_shares share WHERE share.sale_id = sales.id) AS splitPayment,',
    "(SELECT actor_name FROM cash_audit WHERE kind = 'sale' AND target_id = sales.id ORDER BY id LIMIT 1) AS seller,",
    "(SELECT actor_name FROM cash_audit WHERE kind IN ('sale_void', 'tejo_charge_move') AND target_id = sales.id ORDER BY id LIMIT 1) AS voidedBy",
    'FROM cash_shift_sales tracked JOIN sales ON sales.id = tracked.sale_id',
    'LEFT JOIN customer_accounts ON customer_accounts.id = sales.account_id',
    'LEFT JOIN sale_voids v ON v.sale_id = sales.id',
    'WHERE tracked.shift_id = ? ORDER BY sales.id',
  ].join(' ')).all(id);
  const soldLines = database.prepare([
    'SELECT label, quantity, quantity * unit_price AS total FROM sale_items WHERE sale_id = ? ORDER BY id',
  ].join(' '));
  const allocatedLines = database.prepare('SELECT label, amount AS total FROM sale_allocated_lines WHERE sale_id = ? ORDER BY id');
  const salesRows = sales.map((sale) => {
    const lines = [
      ...soldLines.all(Number(sale.id)).map((row) => text(row.quantity) + ' x ' + text(row.label) + ' (' + money(row.total) + ')'),
      ...allocatedLines.all(Number(sale.id)).map((row) => text(row.label) + ' (' + money(row.total) + ')'),
    ];
    return [date(sale.createdAt) + '\nVenta #' + sale.id + (sale.voidReason ? '\nAnulada' : ''),
      [
        text(sale.name ?? 'Sin nombre'), sale.seller ? 'Registró: ' + text(sale.seller) : '',
        sale.splitPayment ? 'Parte pagada de la venta con fiado repartido' : '',
        sale.splitFrom ? 'Parte fiada de la venta #' + text(sale.splitFrom) : '',
        ...lines, sale.voidReason ? 'Anulación: ' + text(sale.voidReason) + (sale.voidedBy ? ' · ' + text(sale.voidedBy) : '') : '',
      ].filter(Boolean).join('\n'), money(sale.total)];
  });

  const linkedInventory = database.prepare([
    'SELECT p.name, p.presentation, im.units, im.reason',
    'FROM cash_inventory_links links JOIN inventory_movements im ON im.id = links.inventory_movement_id',
    'JOIN products p ON p.id = im.product_id WHERE links.cash_movement_id = ? ORDER BY im.id',
  ].join(' '));
  const movementRows = data.movements.map((movement) => {
    const inventory = linkedInventory.all(Number(movement.id)).map((item) =>
      text(item.units) + ' x ' + text(item.name) + ' (' + text(item.presentation) + '): ' + text(item.reason));
    const label = cashMovements[movement.kind as CashMovementKind]?.label ?? text(movement.kind);
    return [date(movement.createdAt) + '\nMov. #' + text(movement.id),
      label + '\n' + text(movement.category) + ': ' + text(movement.reason) +
      (movement.correctedAt ? '\nCorregido el ' + date(movement.correctedAt) + '\n' + cashMovementCorrectionText(movement, money) : '') +
      (movement.remoteRequestedAt ? '\nPanel móvil: ' + date(movement.remoteRequestedAt) : '') +
      (inventory.length ? '\nInventario: ' + inventory.join('\n') : ''),
      money(movement.amount), money(movement.salesDelta), money(movement.purchasesDelta)];
  });

  const paymentsRows = data.payments.map((payment) => [
    date(payment.createdAt),
    (payment.saleId === null ? 'Abono #' + text(payment.id) : 'Venta #' + text(payment.saleId)) +
      (payment.voided ? ' · Anulado' : '') + '\n' + text(payment.name ?? 'Sin nombre') +
      (payment.voidReason ? '\nMotivo: ' + text(payment.voidReason) : ''),
    money(payment.cash), money(payment.transfer),
    Number(payment.tokens) > 0 ? count(payment.tokens) + ' / ' + money(Number(payment.tokens) * Number(payment.tokenValue)) : '0',
  ]);

  const redemptions = database.prepare([
    'SELECT r.id, r.created_at AS createdAt, r.tokens, r.subtotal, r.extra, a.name, v.reason AS voidReason,',
    "(SELECT actor_name FROM cash_audit WHERE kind = 'redemption_void' AND target_id = r.id ORDER BY id LIMIT 1) AS voidedBy",
    'FROM cash_shift_redemptions tracked JOIN tejo_redemptions r ON r.id = tracked.redemption_id',
    'LEFT JOIN customer_accounts a ON a.id = r.account_id',
    'LEFT JOIN tejo_redemption_voids v ON v.redemption_id = r.id',
    'WHERE tracked.shift_id = ? AND r.round_id IS NULL ORDER BY r.id',
  ].join(' ')).all(id);
  const redeemedItems = database.prepare('SELECT quantity, label FROM tejo_redemption_items WHERE redemption_id = ? ORDER BY id');
  const redemptionRows = redemptions.map((entry) => [
    date(entry.createdAt) + '\nCanje #' + text(entry.id) + (entry.voidReason ? '\nAnulado' : ''),
    [text(entry.name ?? 'Sin nombre'), ...redeemedItems.all(Number(entry.id)).map((line) =>
      text(line.quantity) + ' x ' + text(line.label)),
    entry.voidReason ? 'Anulación: ' + text(entry.voidReason) + (entry.voidedBy ? ' · ' + text(entry.voidedBy) : '') : ''].filter(Boolean).join('\n'),
    count(entry.tokens), money(entry.subtotal), money(entry.extra),
  ]);
  const issued = database.prepare([
    'SELECT b.issued_at AS date, s.court_type AS court, s.court_number AS courtNumber, r.number AS round, a.name',
    'FROM cash_shift_tokens tracked',
    'JOIN tejo_benefits b ON b.round_id = tracked.round_id AND b.account_id = tracked.account_id',
    'JOIN tejo_rounds r ON r.id = b.round_id JOIN tejo_sessions s ON s.id = r.session_id',
    'JOIN customer_accounts a ON a.id = b.account_id WHERE tracked.shift_id = ?',
    'UNION ALL',
    "SELECT b.issued_at, s.court_type, s.court_number, r.number, COALESCE(a.name, 'Jugador ' || slot.number)",
    'FROM cash_shift_slot_tokens tracked JOIN tejo_slot_benefits b ON b.id = tracked.benefit_id',
    'JOIN tejo_played r ON r.id = b.round_id JOIN tejo_sessions s ON s.id = r.session_id',
    'JOIN tejo_slots slot ON slot.id = b.slot_id LEFT JOIN customer_accounts a ON a.id = slot.account_id',
    'WHERE tracked.shift_id = ? ORDER BY date',
  ].join(' ')).all(id, id);

  return [
    { title: 'Ventas y cargos del turno', columns: [column('Fecha y referencia', 124), column('Cliente y detalle', 307), column('Total', 89, true)], rows: salesRows },
    { title: 'Cobros y abonos', columns: [column('Fecha y hora', 121), column('Referencia y cliente', 148), column('Efectivo', 80, true),
      column('Transferencia', 84, true), column('Fichas / valor', 87, true)], rows: paymentsRows },
    { title: 'Movimientos de los fondos', columns: [column('Fecha y referencia', 111), column('Tipo, motivo e inventario', 196),
      column('Importe', 71, true), column('Caja ventas', 71, true), column('Fondo compras', 71, true)], rows: movementRows },
    { title: 'Fichas recibidas por productos', columns: [column('Fecha y referencia', 121), column('Cliente y productos', 208),
      column('Fichas', 43, true), column('Productos', 74, true), column('Excedente', 74, true)], rows: redemptionRows },
    { title: 'Fichas entregadas en tejo', columns: [column('Fecha y hora', 135), column('Cancha y chico', 185),
      column('Jugador', 142), column('Fichas', 58, true)], rows: issued.map((issue) => [date(issue.date),
      (issue.court === 'maxi' ? 'Maxitejo' : 'Tejo largo') + ' ' + text(issue.courtNumber) + ' / Chico ' + text(issue.round), text(issue.name), '1']) },
  ];
}

export function renderCashReport(database: DatabaseSync, data: ReportData, generatedAt = new Date()): Promise<Buffer> {
  const tables = detailTables(database, data);
  const { shift, totals } = data;
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 42, bottom: 42, left: pageLeft, right: pageLeft },
    autoFirstPage: false, bufferPages: true, info: { Title: 'Informe de cierre de caja #' + text(shift.id), Author: club } });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.once('error', reject);
    doc.once('end', () => resolve(Buffer.concat(chunks)));
  });
  let y = 0;

  function page(cover = false) {
    doc.addPage();
    doc.rect(pageLeft, 42, 4, cover ? 46 : 30).fill(copper);
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(cover ? 22 : 14)
      .text(club, pageLeft + 12, 42, { lineBreak: false });
    doc.fillColor(muted).font('Helvetica').fontSize(cover ? 12 : 9)
      .text(cover ? 'Informe de cierre de caja' : 'Informe de cierre de caja / turno #' + text(shift.id),
        pageLeft + 12, cover ? 70 : 60, { lineBreak: false });
    y = cover ? 110 : 91;
  }

  function section(title: string) {
    if (y + 48 > pageBottom) page();
    doc.fillColor(petrol).font('Helvetica-Bold').fontSize(12).text(title, pageLeft, y, { lineBreak: false });
    y += 18;
  }

  function wrapped(value: string, width: number) {
    const lines: string[] = [];
    for (const paragraph of value.split('\n')) {
      let current = '';
      for (const word of paragraph.trim().split(/\s+/)) {
        const candidate = current ? current + ' ' + word : word;
        if (doc.widthOfString(candidate) <= width) { current = candidate; continue; }
        if (current) lines.push(current);
        current = '';
        for (const character of word) {
          if (current && doc.widthOfString(current + character) > width) { lines.push(current); current = ''; }
          current += character;
        }
      }
      lines.push(current);
    }
    return lines;
  }

  function table(title: string, columns: Column[], rows: string[][], compact = false) {
    const padding = 8;
    const headingHeight = compact ? 22 : 25;
    const rowPadding = compact ? 9 : 12;
    function header(continued = false) {
      section(continued ? title + ' (continuación)' : title);
      doc.rect(pageLeft, y, pageWidth, headingHeight).fill(tint);
      doc.fillColor(petrol).font('Helvetica-Bold').fontSize(8.5);
      let x = pageLeft;
      for (const item of columns) {
        const line = item.label;
        doc.text(line, item.right ? x + item.width - padding - doc.widthOfString(line) : x + padding, y + 8, { lineBreak: false });
        x += item.width;
      }
      y += headingHeight;
    }
    const content = rows.length ? rows : [['Sin registros.']];
    doc.font('Helvetica').fontSize(9);
    const cellsByRow = content.map((row) => columns.map((item, index) => wrapped(row[index] ?? '', item.width - padding * 2)));
    const preferredHeight = cellsByRow.slice(0, content.length <= 7 ? content.length : 2).reduce((sum, cells) =>
      sum + Math.max(...cells.map((cell) => cell.length)) * lineHeight + rowPadding, 18 + headingHeight);
    if (y + 73 > pageBottom || (preferredHeight <= pageBottom - 91 && y + preferredHeight > pageBottom)) page();
    header();
    for (const [rowIndex, wrappedCells] of cellsByRow.entries()) {
      const lines = Math.max(...wrappedCells.map((cell) => cell.length));
      let offset = 0;
      while (offset < lines) {
        let capacity = Math.floor((pageBottom - y - rowPadding) / lineHeight);
        if (capacity < 1 || (offset === 0 && lines > capacity && lines <= 45)) {
          page();
          header(true);
          capacity = Math.floor((pageBottom - y - rowPadding) / lineHeight);
        }
        const used = Math.min(capacity, lines - offset);
        const height = used * lineHeight + rowPadding;
        if (rowIndex % 2 === 1) doc.rect(pageLeft, y, pageWidth, height).fill('#f8f5ee');
        doc.fillColor(ink).font('Helvetica').fontSize(9);
        let x = pageLeft;
        for (const [index, item] of columns.entries()) {
          wrappedCells[index].slice(offset, offset + used).forEach((line, index) => {
            const left = item.right ? x + item.width - padding - doc.widthOfString(line) : x + padding;
            doc.text(line, left, y + rowPadding / 2 + index * lineHeight, { lineBreak: false });
          });
          x += item.width;
        }
        y += height;
        doc.moveTo(pageLeft, y).lineTo(pageLeft + pageWidth, y).strokeColor(rule).lineWidth(0.5).stroke();
        offset += used;
      }
    }
    y += compact ? 10 : 13;
  }

  try {
    page(true);
    doc.fillColor(petrol).font('Helvetica-Bold').fontSize(11)
      .text('Turno #' + text(shift.id), pageLeft, 91, { lineBreak: false });
    table('Identificación del turno', [column('Dato', 132), column('Detalle', 128), column('Dato', 110), column('Detalle', 150)], [
      ['Encargado', manager, 'Cajero del turno', text(shift.cashier)],
      ['Apertura', date(shift.openedAt), 'Cierre', date(shift.closedAt)],
      ['Fecha y hora del informe', date(generatedAt.toISOString()), 'Zona horaria', 'Colombia (UTC-5)'],
    ], true);
    const pairs = [column('Concepto', 170), column('Valor', 90, true), column('Concepto', 170), column('Valor', 90, true)];
    table('Resumen de ventas y cobros', pairs, [
      ['Ventas registradas (' + count(totals.salesCount) + ')', money(totals.salesTotal), 'Cobros en efectivo', money(totals.cashReceived)],
      ['Cobros por transferencia', money(totals.transferExpected), 'Valor de fichas en pagos', money(totals.tokenAmount)],
      ['Abonos a cuentas', money(totals.accountCollections), 'Saldo pendiente de clientes', money(totals.pendingBalance)],
    ], true);
    table('Cuadre de efectivo y transferencias', [column('Fondo o medio', 157), column('Esperado', 105, true),
      column('Contado o verificado', 135, true), column('Diferencia', 123, true)], [
      ['Caja de ventas', money(totals.salesExpected), money(shift.salesCounted), difference(totals.salesDifference, money)],
      ['Fondo para compras', money(totals.purchasesExpected), money(shift.purchasesCounted), difference(totals.purchasesDifference, money)],
      ['Transferencias', money(totals.transferExpected), money(shift.transferConfirmed), difference(totals.transferDifference, money)],
    ], true);
    table('Entrega al administrador y base', pairs, [
      ['Base contada al abrir', money(shift.openingBase), 'Base para el próximo turno', money(shift.nextBase)],
      ['Entregado de ventas', money(totals.salesDelivery), 'Devuelto del fondo para compras', money(totals.purchasesDelivery)],
    ], true);
    table('Cuadre de fichas físicas', pairs, [
      ['Fichas al abrir', count(shift.openingTokens), 'Entregadas en tejo', count(totals.tokensIssued)],
      ['Recibidas en canjes', count(totals.tokensRedeemed), 'Recibidas en pagos', count(totals.tokensReceived)],
      ['Fichas esperadas al cierre', count(totals.expectedTokens), 'Fichas contadas al cierre', count(shift.countedTokens)],
      ['Diferencia de fichas', difference(totals.tokenDifference, count), 'Fichas para el próximo turno', count(shift.countedTokens)],
    ], true);
    const notes: string[][] = [];
    if (shift.previousBase !== null && shift.previousBase !== shift.openingBase) notes.push(['Base del turno anterior', money(shift.previousBase)]);
    if (shift.previousTokens !== null && shift.previousTokens !== shift.openingTokens) notes.push(['Fichas del cierre anterior', count(shift.previousTokens)]);
    if (shift.openingNote) notes.push(['Apertura', text(shift.openingNote)]);
    if (shift.tokenOpeningNote) notes.push(['Conteo inicial de fichas', text(shift.tokenOpeningNote)]);
    if (shift.closingNote) notes.push(['Cierre', text(shift.closingNote)]);
    if (notes.length) table('Observaciones del turno', [column('Concepto', 145), column('Detalle', 375)], notes);
    if (data.counts.length) table('Historial de conteos del cierre', [
      column('Conteo y hora', 130), column('Ventas', 68, true), column('Compras', 68, true),
      column('Transferencias', 82, true), column('Fichas', 45, true), column('Motivo', 127),
    ], data.counts.map((entry, index) => [
      (index === 0 ? 'Conteo inicial' : 'Recuento ' + index) + '\n' + date(entry.createdAt),
      money(entry.salesCounted), money(entry.purchasesCounted), money(entry.transferConfirmed),
      count(entry.countedTokens), text(entry.reason || '—'),
    ]), true);
    for (const { title, columns, rows } of tables) table(title, columns, rows, true);

    const pages = doc.bufferedPageRange();
    for (let index = pages.start; index < pages.start + pages.count; index++) {
      doc.switchToPage(index);
      doc.moveTo(pageLeft, 752).lineTo(pageLeft + pageWidth, 752).strokeColor(rule).lineWidth(0.6).stroke();
      doc.fillColor(muted).font('Helvetica').fontSize(8)
        .text(club + ' / Turno #' + text(shift.id) + ' / Valores en COP', pageLeft, 760, { lineBreak: false });
      const footer = 'Página ' + (index - pages.start + 1) + ' de ' + pages.count;
      doc.text(footer, pageLeft + pageWidth - doc.widthOfString(footer), 760, { lineBreak: false });
    }
    doc.end();
  } catch (error) {
    doc.destroy(error instanceof Error ? error : new Error(String(error)));
  }
  return result;
}
