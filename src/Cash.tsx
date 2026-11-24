import { useEffect, useState, type FormEvent } from 'react';
import { cashMovements, type CashMovementKind } from '../shared/cash';
import { api, message, money, useOperation } from './Accounts';

type Shift = {
  id: number; cashier: string; openedAt: string; openingBase: number; previousBase: number | null; openingNote: string;
  closedAt: string | null; salesCounted: number | null; purchasesCounted: number | null; transferConfirmed: number | null;
  nextBase: number | null; closingNote: string | null;
  openingTokens: number | null; previousTokens: number | null; countedTokens: number | null; tokenOpeningNote: string | null;
};
type Totals = {
  salesCount: number; salesTotal: number; cashReceived: number; transferExpected: number;
  tokensReceived: number; tokenAmount: number; accountCollections: number; pendingBalance: number;
  tokensIssued: number; tokensRedeemed: number; salesExpected: number; purchasesExpected: number;
  expectedTokens: number | null; tokenDifference: number | null;
  salesDifference: number | null; purchasesDifference: number | null; transferDifference: number | null;
  salesDelivery: number | null; purchasesDelivery: number | null;
};
type Movement = {
  id: number; kind: CashMovementKind; amount: number; category: string; reason: string; createdAt: string; inventoryLinks: number;
};
type Payment = {
  id: number; saleId: number | null; name: string | null; cash: number; transfer: number;
  tokens: number; tokenValue: number; createdAt: string;
};
type Detail = { shift: Shift; totals: Totals; movements: Movement[]; payments: Payment[] };
type Dashboard = { active: Detail | null; previousBase: number | null; previousTokens: number | null; recent: Shift[] };
type Action = (path: string, data: object, success: string) => Promise<boolean>;
const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota' });
const formatted = (amount: number | null) => amount === null ? '—' : money.format(amount);
const tokenCount = (amount: number) => amount + (amount === 1 ? ' ficha' : ' fichas');

function Opening({ previousBase, previousTokens, locked, act }: {
  previousBase: number | null; previousTokens: number | null; locked: boolean; act: Action;
}) {
  const [base, setBase] = useState(previousBase === null ? '' : String(previousBase));
  const [tokens, setTokens] = useState('');
  const mismatch = (previousBase !== null && base !== '' && Number(base) !== previousBase) ||
    (previousTokens !== null && tokens !== '' && Number(tokens) !== previousTokens);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || base === '' || tokens === '') return;
    const values = new FormData(event.currentTarget);
    await act('cash', {
      cashier: values.get('cashier'), openingBase: Number(base), openingTokens: Number(tokens), note: values.get('note'),
    }, 'Turno de caja abierto.');
  }
  return (
    <form onSubmit={save}>
      <h3>Abrir turno</h3>
      {previousBase !== null && <p>Base que dejó el turno anterior: <strong>{money.format(previousBase)}</strong></p>}
      {previousTokens !== null && <p>Fichas contadas al cierre anterior: <strong>{previousTokens}</strong></p>}
      <fieldset className="field-grid" disabled={locked}>
        <label>Nombre del cajero<input name="cashier" required maxLength={100} /></label>
        <label>Base contada (COP)<input type="number" min={0} max={1_000_000_000} step={1} value={base}
          required onChange={(event) => setBase(event.target.value)} /></label>
        <label>Fichas físicas al abrir<input type="number" min={0} max={1_000_000} step={1} value={tokens}
          required onChange={(event) => setTokens(event.target.value)} /></label>
        <label className="wide">{mismatch ? 'Explicación de la diferencia' : 'Nota de apertura (opcional)'}
          <input name="note" required={mismatch} maxLength={300} /></label>
      </fieldset>
      <button disabled={locked}>Abrir caja</button>
    </form>
  );
}

