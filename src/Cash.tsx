import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cashMovementCorrectionText, cashMovements, expectedCashCounts, maxPurchaseFunding, purchaseFundingCategory,
  type CashMovementCorrection, type CashMovementKind, type SavedCashCount } from '../shared/cash';
import { api, message, money, useOperation } from './Accounts';
import { BillCounter } from './CashTools';
import { CashBackups } from './CashBackups';
import { pendingGamesTotal, type PendingGames } from '../shared/pending-games';
import { courtLabel } from '../shared/tejo';

type Shift = {
  id: number; cashier: string; openedAt: string; openingBase: number; previousBase: number | null; openingNote: string;
  closedAt: string | null; salesCounted: number | null; purchasesCounted: number | null; transferConfirmed: number | null;
  nextBase: number | null; closingNote: string | null;
  openingTokens: number | null; previousTokens: number | null; countedTokens: number | null; tokenOpeningNote: string | null;
  reconciliationRevision: number;
};
type Totals = {
  salesCount: number; salesTotal: number; cashReceived: number; transferExpected: number;
  tokensReceived: number; tokenAmount: number; accountCollections: number; pendingBalance: number;
  tokensIssued: number; tokensRedeemed: number; salesExpected: number; purchasesExpected: number;
  expectedTokens: number | null; tokenDifference: number | null;
  salesDifference: number | null; purchasesDifference: number | null; transferDifference: number | null;
  salesDelivery: number | null; purchasesDelivery: number | null;
};
type Movement = CashMovementCorrection & {
  id: number; kind: CashMovementKind; amount: number; category: string; reason: string; createdAt: string; inventoryLinks: number;
  remoteRequestedAt: string | null;
};
type Payment = {
  id: number; saleId: number | null; name: string | null; cash: number; transfer: number;
  tokens: number; tokenValue: number; createdAt: string;
  voided: number | null; voidReason: string | null;
};
type Detail = {
  shift: Shift; totals: Totals; movements: Movement[]; payments: Payment[]; counts: SavedCashCount[]; requiresRecount: boolean;
  pendingGames: PendingGames | null; gamesRevision: string | null;
};
type Dashboard = { active: Detail | null; previousBase: number | null; previousTokens: number | null; recent: Shift[] };
type Action = (path: string, data: object, success: string) => Promise<boolean>;
const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota' });
const formatted = (amount: number | null) => amount === null ? '—' : money.format(amount);
const tokenCount = (amount: number) => amount + (amount === 1 ? ' ficha' : ' fichas');

