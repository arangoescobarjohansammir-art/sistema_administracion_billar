import { useEffect, useState } from 'react';
import { accountingDateRange, accountingPeriod, accountingReport, colombianDay, type AccountingData } from '../shared/accounting';
import { accountingDate, accountingTables, accountingTotals } from '../shared/accounting-tables';
import './accounting.css';

type Loader = (query: string) => Promise<AccountingData>;
type Period = 'range' | 'month';
const labelDate = (day: string) => day.split('-').reverse().join('/');

export function AccountingPanel({ cloud, load, demo = false }: { cloud?: AccountingData; load?: Loader; demo?: boolean }) {
  const today = colombianDay.format(new Date());
  const availableTo = cloud && cloud.to < today ? cloud.to : today;
  const [kind, setKind] = useState<Period>('range');
  const [from, setFrom] = useState(availableTo);
  const [to, setTo] = useState(availableTo);
  const [month, setMonth] = useState(availableTo.slice(0, 7));
  const [request, setRequest] = useState(0);
  const [state, setState] = useState<{ key: string; data?: AccountingData; error?: string }>();
  const [exporting, setExporting] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const query = new URLSearchParams(kind === 'range' ? { kind, from, to } : { kind, anchor: month }).toString();
  const key = query + ':' + request;
  const range = kind === 'range' ? accountingDateRange(from, to) : accountingPeriod(kind, month);
  const valid = Boolean(range && range.from <= today && (kind === 'month' || range.to <= today));
  useEffect(() => {
    if (!load || !valid) return;
    let ignore = false;
    load(query).then((data) => {
      if (!ignore) setState({ key, data });
    }, (error: unknown) => {
      if (!ignore) setState({ key, error: error instanceof Error ? error.message : 'No se pudo consultar el reporte.' });
    });
    return () => { ignore = true; };
  }, [load, valid, query, key]);
  const data = load ? (state?.key === key ? state.data : undefined) : cloud;
  const outside = range && cloud && (range.from < cloud.from || range.from > cloud.to ||
    (kind === 'range' && range.to > cloud.to));
  const report = data && range && valid && !outside ? accountingReport(data, range) : undefined;

  async function download() {
    if (!report || exporting) return;
    setExporting(true);
    setPdfError('');
    try {
      const { downloadAccountingPdf } = await import('./download-accounting-pdf');
      await downloadAccountingPdf(report, demo);
    } catch (error) {
      console.error('No se pudo generar el reporte de cuentas.', error);
      setPdfError('No se pudo descargar el PDF. Intenta de nuevo.');
    } finally {
      setExporting(false);
    }
  }

  return <section className="accounting" aria-label="Reportes de cuentas">
    <div className="accounting-card">
      <h2>Reportes de cuentas</h2>
      <div className="accounting-controls">
        <label>Periodo<select value={kind} onChange={(event) => { setKind(event.target.value as Period); setPdfError(''); }}>
          <option value="range">Por fechas</option><option value="month">Mensual</option>
        </select></label>
        {kind === 'range' ? <>
          <label>Fecha de inicio<input type="date" value={from} min={cloud?.from} max={availableTo}
            onChange={(event) => { setFrom(event.target.value); setPdfError(''); }} /></label>
          <label>Fecha de fin<input type="date" value={to} min={cloud?.from} max={availableTo}
            onChange={(event) => { setTo(event.target.value); setPdfError(''); }} /></label>
        </> : <label>Mes<input type="month" value={month} min={cloud?.from.slice(0, 7)} max={availableTo.slice(0, 7)}
          onChange={(event) => { setMonth(event.target.value); setPdfError(''); }} /></label>}
        {load && <button type="button" className="secondary" disabled={!valid} onClick={() => setRequest((value) => value + 1)}>Actualizar reporte</button>}
        <button type="button" className="primary" disabled={!report || exporting} onClick={() => void download()}>
          {exporting ? 'Generando PDF…' : 'Descargar PDF'}</button>
      </div>
      {range && valid && <p>{labelDate(range.from)} al {labelDate(range.to)} · Hora de Colombia</p>}
      {pdfError && <p role="alert">{pdfError}</p>}
      {!valid && <p role="status">{kind === 'range' ? 'Elige una fecha de inicio y una de fin en orden, hasta hoy.'
        : 'Elige un mes válido hasta el mes actual.'}</p>}
      {!load && !cloud && <p>Los reportes aparecerán cuando la caja actualizada envíe su primera sincronización.</p>}
      {outside && <p>El panel móvil tiene datos del {labelDate(cloud.from)} al {labelDate(cloud.to)}. Para otros periodos, consulta el computador de caja.</p>}
      {load && valid && (!state || state.key !== key) && <p role="status">Consultando movimientos…</p>}
      {state?.key === key && state.error && <p role="alert">{state.error}</p>}
    </div>
    {report && <>
      <div className="accounting-card">
        <h3>Resumen del periodo</h3>
        <p>Datos al {accountingDate(report.asOf)}. Los abonos ya están incluidos en los cobros.</p>
        <dl className="accounting-stats">{accountingTotals(report).map(([name, total]) => <div key={name}>
          <dt>{name}</dt><dd>{total}</dd>
        </div>)}</dl>
      </div>
      {accountingTables(report).map((table) => <details className="accounting-card" key={table.title}>
        <summary>{table.title} · {table.rows.length}</summary>
        {table.title === 'Cuadre por turno cerrado' && <p>Esperado / contado o verificado. Cada turno completo se incluye por su fecha de cierre.</p>}
        {table.rows.length === 0 ? <p>Sin registros en este periodo.</p> : <div className="accounting-table" tabIndex={0}
          role="region" aria-label={table.title}>
          <table aria-label={table.title}>
            <thead><tr>{table.headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
            <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, column) =>
              <td key={column}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>}
      </details>)}
    </>}
  </section>;
}