function RecoverOpeningTokens({ id, locked, act }: { id: number; locked: boolean; act: Action }) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const values = new FormData(event.currentTarget);
    await act('cash/' + id + '/opening-tokens', {
      openingTokens: Number(values.get('openingTokens')), note: values.get('note'),
    }, 'Conteo inicial de fichas registrado.');
  }
  return (
    <form onSubmit={save}>
      <h3>Completar conteo inicial de fichas</h3>
      <p>Este turno abrió antes de que se habilitara el conteo de fichas. Registra cuántas había al abrir el turno.</p>
      <fieldset className="field-grid" disabled={locked}>
        <label>Fichas al inicio del turno<input name="openingTokens" type="number" min={0} max={1_000_000} step={1} required /></label>
        <label>Cómo se obtuvo el conteo<input name="note" maxLength={300} required /></label>
      </fieldset>
      <button disabled={locked}>Guardar conteo inicial</button>
    </form>
  );
}

function MovementForm({ id, locked, act }: { id: number; locked: boolean; act: Action }) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    if (await act('cash/' + id + '/movements', {
      kind: values.get('kind'), amount: Number(values.get('amount')), category: values.get('category'), reason: values.get('reason'),
    }, 'Movimiento de caja registrado.')) form.reset();
  }
  return (
    <form onSubmit={save}>
      <h3>Registrar movimiento</h3>
      <fieldset className="field-grid" disabled={locked}>
        <label className="wide">Tipo de movimiento<select name="kind" defaultValue="sales_expense">
          {Object.entries(cashMovements).map(([kind, movement]) => <option key={kind} value={kind}>{movement.label}</option>)}
        </select></label>
        <label>Importe (COP)<input name="amount" type="number" min={1} max={1_000_000_000} step={1} required /></label>
        <label>Categoría<input name="category" placeholder="Ej. Cerveza" maxLength={80} required /></label>
        <label className="wide">Motivo<input name="reason" placeholder="Explica a qué corresponde" maxLength={300} required /></label>
      </fieldset>
      <button disabled={locked}>Guardar movimiento</button>
    </form>
  );
}

function Difference({ value, tokens = false }: { value: number | null; tokens?: boolean }) {
  if (value === null) return <span>—</span>;
  if (value === 0) return <span className="inbound">Cuadrado</span>;
  return <strong className={value < 0 ? 'outbound' : 'inbound'}>
    {value < 0 ? 'Faltante ' : 'Sobrante '}{tokens ? tokenCount(Math.abs(value)) : money.format(Math.abs(value))}
  </strong>;
}