function Opening({ operatorName, previousBase, previousTokens, locked, act }: {
  operatorName: string; previousBase: number | null; previousTokens: number | null; locked: boolean; act: Action;
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
      openingBase: Number(base), openingTokens: Number(tokens), note: values.get('note'),
    }, 'Turno de caja abierto.');
  }
  return (
    <form onSubmit={save}>
      <h3>Abrir turno</h3>
      <p>Cajero: <strong>{operatorName}</strong></p>
      {previousBase !== null && <p>Base que dejó el turno anterior: <strong>{money.format(previousBase)}</strong></p>}
      {previousTokens !== null && <p>Fichas contadas al cierre anterior: <strong>{previousTokens}</strong></p>}
      <fieldset className="field-grid" disabled={locked}>
        <label>Base contada (COP)<input type="number" min={0} max={1_000_000_000} step={1} value={base}
          required onChange={(event) => setBase(event.target.value)} /></label>
        <label>Fichas físicas al abrir<input type="number" min={0} max={1_000_000} step={1} value={tokens}
          required onChange={(event) => setTokens(event.target.value)} /></label>
        <label className="wide">{mismatch ? 'Explicación de la diferencia' : 'Nota de apertura (opcional)'}
          <input name="note" required={mismatch} maxLength={300} /></label>
      </fieldset>
      <BillCounter disabled={locked} targets={[{ label: 'Usar como base contada', use: setBase }]} />
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
  const [kind, setKind] = useState<CashMovementKind>('sales_expense');
  const staffPayment = kind === 'staff_payment';
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const note = String(values.get('reason') ?? '').trim();
    if (await act('cash/' + id + '/movements', {
      kind, amount: Number(values.get('amount')), category: values.get('category'),
      reason: staffPayment && !note ? 'Pago de jornada' : note,
    }, staffPayment ? 'Pago diario al personal registrado.' : 'Movimiento de caja registrado.')) {
      form.reset();
      setKind('sales_expense');
    }
  }
  return (
    <form onSubmit={save}>
      <h3>Registrar movimiento</h3>
      <fieldset className="field-grid" disabled={locked}>
        <label className="wide">Tipo de movimiento<select name="kind" value={kind}
          onChange={(event) => setKind(event.target.value as CashMovementKind)}>
          {Object.entries(cashMovements).filter(([kind]) => kind !== 'purchase_in')
            .map(([kind, movement]) => <option key={kind} value={kind}>{movement.label}</option>)}
        </select></label>
        <label>Importe (COP)<input name="amount" type="number" min={1} max={1_000_000_000} step={1} required /></label>
        <label>{staffPayment ? 'Nombre del empleado' : 'Categoría'}
          <input key={staffPayment ? 'employee' : 'category'} name="category" placeholder={staffPayment ? 'Ej. María Pérez' : 'Ej. Cerveza'} maxLength={80} required /></label>
        <label className="wide">{staffPayment ? 'Nota (opcional)' : 'Motivo'}
          <input key={staffPayment ? 'staff-note' : 'reason'} name="reason" placeholder={staffPayment ? 'Ej. Jornada de hoy' : 'Explica a qué corresponde'}
            maxLength={300} required={!staffPayment} /></label>
      </fieldset>
      {staffPayment && <p>El pago se descontará del efectivo de la caja de ventas.</p>}
      <button disabled={locked}>{staffPayment ? 'Registrar pago al personal' : 'Guardar movimiento'}</button>
    </form>
  );
}

function PurchaseFund({ id, expected, admin, locked, act }: {
  id: number; expected: number; admin: boolean; locked: boolean; act: Action;
}) {
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    let timer: number;
    setBalance(null);
    async function refresh() {
      try {
        const fund = await api<{ shiftId: number | null; balance: number | null }>('cash/purchase-fund');
        if (current && fund.shiftId === id) setBalance(fund.balance);
      } catch {
        // Keep showing the latest confirmed balance and try again.
      } finally {
        if (current) timer = window.setTimeout(() => void refresh(), 10_000);
      }
    }
    void refresh();
    return () => { current = false; window.clearTimeout(timer); };
  }, [id, expected]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    if (await act('cash/' + id + '/movements', {
      kind: 'purchase_in', category: purchaseFundingCategory, amount: Number(fields.get('amount')),
      reason: String(fields.get('note') ?? '').trim() || 'Efectivo entregado para compras',
    }, 'Aporte registrado en el fondo para compras.')) form.reset();
  }
  return <section aria-labelledby="purchase-fund-title">
    <h3 id="purchase-fund-title">Fondo para compras</h3>
    <p>Disponible según caja · <strong>{money.format(balance ?? expected)}</strong></p>
    {admin && <form onSubmit={save}>
      <fieldset className="field-grid" disabled={locked}>
        <label>Efectivo que dejaste para compras (COP)<input name="amount" type="number" inputMode="numeric"
          min={1} max={maxPurchaseFunding} step={1} required /></label>
        <label>Nota (opcional)<input name="note" maxLength={300} placeholder="Ej. Pedido de cerveza" /></label>
      </fieldset>
      <button disabled={locked}>Agregar al fondo para compras</button>
    </form>}
  </section>;
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

