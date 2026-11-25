import { useEffect, useRef, useState, type FormEvent } from 'react';
import { accountTokenValue, cashChange, mixedCreditPlan } from '../shared/tender';
import { CashChangeField } from './CashTools';
import { AccountPicker } from './CustomerLookup';
import { ConsumptionProducts, ProductLookup } from './ProductPicker';
import { billiardTables, durationLabel, elapsedSeconds, timeCharge } from '../shared/billiard';
import { api, emptyPayment, label, message, MixedCreditField, money, PaymentFields, TokenQuantity, totalPayment, useOperation,
  type Account, type PaymentInput, type Product } from './Accounts';

type Line = { id: number; label: string; quantity: number; unitPrice: number };
type Session = {
  id: number; tableNumber: number; rate: number; startedAt: number;
  stoppedAt: number | null; closedAt: number | null; canceledAt: number | null; pausedMs: number;
  seconds: number; time: number; total: number; items: Line[];
};
type Closed = Session & { shares: { saleId: number; name: string | null; total: number }[] };
type Dashboard = { rate: number; active: Session[]; recent: Closed[] };
type Part = { key: number; account: string; amounts: number[]; payment: PaymentInput; credit: string };

const sessionDate = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/Bogota',
});

function SessionHours({ session }: { session: Session }) {
  return <dl className="session-hours">
    <div><dt>Hora de inicio</dt><dd><time dateTime={new Date(session.startedAt).toISOString()}>{sessionDate.format(session.startedAt)}</time></dd></div>
    <div><dt>Hora de fin</dt><dd>{session.stoppedAt === null ? 'En juego' :
      <time dateTime={new Date(session.stoppedAt).toISOString()}>{sessionDate.format(session.stoppedAt)}</time>}</dd></div>
  </dl>;
}