function Reconciliation({ rows }: { rows: { name: string; expected: number; counted: number | null; difference: number | null }[] }) {
  return (
    <div className="cash-reconciliation">
      <table>
        <thead><tr><th scope="col">Fondo o medio</th><th scope="col">Esperado</th><th scope="col">Contado o verificado</th><th scope="col">Diferencia</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.name}>
          <th scope="row">{row.name}</th><td>{money.format(row.expected)}</td><td>{formatted(row.counted)}</td>
          <td><Difference value={row.difference} /></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function CloseForm({ detail, locked, act }: { detail: Detail; locked: boolean; act: Action }) {
  const [sales, setSales] = useState('');
  const [purchases, setPurchases] = useState('');
  const [transfer, setTransfer] = useState('');
  const [tokens, setTokens] = useState('');
  const [base, setBase] = useState(String(detail.shift.openingBase));
  const { shift, totals } = detail;
  const rows = [
    { name: 'Caja de ventas', expected: totals.salesExpected, value: sales },
    { name: 'Fondo para compras', expected: totals.purchasesExpected, value: purchases },
    { name: 'Transferencias', expected: totals.transferExpected, value: transfer },
  ].map(({ name, expected, value }) => ({
    name, expected, counted: value === '' ? null : Number(value), difference: value === '' ? null : Number(value) - expected,
  }));
  const tokenDifference = tokens === '' || totals.expectedTokens === null ? null : Number(tokens) - totals.expectedTokens;
  const mismatch = rows.some((row) => row.difference !== null && row.difference !== 0) ||
    (tokenDifference !== null && tokenDifference !== 0);
  const validBase = sales !== '' && base !== '' && Number(base) <= Number(sales);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || !validBase || tokens === '' || rows.some((row) => row.counted === null)) return;
    const values = new FormData(event.currentTarget);
    await act('cash/' + shift.id + '/close', {
      salesCounted: Number(sales), purchasesCounted: Number(purchases), transferConfirmed: Number(transfer),
      nextBase: Number(base), countedTokens: Number(tokens), note: values.get('note'),
    }, 'Cierre y entrega registrados.');
  }

  return (
    <form onSubmit={save}>
      <h3>Cuadrar y cerrar turno</h3>
      <fieldset className="field-grid" disabled={locked}>
        <label>Efectivo contado en ventas (COP)<input type="number" min={0} max={1_000_000_000} step={1} required
          value={sales} onChange={(event) => setSales(event.target.value)} /></label>
        <label>Efectivo contado para compras (COP)<input type="number" min={0} max={1_000_000_000} step={1} required
          value={purchases} onChange={(event) => setPurchases(event.target.value)} /></label>
        <label>Transferencias verificadas (COP)<input type="number" min={0} max={1_000_000_000} step={1} required
          value={transfer} onChange={(event) => setTransfer(event.target.value)} /></label>
        <label>Base para el próximo turno (COP)<input type="number" min={0} max={1_000_000_000} step={1} required
          value={base} onChange={(event) => setBase(event.target.value)} /></label>
        <label>Fichas físicas contadas al cierre<input type="number" min={0} max={1_000_000} step={1} required
          value={tokens} onChange={(event) => setTokens(event.target.value)} /></label>
        <label className="wide">{mismatch ? 'Explicación de las diferencias' : 'Nota de cierre (opcional)'}
          <input name="note" maxLength={300} required={mismatch} /></label>
      </fieldset>
      <Reconciliation rows={rows} />
      <p>Fichas esperadas: <strong>{totals.expectedTokens ?? '—'}</strong> · Diferencia: <Difference value={tokenDifference} tokens /></p>
      {!validBase && sales !== '' && base !== '' && <p role="alert">La base siguiente no puede superar el efectivo contado en ventas.</p>}
      {validBase && purchases !== '' && <p>Entrega al administrador: <strong>{money.format(Number(sales) - Number(base))}</strong> de ventas y{' '}
        <strong>{money.format(Number(purchases))}</strong> del fondo para compras.</p>}
      <button disabled={locked || !validBase || tokens === '' || rows.some((row) => row.counted === null)}>Guardar cierre y entrega</button>
    </form>
  );
}