function CountForm({ id, reconciliationRevision, previous, locked, act, cancel }: {
  id: number; reconciliationRevision: number; previous?: SavedCashCount; locked: boolean; act: Action; cancel?: () => void;
}) {
  const [sales, setSales] = useState('');
  const [purchases, setPurchases] = useState('');
  const [transfer, setTransfer] = useState('');
  const [tokens, setTokens] = useState('');
  const ready = [sales, purchases, transfer, tokens].every((value) => value !== '');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || !ready) return;
    const values = new FormData(event.currentTarget);
    await act('cash/' + id + '/count', {
      salesCounted: Number(sales), purchasesCounted: Number(purchases), transferConfirmed: Number(transfer),
      countedTokens: Number(tokens), previousCountId: previous?.id ?? null, reason: values.get('reason') ?? '',
      reconciliationRevision,
    }, previous ? 'Nuevo conteo registrado.' : 'Conteo registrado.');
  }

  return <form className="cash-close" onSubmit={save}>
    <h3>{previous ? 'Registrar un recuento' : '1. Registrar conteo de cierre'}</h3>
    <p>{previous ? 'El primer conteo queda guardado. Registra lo que contaste de nuevo y el motivo.'
      : 'Escribe lo que contaste y verificaste. Al confirmar, verás los valores esperados y las diferencias.'}</p>
    <fieldset className="field-grid" disabled={locked}>
      <label>Efectivo contado en ventas (COP)<input type="number" inputMode="numeric" min={0} max={1_000_000_000} step={1} required
        value={sales} onChange={(event) => setSales(event.target.value)} /></label>
      <label>Efectivo contado para compras (COP)<input type="number" inputMode="numeric" min={0} max={1_000_000_000} step={1} required
        value={purchases} onChange={(event) => setPurchases(event.target.value)} /></label>
      <label>Transferencias verificadas (COP)<input type="number" inputMode="numeric" min={0} max={1_000_000_000} step={1} required
        value={transfer} onChange={(event) => setTransfer(event.target.value)} /></label>
      <label>Fichas físicas contadas al cierre<input type="number" inputMode="numeric" min={0} max={1_000_000} step={1} required
        value={tokens} onChange={(event) => setTokens(event.target.value)} /></label>
      {previous && <label className="wide">Motivo del recuento<input name="reason" maxLength={300} required /></label>}
    </fieldset>
    <BillCounter disabled={locked} targets={[
      { label: 'Usar para caja de ventas', use: setSales },
      { label: 'Usar para fondo de compras', use: setPurchases },
    ]} />
    <div className="actions">
      <button disabled={locked || !ready}>{previous ? 'Guardar recuento y revisar' : 'Confirmar conteo y revisar'}</button>
      {cancel && <button type="button" className="secondary" disabled={locked} onClick={cancel}>Volver a la revisión</button>}
    </div>
  </form>;
}

function CountHistory({ counts }: { counts: SavedCashCount[] }) {
  return <details className="count-history">
    <summary>Historial de conteos ({counts.length})</summary>
    <ol>{counts.map((count, index) => <li key={count.id}>
      <strong>{index === 0 ? 'Conteo inicial' : 'Recuento ' + index}</strong> · {date.format(new Date(count.createdAt))}
      <p>Ventas {formatted(count.salesCounted)} · Compras {formatted(count.purchasesCounted)} ·
        Transferencias {formatted(count.transferConfirmed)} · {tokenCount(count.countedTokens)}</p>
      {count.reason && <p>Motivo: {count.reason}</p>}
    </li>)}</ol>
  </details>;
}