function BillSplit({ session, accounts, locked, onClose }: {
  session: Session;
  accounts: Account[];
  locked: boolean;
  onClose: (participants: object[]) => Promise<boolean>;
}) {
  const nextKey = useRef(2);
  const lines = [{ name: 'Tiempo de juego', total: session.time }, ...session.items.map((item) => ({
    name: item.quantity + ' × ' + item.label, total: item.quantity * item.unitPrice,
  }))];
  const [parts, setParts] = useState<Part[]>(() => [{
    key: 1, account: '', amounts: lines.map((line) => line.total), payment: emptyPayment, credit: '',
  }]);
  const totals = parts.map((part) => part.amounts.reduce((sum, amount) => sum + amount, 0));
  const remainders = lines.map((line, index) => line.total - parts.reduce((sum, part) => sum + (part.amounts[index] ?? 0), 0));
  const named = parts.filter((part, index) => part.account && totals[index] > 0).map((part) => part.account);
  const duplicateAccounts = new Set(named).size !== named.length;
  const ready = !duplicateAccounts && remainders.every((value) => value === 0) && parts.every((part, index) => {
    const paid = totalPayment(part.payment);
    const remaining = totals[index] - paid;
    return remaining >= 0 && (part.account || remaining === 0) &&
      (totals[index] === 0 || mixedCreditPlan(remaining, part.credit).valid);
  });

  function divideEqually() {
    setParts((previous) => previous.map((part, index) => ({
      ...part, amounts: lines.map((line) => Math.floor(line.total / previous.length) +
        Number(index < line.total % previous.length)),
    })));
  }

  function updatePart(key: number, fields: Partial<Part>) {
    setParts((previous) => previous.map((part) => part.key === key ? { ...part, ...fields } : part));
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || !ready) return;
    void onClose(parts.flatMap((part, index) => totals[index] === 0 ? [] : [{
      accountId: part.account ? Number(part.account) : null,
      time: part.amounts[0],
      items: session.items.flatMap((item, itemIndex) => part.amounts[itemIndex + 1] > 0
        ? [{ id: item.id, amount: part.amounts[itemIndex + 1] }] : []),
      payment: part.payment,
    }]));
  }

  return (
    <form onSubmit={save}>
      <div className="section-title"><h3>Repartir y liquidar</h3><strong>{money.format(session.total)}</strong></div>
      <fieldset className="plain-fieldset" disabled={locked}>
        {session.total > 0 && <>
          <div className="actions">
            <button className="secondary" type="button" disabled={parts.length >= 20} onClick={() => {
              const key = nextKey.current++;
              setParts((previous) => [...previous, { key, account: '', amounts: lines.map(() => 0), payment: emptyPayment, credit: '' }]);
            }}>Agregar persona</button>
            {parts.length > 1 && <button className="secondary" type="button" onClick={divideEqually}>Dividir todo por igual</button>}
          </div>
          {parts.map((part, index) => (
            <fieldset className="bill-part" key={part.key}>
              <legend>Persona {index + 1} · {money.format(totals[index])}</legend>
              <AccountPicker accounts={accounts} label="Cuenta del cliente" value={part.account}
                onChange={(account) => updatePart(part.key, { account })} />
              <div className="field-grid">
                {lines.map((line, lineIndex) => line.total > 0 && (
                  <label key={lineIndex}>{line.name} <span>({money.format(line.total)})</span>
                    <input type="number" min={0} max={line.total} step={1} value={part.amounts[lineIndex] || ''}
                      placeholder="0" onChange={(event) => updatePart(part.key, {
                        amounts: lines.map((_, cell) => cell === lineIndex ? Number(event.target.value) : part.amounts[cell] ?? 0),
                      })} />
                  </label>
                ))}
              </div>
              <PaymentFields value={part.payment} onChange={(payment) => updatePart(part.key, { payment })} />
              {totals[index] > 0 && <MixedCreditField remaining={totals[index] - totalPayment(part.payment)} amount={part.credit}
                onChange={(credit) => updatePart(part.key, { credit })} hasAccount={Boolean(part.account)} />}
              <div className="actions">
                {totals[index] > 0 && <button type="button" className="secondary"
                  onClick={() => updatePart(part.key, { payment: { ...emptyPayment, cash: totals[index] }, credit: '' })}>Pagar esta parte en efectivo</button>}
                {parts.length > 1 && <button type="button" className="secondary"
                  onClick={() => setParts((previous) => previous.filter((entry) => entry.key !== part.key))}>Quitar persona {index + 1}</button>}
              </div>
              {totals[index] < totalPayment(part.payment) && <p role="alert">El pago supera su parte.</p>}
            </fieldset>
          ))}
          {duplicateAccounts && <p role="alert">Agrupa los importes de cada cuenta por nombre en una sola parte.</p>}
          {remainders.some((amount) => amount !== 0) && <ul className="sale-lines">{remainders.map((amount, index) => amount !== 0 && (
            <li key={index}><span>{lines[index].name}</span><strong>{amount > 0 ? 'Falta asignar ' : 'Asignado de más '} {money.format(Math.abs(amount))}</strong></li>
          ))}</ul>}
        </>}
        <button disabled={!ready}>{session.total === 0 ? 'Cerrar sin cargo' : 'Liquidar y liberar mesa'}</button>
      </fieldset>
    </form>
  );
}