function ShiftSummary({ detail }: { detail: Detail }) {
  const { shift, totals } = detail;
  return (
    <section aria-label="Resumen del turno">
      <div className="section-title"><h3>Turno #{shift.id} · {shift.cashier}</h3>
        <span>{shift.closedAt ? 'Cerrado ' + date.format(new Date(shift.closedAt)) : 'Abierto ' + date.format(new Date(shift.openedAt))}</span></div>
      <p>Base de apertura: <strong>{money.format(shift.openingBase)}</strong>{shift.openingNote ? ' · ' + shift.openingNote : ''}</p>
      {shift.previousBase !== null && shift.previousBase !== shift.openingBase &&
        <p>Base que dejó el turno anterior: <strong>{money.format(shift.previousBase)}</strong></p>}
      <dl className="cash-stats">
        <div><dt>Ventas registradas</dt><dd>{money.format(totals.salesTotal)}</dd></div>
        <div><dt>Cobros en efectivo</dt><dd>{money.format(totals.cashReceived)}</dd></div>
        <div><dt>Cobros por transferencia</dt><dd>{money.format(totals.transferExpected)}</dd></div>
        <div><dt>Abonos a cuentas</dt><dd>{money.format(totals.accountCollections)}</dd></div>
        <div><dt>Saldo pendiente de clientes</dt><dd>{money.format(totals.pendingBalance)}</dd></div>
        <div><dt>Valor de fichas recibidas en pagos</dt><dd>{money.format(totals.tokenAmount)}</dd></div>
      </dl>
      <Reconciliation rows={[
        { name: 'Caja de ventas', expected: totals.salesExpected, counted: shift.salesCounted, difference: totals.salesDifference },
        { name: 'Fondo para compras', expected: totals.purchasesExpected, counted: shift.purchasesCounted, difference: totals.purchasesDifference },
        { name: 'Transferencias', expected: totals.transferExpected, counted: shift.transferConfirmed, difference: totals.transferDifference },
      ]} />
      <section aria-label="Cuadre de fichas">
        <h4>Fichas físicas del turno</h4>
        <dl className="cash-stats">
          <div><dt>Al inicio</dt><dd>{shift.openingTokens ?? 'Sin conteo'}</dd></div>
          <div><dt>Entregadas en tejo</dt><dd>{totals.tokensIssued}</dd></div>
          <div><dt>Recibidas por canje</dt><dd>{totals.tokensRedeemed}</dd></div>
          <div><dt>Recibidas en pagos</dt><dd>{totals.tokensReceived}</dd></div>
          <div><dt>Esperadas al cierre</dt><dd>{totals.expectedTokens ?? '—'}</dd></div>
          {shift.closedAt && <>
            <div><dt>Contadas al cierre</dt><dd>{shift.countedTokens ?? 'Sin conteo'}</dd></div>
            <div><dt>Diferencia</dt><dd><Difference value={totals.tokenDifference} tokens /></dd></div>
          </>}
        </dl>
        {shift.previousTokens !== null && shift.openingTokens !== shift.previousTokens && <p>El turno anterior dejó {tokenCount(shift.previousTokens)}.</p>}
        {shift.tokenOpeningNote && <p>Nota del conteo inicial: {shift.tokenOpeningNote}</p>}
      </section>
      {shift.closedAt && <div className="cash-delivery">
        <h4>Entrega y base siguiente</h4>
        <p>Al administrador: <strong>{formatted(totals.salesDelivery)}</strong> de ventas y <strong>{formatted(totals.purchasesDelivery)}</strong> del fondo para compras.</p>
        <p>Base que quedó en caja: <strong>{formatted(shift.nextBase)}</strong>.</p>
        {shift.countedTokens !== null && <p>Fichas que quedan para el siguiente turno: <strong>{shift.countedTokens}</strong>.</p>}
        {shift.closingNote && <p>Nota de cierre: {shift.closingNote}</p>}
      </div>}
    </section>
  );
}

function Ledger({ detail }: { detail: Detail }) {
  return (
    <div className="ledger-columns">
      <section>
        <h4>Movimientos de los fondos</h4>
        {!detail.movements.length ? <p>Sin movimientos adicionales.</p> : <ul className="ledger-list">{detail.movements.map((movement) => (
          <li key={movement.id}>
            <div className="row-between"><strong>{cashMovements[movement.kind].label}</strong><strong>{money.format(movement.amount)}</strong></div>
            <time dateTime={movement.createdAt}>{date.format(new Date(movement.createdAt))}</time>
            <p>#{movement.id} · {movement.category} · {movement.reason}</p>
            {movement.inventoryLinks > 0 && <p>{movement.inventoryLinks} {movement.inventoryLinks === 1 ? 'entrada vinculada' : 'entradas vinculadas'} de inventario</p>}
          </li>
        ))}</ul>}
      </section>
      <section>
        <h4>Cobros y transferencias para verificar</h4>
        {!detail.payments.length ? <p>Sin cobros registrados.</p> : <ul className="ledger-list">{detail.payments.map((payment) => (
          <li key={payment.id}>
            <div className="row-between"><strong>{payment.name ?? 'Sin nombre'}</strong>
              <span>{payment.saleId ? 'Venta #' + payment.saleId : 'Abono #' + payment.id}</span></div>
            <time dateTime={payment.createdAt}>{date.format(new Date(payment.createdAt))}</time>
            <p>{[
              payment.cash ? 'Efectivo ' + money.format(payment.cash) : '',
              payment.transfer ? 'Transferencia ' + money.format(payment.transfer) : '',
              payment.tokens ? payment.tokens + ' fichas · ' + money.format(payment.tokens * payment.tokenValue) : '',
            ].filter(Boolean).join(' · ')}</p>
          </li>
        ))}</ul>}
      </section>
    </div>
  );
}