function PendingGamesSummary({ games, closed = false }: { games: PendingGames | null; closed?: boolean }) {
  return <section aria-label="Juegos pendientes por liquidar">
    <h4>{closed ? 'Juegos pendientes al cierre' : 'Juegos pendientes por liquidar'}</h4>
    {!games ? <p>Este cierre se guardó antes de registrar el detalle de juegos pendientes.</p>
      : !games.billiards.length && !games.tejo.length ? <p>Sin juegos pendientes por liquidar.</p> : <>
        <p>Total por liquidar <strong>{money.format(pendingGamesTotal(games))}</strong> · Corte {date.format(new Date(games.capturedAt))}</p>
        <ul className="sale-lines">
          {games.billiards.map((item) => <li key={item.sessionId}>
            <span>Billar · mesa {item.table} · Productos {money.format(item.products)} · {item.running ? 'Tiempo estimado' : 'Tiempo'} {money.format(item.time)}</span>
            <strong>{money.format(item.products + item.time)}</strong>
          </li>)}
          {games.tejo.map((item) => <li key={item.roundId}><span>{courtLabel(item.courtType, item.court)} · chico {item.round} sin asignar</span>
            <strong>{money.format(item.amount)}</strong></li>)}
        </ul>
        <p>Estos importes se registran como ventas al liquidar la mesa o asignar el chico.</p>
      </>}
  </section>;
}

function ReviewClose({ detail, count, locked, act, recount }: {
  detail: Detail; count: SavedCashCount; locked: boolean; act: Action; recount: () => void;
}) {
  const [base, setBase] = useState(String(detail.shift.openingBase));
  const [gamesConfirmed, setGamesConfirmed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const { shift, totals } = detail;
  const rows = [
    { name: 'Caja de ventas', expected: totals.salesExpected, counted: count.salesCounted },
    { name: 'Fondo para compras', expected: totals.purchasesExpected, counted: count.purchasesCounted },
    { name: 'Transferencias', expected: totals.transferExpected, counted: count.transferConfirmed },
  ].map((row) => ({ ...row, difference: row.counted - row.expected }));
  const tokenDifference = totals.expectedTokens === null ? null : count.countedTokens - totals.expectedTokens;
  const mismatch = rows.some((row) => row.difference !== 0) || (tokenDifference !== null && tokenDifference !== 0);
  const validBase = base !== '' && Number(base) <= count.salesCounted;
  const baseChanged = base !== '' && Number(base) !== shift.openingBase;
  const noteRequired = baseChanged || mismatch;
  const noteLabel = baseChanged
    ? mismatch ? 'Explicación del cambio de base y de las diferencias' : 'Motivo del cambio de base'
    : mismatch ? 'Explicación de las diferencias' : 'Nota de cierre (opcional)';
  const gamesPending = Boolean(detail.pendingGames && (detail.pendingGames.billiards.length || detail.pendingGames.tejo.length));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || !validBase || (gamesPending && !gamesConfirmed)) return;
    const values = new FormData(event.currentTarget);
    await act('cash/' + shift.id + '/close', {
      countId: count.id, expected: expectedCashCounts(totals), nextBase: Number(base), note: values.get('note'),
      gamesRevision: detail.gamesRevision, pendingGamesConfirmed: gamesConfirmed,
    }, 'Cierre y entrega registrados.');
  }

  return <form className="cash-close" onSubmit={save}>
    <h3 ref={heading} tabIndex={-1}>2. Revisar y cerrar turno</h3>
    <Reconciliation rows={rows} />
    <p>Fichas esperadas: <strong>{totals.expectedTokens ?? '—'}</strong> · Contadas: <strong>{count.countedTokens}</strong> ·{' '}
      <Difference value={tokenDifference} tokens /></p>
    <p>Base de apertura <strong>{money.format(shift.openingBase)}</strong></p>
    <fieldset className="field-grid" disabled={locked}>
      <label>Base para el próximo turno (COP)<input type="number" inputMode="numeric" min={0} max={1_000_000_000} step={1} required
        value={base} onChange={(event) => setBase(event.target.value)} /></label>
      <label>{noteLabel}
        <input name="note" maxLength={300} required={noteRequired}
          pattern={noteRequired ? '.*\\S.*' : undefined} /></label>
    </fieldset>
    {gamesPending && <label className="inline-check"><input type="checkbox" required disabled={locked}
      checked={gamesConfirmed} onChange={(event) => setGamesConfirmed(event.target.checked)} />
      Revisé las mesas y los chicos indicados. Los dejo pendientes por liquidar.</label>}
    {base !== '' && !validBase && <p role="alert">La base siguiente no puede superar el efectivo contado en ventas.</p>}
    {validBase && <p>Entrega al administrador: <strong>{money.format(count.salesCounted - Number(base))}</strong> de ventas y{' '}
      <strong>{money.format(count.purchasesCounted)}</strong> del fondo para compras.</p>}
    <div className="actions">
      <button disabled={locked || !validBase || (gamesPending && !gamesConfirmed)}>Guardar cierre y entrega</button>
      <button type="button" className="secondary" disabled={locked} onClick={recount}>Hacer un recuento</button>
    </div>
    <CountHistory counts={detail.counts} />
  </form>;
}

