import PDFDocument, * as pdfkit from 'pdfkit';
import helvetica from 'pdfkit/standard-fonts/Helvetica';
import helveticaBold from 'pdfkit/standard-fonts/HelveticaBold';
import type { AccountingReport } from '../shared/accounting';
import { accountingFilename } from '../shared/accounting-tables';
import { accountingPdfOptions, writeAccountingPdf } from '../shared/accounting-pdf';

// The browser build requires explicit registration of the standard fonts.
const browserPdfkit = pdfkit as typeof pdfkit & { registerStdFonts: (...fonts: { name: string }[]) => void };
browserPdfkit.registerStdFonts(helvetica, helveticaBold);

export async function downloadAccountingPdf(report: AccountingReport, demo: boolean) {
  const doc = new PDFDocument(accountingPdfOptions);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const finished = new Promise<Blob>((resolve, reject) => {
    doc.on('data', (chunk: Uint8Array) => chunks.push(Uint8Array.from(chunk)));
    doc.once('error', reject);
    doc.once('end', () => resolve(new Blob(chunks, { type: 'application/pdf' })));
  });
  writeAccountingPdf(doc, report, new Date(), demo);
  const url = URL.createObjectURL(await finished);
  const link = document.createElement('a');
  link.href = url;
  link.download = (demo ? 'demo-' : '') + accountingFilename(report);
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
