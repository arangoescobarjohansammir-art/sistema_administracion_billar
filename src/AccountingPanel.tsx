import { useEffect, useState } from 'react';
import { accountingPeriod, accountingReport, colombianDay, type AccountingData, type PeriodKind } from '../shared/accounting';
import { accountingDate, accountingTables, accountingTotals } from '../shared/accounting-tables';
import './accounting.css';

type Loader = (kind: PeriodKind, date: string) => Promise<AccountingData>;

export function AccountingPanel({ cloud, load, demo = false }: { cloud?: AccountingData; load?: Loader; demo?: boolean }) {
  const today = colombianDay.format(new Date());
  const [kind, setKind] = useState<PeriodKind>('week');
  const [anchor, setAnchor] = useState(today);
  const [request, setRequest] = useState(0);
  const [state, setState] = useState<{ key: string; data?: AccountingData; error?: string }>();
  const [exporting, setExporting] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const key = [kind, anchor, request].join(':');
  const range = accountingPeriod(kind, anchor);
  const valid = range && range.from <= today;
  useEffect(() => {
    if (!load || !valid) return;
    let ignore = false;
    load(kind, anchor).then((data) => {
      if (!ignore) setState({ key, data });
    }, (error: unknown) => {
      if (!ignore) setState({ key, error: error instanceof Error ? error.message : 'No se pudo consultar el reporte.' });
    });
    return () => { ignore = true; };
  }, [load, valid, kind, anchor, key]);
  const data = load ? (state?.key === key ? state.data : undefined) : cloud;
  const outside = range && cloud && (range.from < cloud.from || range.from > cloud.to);
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

  function changeKind(value: PeriodKind) {
    setKind(value);
    setAnchor(value === 'month' ? anchor.slice(0, 7) : anchor.length === 7 ? anchor + '-01' : anchor);
    setPdfError('');
  }

  return <section className="accounting" aria-label="Reportes de cuentas">
    <div className="accounting-card">
      <h2>Reportes de cuentas</h2>
      <div className="accounting-controls">
        <label>Periodo<select value={kind} onChange={(event) => changeKind(event.target.value as PeriodKind)}>
          <option value="week">Semanal</option><option value="month">Mensual</option>
        </select></label>
        <label>{kind === 'week' ? 'Fecha dentro de la semana' : 'Mes'}
          <input type={kind === 'week' ? 'date' : 'month'} value={anchor}
            min={kind === 'week' ? cloud?.from : cloud?.from.slice(0, 7)}
            max={kind === 'week' ? today : today.slice(0, 7)}
            onChange={(event) => { setAnchor(event.target.value); setPdfError(''); }} /></label>
        {load && <button type="button" className="secondary" onClick={() => setRequest((value) => value + 1)}>Actualizar reporte</button>}
        <button type="button" className="primary" disabled={!report || exporting} onClick={() => void download()}>
          {exporting ? 'Generando PDF…' : 'Descargar PDF'}</button>
      </div>
      {range && <p>{range.from} al {range.to} · Hora de Colombia</p>}
      {pdfError && <p role="alert">{pdfError}</p>}
      {!valid && <p>Elige una fecha válida.</p>}
      {!load && !cloud && <p>Los reportes aparecerán cuando la caja actualizada envíe su primera sincronización.</p>}
      {outside && <p>El panel móvil tiene datos desde el {cloud.from} hasta el {cloud.to}. Consulta periodos anteriores en el computador de caja.</p>}
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