function ActiveShift({ detail, admin, locked, act, refresh }: { detail: Detail; admin: boolean; locked: boolean; act: Action; refresh: () => void }) {
  const [recountFor, setRecountFor] = useState<number | null>(null);
  const { shift } = detail;
  const count = detail.counts.at(-1);
  const recount = count?.id === recountFor;
  return <div className="cash-layout">
    <section aria-label="Turno de caja">
      <h3>Turno #{shift.id} · {shift.cashier}</h3>
      <span>Abierto {date.format(new Date(shift.openedAt))}</span>
    </section>
    <PurchaseFund id={shift.id} expected={detail.totals.purchasesExpected} admin={admin} locked={locked} act={act} />
    <PendingGamesSummary games={detail.pendingGames} />
    {detail.requiresRecount && <p className="cash-error" role="status">
      El conteo anterior quedó desactualizado. Vuelve a contar el efectivo y las fichas y verifica las transferencias.
    </p>}
    {shift.openingTokens === null ? <RecoverOpeningTokens id={shift.id} locked={locked} act={act} />
      : !count || recount || detail.requiresRecount ? <>
        <CountForm key={(count?.id ?? 'primer-conteo') + ':' + shift.reconciliationRevision} id={shift.id}
          reconciliationRevision={shift.reconciliationRevision} previous={count} locked={locked} act={act}
          cancel={count && !detail.requiresRecount ? () => setRecountFor(null) : undefined} />
        {count && <CountHistory counts={detail.counts} />}
      </>
        : <ReviewClose key={count.id + ':' + detail.gamesRevision} detail={detail} count={count} locked={locked}
          act={act} recount={() => setRecountFor(count.id)} />}
    <MovementForm id={shift.id} locked={locked} act={act} />
    <details className="count-history" onToggle={(event) => { if (event.currentTarget.open) refresh(); }}>
      <summary>{count ? 'Ver movimientos y cobros del turno' : 'Ver movimientos del turno'}</summary>
      <button type="button" className="secondary" disabled={locked} onClick={refresh}>Actualizar movimientos</button>
      <Ledger detail={detail} showPayments={Boolean(count)} />
    </details>
  </div>;
}