export function Cash({ onShiftChange }: { onShiftChange: (open: boolean) => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [history, setHistory] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<'active' | 'history'>('active');
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const write = useOperation();
  const locked = busy || Boolean(loadError);

  async function load() {
    setLoadError('');
    try {
      const current = await api<Dashboard>('cash');
      setDashboard(current);
      onShiftChange(Boolean(current.active));
    } catch (error) {
      setLoadError(message(error));
    }
  }

  useEffect(() => { void load(); }, []);

  async function select(id: number) {
    setSelected(id);
    setHistory(null);
    setError('');
    setBusy(true);
    try {
      setHistory(await api<Detail>('cash/' + id));
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string, data: object, success: string) {
    if (locked) return false;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await write(path, data);
      await load();
      setStatus(success);
      if (path.endsWith('/close')) {
        setView('history');
        await select(result.id);
      }
      return true;
    } catch (error) {
      setError(message(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function switchView(value: 'active' | 'history') {
    setView(value);
    setStatus('');
    setError('');
  }

  return (
    <section aria-labelledby="cash-title">
      <h2 id="cash-title">Caja</h2>
      <nav className="actions accounts-nav" aria-label="Secciones de caja">
        <button className="navigation" aria-pressed={view === 'active'} disabled={busy} onClick={() => switchView('active')}>Turno actual</button>
        <button className="navigation" aria-pressed={view === 'history'} disabled={busy} onClick={() => switchView('history')}>Historial de cierres</button>
      </nav>
      {loadError && <p role="alert">{loadError} <button className="secondary" onClick={() => void load()}>Actualizar datos</button></p>}
      {error && <p className="cash-error" role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      {!dashboard && !loadError && <p role="status">Cargando caja…</p>}
      {dashboard && view === 'active' && (dashboard.active ? (
        <div className="cash-layout">
          <ShiftSummary detail={dashboard.active} />
          <MovementForm id={dashboard.active.shift.id} key={dashboard.active.shift.id} locked={locked} act={act} />
          <Ledger detail={dashboard.active} />
          {dashboard.active.shift.openingTokens === null
            ? <RecoverOpeningTokens id={dashboard.active.shift.id} locked={locked} act={act} />
            : <CloseForm detail={dashboard.active} key={'close-' + dashboard.active.shift.id} locked={locked} act={act} />}
        </div>
      ) : <Opening previousBase={dashboard.previousBase} previousTokens={dashboard.previousTokens}
        key={dashboard.recent[0]?.id ?? 'first'} locked={locked} act={act} />)}
      {dashboard && view === 'history' && <>
        {!dashboard.recent.length ? <p>Todavía no hay cierres registrados.</p> : <ul className="account-list">{dashboard.recent.map((item) => (
          <li key={item.id}><button className="secondary row-between" aria-pressed={selected === item.id} disabled={busy} onClick={() => void select(item.id)}>
            <span>Turno #{item.id} · {item.cashier}</span><span>{date.format(new Date(item.closedAt!))}</span>
          </button></li>
        ))}</ul>}
        {history && <div className="cash-layout"><ShiftSummary detail={history} /><Ledger detail={history} /></div>}
      </>}
    </section>
  );
}