function AddConsumption({ products, locked, onDeliver }: {
  products: Product[];
  locked: boolean;
  onDeliver: (product: Product, quantity: number) => Promise<boolean>;
}) {
  const [productId, setProductId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [quantity, setQuantity] = useState('1');
  const quantityInput = useRef<HTMLInputElement>(null);
  const product = products.find((value) => value.id === productId);
  const units = Number(quantity);
  const ready = !locked && product && Number.isInteger(units) && units >= 1 && units <= product.stock;

  function choose(selected: Product) {
    setProductId(selected.id);
    setQuery('');
    quantityInput.current?.focus();
    quantityInput.current?.select();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    if (await onDeliver(product, units)) {
      setProductId(null);
      setQuantity('1');
    }
  }
  return (
    <form onSubmit={save}>
      <h3>Registrar consumo</h3>
      <fieldset className="field-grid" disabled={locked}>
        <ProductLookup products={products} selected={product} query={query} required onChoose={choose}
          onQueryChange={(value) => { setProductId(null); setQuery(value); }} />
        <label>Cantidad<input ref={quantityInput} type="number" inputMode="numeric" min={1} max={product?.stock ?? 1} step={1} required value={quantity}
          onChange={(event) => setQuantity(event.target.value)} /></label>
      </fieldset>
      {products.length > 0 && <button disabled={!ready}>Registrar entrega</button>}
      <ConsumptionProducts key={query} products={products} query={query} action="Seleccionar" onChoose={choose}
        unavailable={() => locked} selectedId={product?.id} />
    </form>
  );
}

function TablePayment({ session, accounts, locked, onClose }: {
  session: Session; accounts: Account[]; locked: boolean; onClose: (participants: object[]) => Promise<boolean>;
}) {
  const [split, setSplit] = useState(false);
  const [method, setMethod] = useState<'cash' | 'transfer' | 'tokens' | 'mixed' | 'credit'>('cash');
  const [owner, setOwner] = useState('');
  const [mixedCredit, setMixedCredit] = useState('');
  const [payment, setPayment] = useState(emptyPayment);
  const [received, setReceived] = useState('');
  const charge = method === 'cash' ? { ...emptyPayment, cash: session.total }
    : method === 'transfer' ? { ...emptyPayment, transfer: session.total } : method === 'mixed' ? payment
      : method === 'tokens' ? { ...emptyPayment, tokens: payment.tokens } : emptyPayment;
  const balance = session.total - totalPayment(charge);
  const change = cashChange(charge.cash, received);
  const ready = session.total === 0 || (balance >= 0 && (balance === 0 || owner !== '') &&
    (method !== 'mixed' || mixedCreditPlan(balance, mixedCredit).valid) &&
    (method !== 'tokens' || (Number.isInteger(payment.tokens) && payment.tokens > 0)) &&
    (charge.cash === 0 || change === null || (Number.isInteger(change) && change >= 0)));
  if (split) return <><BillSplit session={session} accounts={accounts} locked={locked} onClose={onClose} />
    <button type="button" className="secondary" disabled={locked} onClick={() => setSplit(false)}>Volver al cobro sencillo</button></>;

  return <form onSubmit={(event) => {
    event.preventDefault();
    if (!ready || locked) return;
    void onClose(session.total === 0 ? [] : [{
      accountId: owner ? Number(owner) : null, time: session.time,
      items: session.items.filter((item) => item.unitPrice > 0).map((item) => ({ id: item.id, amount: item.quantity * item.unitPrice })),
      payment: charge,
    }]);
  }}>
    <div className="section-title"><h3>Cobrar mesa</h3><strong>{money.format(session.total)}</strong></div>
    <fieldset className="plain-fieldset" disabled={locked}>
      {session.total > 0 && <>
        <div className="actions">
          {([['cash', 'Efectivo'], ['transfer', 'Transferencia'], ['tokens', 'Fichas'], ['mixed', 'Mixto'], ['credit', 'Fiado']] as const)
            .map(([id, name]) => <button type="button" className="secondary" key={id} aria-pressed={method === id}
              onClick={() => { setMethod(id); setReceived(''); }}>{name}</button>)}
        </div>
        {method === 'tokens' && <div className="space-above">
          <TokenQuantity count={payment.tokens} rate={accountTokenValue} onChange={(tokens) => setPayment({ ...payment, tokens })} />
          {payment.tokens > 0 && balance > 0 && <div className="row-between">
            <strong>Queda por pagar {money.format(balance)}</strong>
            <button className="secondary" type="button" onClick={() => {
              setPayment({ ...emptyPayment, tokens: payment.tokens, cash: balance });
              setMixedCredit('');
              setMethod('mixed');
            }}>Completar en efectivo</button>
          </div>}
        </div>}
        {method === 'mixed' && <PaymentFields value={payment} onChange={setPayment} />}
        {method === 'mixed' && <MixedCreditField remaining={balance} amount={mixedCredit} onChange={setMixedCredit}
          hasAccount={Boolean(owner)} />}
        <div className="space-above">
          <AccountPicker accounts={accounts} label={'Cuenta del cliente' + (balance === 0 ? ' (opcional)' : '')}
            value={owner} required={balance > 0} onChange={setOwner} />
        </div>
        {charge.cash > 0 && <CashChangeField due={charge.cash} received={received} onChange={setReceived} />}
        {balance < 0 && <p role="alert">El pago supera el total de la mesa.</p>}
        {method !== 'mixed' && balance > 0 && owner && <p>Saldo que queda fiado: <strong>{money.format(balance)}</strong></p>}
      </>}
      <div className="actions">
        <button disabled={!ready}>{session.total === 0 ? 'Cerrar sin cargo' : 'Guardar cobro y liberar mesa'}</button>
        {session.total > 0 && <button type="button" className="secondary" onClick={() => setSplit(true)}>Repartir entre personas</button>}
      </div>
    </fieldset>
  </form>;
}

export function Billiards() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [table, setTable] = useState(1);
  const [now, setNow] = useState(Date.now);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const write = useOperation();

  async function load() {
    setLoadError('');
    try {
      const [overview, people, catalog] = await Promise.all([
        api<Dashboard>('billiards'), api<Account[]>('accounts'), api<Product[]>('products'),
      ]);
      setDashboard(overview);
      setAccounts(people);
      setProducts(catalog.filter((item) => item.active && item.stock > 0));
      setNow(Date.now());
    } catch (error) {
      setLoadError(message(error));
    }
  }

  useEffect(() => { void load(); }, []);
  const running = dashboard?.active.some((entry) => entry.stoppedAt === null) ?? false;
  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [running]);

  async function operate(path: string, body: object, success: string) {
    if (busy || loadError) return false;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await write(path, body);
      setStatus(success);
      await load();
      return true;
    } catch (error) {
      setError(message(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const session = dashboard?.active.find((entry) => entry.tableNumber === table);
  const locked = busy || Boolean(loadError);
  const seconds = session ? elapsedSeconds(session.startedAt, session.stoppedAt ?? now, session.pausedMs) : 0;
  const liveTime = session ? timeCharge(seconds, session.rate) : 0;
  const consumption = session?.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) ?? 0;

  return (
    <section aria-labelledby="billiards-title">
      <div className="section-title"><h2 id="billiards-title">Mesas de billar</h2>
        {dashboard && <strong>{money.format(dashboard.rate)} por hora</strong>}</div>
      {loadError && <p role="alert">{loadError} <button className="secondary" onClick={() => void load()}>Actualizar datos</button></p>}
      {!dashboard && !loadError && <p role="status">Cargando mesas…</p>}
      {dashboard && <>
        <ul className="billiard-grid" aria-label="Seleccionar mesa">
          {Array.from({ length: billiardTables }, (_, index) => index + 1).map((number) => {
            const entry = dashboard.active.find((value) => value.tableNumber === number);
            return (
              <li key={number}><button className="table-button" aria-pressed={table === number} disabled={busy} onClick={() => {
                setTable(number);
                setCanceling(false);
                setStatus('');
                setError('');
              }}>
                <strong>Mesa {number}</strong>
                <span data-occupied={Boolean(entry)}>{entry ? entry.stoppedAt === null ? 'En juego' : 'Por liquidar' : 'Libre'}</span>
              </button></li>
            );
          })}
        </ul>
        <section className="billiard-panel" aria-label={'Mesa ' + table}>
          <div className="section-title"><h3>Mesa {table}</h3>
            {session && <strong className="clock">{durationLabel(seconds)}</strong>}</div>
          {error && <p role="alert">{error}</p>}
          {status && <p role="status">{status}</p>}
          {!session ? <button disabled={locked} onClick={() => void operate('billiards', { table }, 'Mesa abierta.')}>Abrir mesa e iniciar tiempo</button>
            : <>
              <SessionHours session={session} />
              <div className="totals">
                <span>Tiempo <strong>{money.format(liveTime)}</strong></span>
                <span>Consumos <strong>{money.format(consumption)}</strong></span>
                <span>Total <strong>{money.format(liveTime + consumption)}</strong></span>
              </div>
              {session.items.length > 0 && <ul className="sale-lines">{session.items.map((item) => (
                <li key={item.id}><span>{item.quantity} × {item.label}</span><strong>{money.format(item.quantity * item.unitPrice)}</strong></li>
              ))}</ul>}
              {session.stoppedAt === null && <AddConsumption key={session.id} products={products} locked={locked}
                onDeliver={(product, quantity) => operate('billiards/' + session.id + '/items', {
                  productId: product.id, quantity, unitPrice: product.price,
                }, 'Consumo entregado y registrado.')} />}
              {session.stoppedAt === null && <button type="button" disabled={locked}
                onClick={() => { setCanceling(false); void operate('billiards/' + session.id + '/stop', {}, 'Tiempo detenido.'); }}>Terminar y cobrar</button>}
              {session.stoppedAt !== null && <>
                <button type="button" className="secondary" disabled={locked}
                  onClick={() => { setCanceling(false); void operate('billiards/' + session.id + '/resume', {}, 'Tiempo reanudado. La pausa no se cobra.'); }}>Reanudar tiempo</button>
                <TablePayment key={session.id} session={session} accounts={accounts} locked={locked}
                  onClose={(participants) => operate('billiards/' + session.id + '/close', { participants }, 'Cuenta liquidada. La mesa está libre.')} />
              </>}
              {session.stoppedAt !== null && <details className="bill-counter">
                <summary>Agregar un consumo olvidado</summary>
                <AddConsumption products={products} locked={locked}
                  onDeliver={(product, quantity) => operate('billiards/' + session.id + '/items', {
                    productId: product.id, quantity, unitPrice: product.price,
                  }, 'Consumo entregado y registrado.')} />
              </details>}
              {session.items.length === 0 && (canceling ? <div className="sale-callout">
                <strong>¿Liberar la mesa sin cobrar?</strong>
                <div className="actions"><button type="button" disabled={locked} onClick={async () => {
                  if (await operate('billiards/' + session.id + '/cancel', {}, 'Inicio cancelado. La mesa quedó libre.')) setCanceling(false);
                }}>Sí, cancelar</button><button type="button" className="secondary" disabled={locked} onClick={() => setCanceling(false)}>Conservar mesa</button></div>
              </div> : <button type="button" className="secondary" disabled={locked} onClick={() => setCanceling(true)}>Cancelar inicio</button>)}
            </>}
        </section>
        <h3>Historial de mesas</h3>
        {!dashboard.recent.length ? <p>Todavía no se ha liquidado una mesa.</p> : <ul className="ledger-list">{dashboard.recent.map((entry) => (
          <li key={entry.id}>
            <div className="row-between"><strong>Mesa {entry.tableNumber} · {entry.canceledAt === null ? durationLabel(entry.seconds) : 'Inicio cancelado'}</strong><strong>{money.format(entry.total)}</strong></div>
            <SessionHours session={entry} />
            {entry.shares.length > 0 && <ul className="sale-lines">{entry.shares.map((share) => (
              <li key={share.saleId}><span>{share.name ?? 'Pago sin nombre'} · Venta #{share.saleId}</span><strong>{money.format(share.total)}</strong></li>
            ))}</ul>}
          </li>
        ))}</ul>}
      </>}
    </section>
  );
}