function ShiftSummary({ detail }: { detail: Detail }) {
  const { shift, totals } = detail;
  return (
    <section aria-label="Resumen del turno">
      <div className="section-title"><div>
        <h3>Turno #{shift.id} · {shift.cashier}</h3>
        <span>{shift.closedAt ? 'Cerrado ' + date.format(new Date(shift.closedAt)) : 'Abierto ' + date.format(new Date(shift.openedAt))}</span>
      </div>
        {shift.closedAt && <a className="download-report" href={'/api/cash/' + shift.id + '/report.pdf'} download>Descargar informe PDF</a>}
      </div>
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
      <PendingGamesSummary games={detail.pendingGames} closed />
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

function Ledger({ detail, showPayments = true }: { detail: Detail; showPayments?: boolean }) {
  return (
    <div className="ledger-columns">
      <section>
        <h4>Movimientos de los fondos</h4>
        {!detail.movements.length ? <p>Sin movimientos adicionales.</p> : <ul className="ledger-list">{detail.movements.map((movement) => (
          <li key={movement.id}>
            <div className="row-between"><strong>{cashMovements[movement.kind].label}</strong><strong>{money.format(movement.amount)}</strong></div>
            <time dateTime={movement.createdAt}>{date.format(new Date(movement.createdAt))}</time>
            <p>#{movement.id} · {movement.category} · {movement.reason}</p>
            {movement.correctedAt && <p>Corregido el {date.format(new Date(movement.correctedAt))} · {cashMovementCorrectionText(movement, money.format)}</p>}
            {movement.remoteRequestedAt && <p>Enviado desde el panel móvil · {date.format(new Date(movement.remoteRequestedAt))}</p>}
            {movement.inventoryLinks > 0 && <p>{movement.inventoryLinks} {movement.inventoryLinks === 1 ? 'entrada vinculada' : 'entradas vinculadas'} de inventario</p>}
          </li>
        ))}</ul>}
      </section>
      {showPayments && <section>
        <h4>Cobros y transferencias para verificar</h4>
        {!detail.payments.length ? <p>Sin cobros registrados.</p> : <ul className="ledger-list">{detail.payments.map((payment) => (
          <li key={payment.id}>
            <div className="row-between"><strong>{payment.name ?? 'Sin nombre'}</strong>
              <span>{payment.saleId ? 'Venta #' + payment.saleId : 'Abono #' + payment.id}
                {payment.voided ? (payment.saleId ? ' · Anulada' : ' · Anulado') : ''}</span></div>
            <time dateTime={payment.createdAt}>{date.format(new Date(payment.createdAt))}</time>
            <p>{[
              payment.cash ? 'Efectivo ' + money.format(payment.cash) : '',
              payment.transfer ? 'Transferencia ' + money.format(payment.transfer) : '',
              payment.tokens ? payment.tokens + ' fichas · ' + money.format(payment.tokens * payment.tokenValue) : '',
            ].filter(Boolean).join(' · ')}</p>
            {payment.voidReason && <p>Motivo de anulación · {payment.voidReason}</p>}
          </li>
        ))}</ul>}
      </section>}
    </div>
  );
}

export function Cash({ operatorName, admin, onShiftChange }: { operatorName: string; admin: boolean; onShiftChange: (open: boolean) => void }) {
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
      if (path.endsWith('/count') || path.endsWith('/close')) await load();
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
        <ActiveShift key={dashboard.active.shift.id} detail={dashboard.active} admin={admin} locked={locked} act={act} refresh={() => void load()} />
      ) : <Opening operatorName={operatorName} previousBase={dashboard.previousBase} previousTokens={dashboard.previousTokens}
        key={dashboard.recent[0]?.id ?? 'first'} locked={locked} act={act} />)}
      {dashboard && view === 'history' && <>
        {!dashboard.recent.length ? <p>Todavía no hay cierres registrados.</p> : <ul className="account-list">{dashboard.recent.map((item) => (
          <li key={item.id}><button className="secondary row-between" aria-pressed={selected === item.id} disabled={busy} onClick={() => void select(item.id)}>
            <span>Turno #{item.id} · {item.cashier}</span><span>{date.format(new Date(item.closedAt!))}</span>
          </button></li>
        ))}</ul>}
        {history && <div className="cash-layout">
          <ShiftSummary detail={history} />
          {history.counts.length > 0 && <CountHistory counts={history.counts} />}
          <Ledger detail={history} />
        </div>}
      </>}
      <CashBackups refresh={dashboard?.recent[0]?.id ?? 0} />
    </section>
  );
}
