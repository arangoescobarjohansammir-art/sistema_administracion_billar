import { useEffect, useRef, useState, type FormEvent } from 'react';
import { accountTokenValue as tokenValue, mixedCreditPlan } from '../shared/tender';
import type { AccountCycle, AccountHistory } from '../shared/account-history';
import { accountPaymentKey, readAccountPayment, updateAccountPayment, type AccountPaymentDraft } from './account-payment-draft';
import { api, ApiError, message } from './api';

export { api, message } from './api';
export { useOperation } from './OperationRecovery';

export type Account = { id: number; name: string; balance: number; createdAt?: string };
export type PaymentInput = { cash: number; transfer: number; tokens: number };
export type Payment = PaymentInput & { id: number; saleId: number | null; tokenValue: number; createdAt: string; voided?: number | null };
type Sale = { id: number; total: number; createdAt: string; voided: boolean; transferred?: boolean; items: { label: string; quantity: number; unitPrice: number }[] };
type Detail = { account: Account; sales: Sale[]; payments: Payment[]; history: AccountHistory };
export type Product = {
  id: number; name: string; brand: string; presentation: string; price: number; active: 0 | 1;
  stock: number; hasPhoto: 0 | 1; packageName: string; unitsPerPackage: number;
};

export const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'America/Bogota' });
export const emptyPayment = { cash: 0, transfer: 0, tokens: 0 };
export const totalPayment = (payment: PaymentInput, rate = tokenValue) => payment.cash + payment.transfer + payment.tokens * rate;
const normalize = (name: string) => name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
export const label = (product: Product) => [product.name, product.brand, product.presentation].filter(Boolean).join(' · ');

export function TokenQuantity({ count, rate, onChange, max }: {
  count: number; rate: number; onChange: (count: number) => void; max?: number;
}) {
  return <label>Fichas recibidas · {money.format(rate)} c/u<input type="number" min={0} max={max} step={1} inputMode="numeric"
    value={count || ''} onFocus={(event) => event.currentTarget.select()}
    onChange={(event) => onChange(Number(event.target.value))} placeholder="0" /></label>;
}

export function PaymentFields({ value, onChange, showTokens = true }: {
  value: PaymentInput; onChange: (value: PaymentInput) => void; showTokens?: boolean;
}) {
  return (
    <div className="field-grid">
      <label>Efectivo (COP)<input type="number" min={0} step={1} value={value.cash || ''}
        onChange={(event) => onChange({ ...value, cash: Number(event.target.value) })} placeholder="0" /></label>
      <label>Transferencia (COP)<input type="number" min={0} step={1} value={value.transfer || ''}
        onChange={(event) => onChange({ ...value, transfer: Number(event.target.value) })} placeholder="0" /></label>
      {showTokens && <TokenQuantity count={value.tokens} rate={tokenValue} onChange={(tokens) => onChange({ ...value, tokens })} />}
    </div>
  );
}

export function MixedCreditField({ remaining, amount, onChange, hasAccount }: {
  remaining: number; amount: string; onChange: (amount: string) => void; hasAccount: boolean;
}) {
  const { credit, difference } = mixedCreditPlan(remaining, amount);
  return <div className="sale-tender">
    <label>Fiado a la cuenta (COP)<input type="number" min={0} step={1} inputMode="numeric"
      placeholder={String(Math.max(0, remaining))} value={amount} onChange={(event) => onChange(event.target.value)} /></label>
    <div aria-live="polite">
      {credit > 0 && <p>Queda fiado: <strong>{money.format(credit)}</strong>{!hasAccount && ' · Selecciona la cuenta del cliente.'}</p>}
      {difference > 0 && <p>Falta cubrir <strong>{money.format(difference)}</strong> con el pago o el fiado.</p>}
      {remaining >= 0 && difference < 0 && <p role="alert">El pago y el fiado superan el total.</p>}
    </div>
  </div>;
}

export function PaymentBreakdown({ payment }: { payment: Payment }) {
  const parts = [];
  if (payment.cash) parts.push('Efectivo ' + money.format(payment.cash));
  if (payment.transfer) parts.push('Transferencia ' + money.format(payment.transfer));
  if (payment.tokens) parts.push(payment.tokens + ' fichas · ' + money.format(payment.tokens * payment.tokenValue));
  return <span>{parts.join(' · ')}</span>;
}

function SaleLines({ sale }: { sale: Sale }) {
  return <ul className="sale-lines">{sale.items.map((item, index) => (
    <li key={index}><span>{item.quantity > 1 ? item.quantity + ' × ' : ''}{item.label}</span><span>{money.format(item.quantity * item.unitPrice)}</span></li>
  ))}</ul>;
}

type HistorySources = { sales: Map<number, Sale>; payments: Map<number, Payment> };

function HistoryTimeline({ cycle, sources }: { cycle: AccountCycle; sources: HistorySources }) {
  return <ol className="ledger-list account-timeline">{[...cycle.movements].reverse().map((movement) => {
    const sale = movement.kind === 'sale' ? sources.sales.get(movement.sourceId) : undefined;
    const payment = movement.kind === 'payment' ? sources.payments.get(movement.sourceId) : undefined;
    const correction = sources.sales.get(movement.sourceId)?.transferred ? 'Traslado del cargo #' : 'Anulación de venta #';
    const title = movement.kind === 'void' ? correction + movement.sourceId
      : movement.kind === 'payment_void' ? 'Anulación de abono #' + movement.sourceId
        : payment ? (payment.saleId ? 'Pago de venta #' + payment.saleId : 'Abono #' + payment.id)
        : 'Cargo #' + movement.sourceId;
    return <li key={movement.id}>
      <div className="row-between">
        <strong>{title}{sale?.transferred ? ' · Trasladado' : (sale?.voided || payment?.voided) ? ' · Anulado' : ''}</strong>
        <strong>{money.format(movement.amount)}</strong>
      </div>
      <div className="row-between account-movement-meta">
        <time dateTime={movement.createdAt}>{date.format(new Date(movement.createdAt))}</time>
        <span>Saldo después: <strong>{money.format(movement.balanceAfter)}</strong></span>
      </div>
      {sale && <SaleLines sale={sale} />}
      {payment && <p><PaymentBreakdown payment={payment} /></p>}
      {movement.reason && <p>{movement.reason}</p>}
    </li>;
  })}</ol>;
}

function ClosedCycle({ cycle, sources }: { cycle: AccountCycle; sources: HistorySources }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Del <time dateTime={cycle.openedAt}>{date.format(new Date(cycle.openedAt))}</time>
      {cycle.closedAt && <> al <time dateTime={cycle.closedAt}>{date.format(new Date(cycle.closedAt))}</time></>}</summary>
    {open && <HistoryTimeline cycle={cycle} sources={sources} />}
  </details>;
}

function AccountDetail({ id, accountCreatedAt, onBalance }: { id: number; accountCreatedAt: string; onBalance: (account: Account) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [payment, setPayment] = useState(emptyPayment);
  const [busy, setBusy] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draft, setDraft] = useState<AccountPaymentDraft | null>(null);
  const running = useRef(false);
  const key = accountPaymentKey(id, accountCreatedAt);
  const paymentPath = 'accounts/' + id + '/payments';

  async function load() {
    setLoadError('');
    try {
      const result = await api<Detail>('accounts/' + id);
      setDetail(result);
      onBalance(result.account);
      return result;
    } catch (error) {
      setLoadError(message(error));
    }
  }

  async function run(operation: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (error) {
      setError(message(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function updateDraft(entry: AccountPaymentDraft, replacement: AccountPaymentDraft | null) {
    const next = await updateAccountPayment(key, (current) => current?.requestId === entry.requestId ? replacement : current);
    setDraft(next);
  }

  async function confirm(entry: AccountPaymentDraft, receiptId: number) {
    await updateDraft(entry, { ...entry, receiptId });
    setPayment(emptyPayment);
    await load();
  }

  async function check(entry: AccountPaymentDraft) {
    const receipt = await api<{ id: number | null }>(paymentPath + '?' + new URLSearchParams({ requestId: entry.requestId }));
    if (receipt.id !== null) await confirm(entry, receipt.id);
    else if (entry.receiptId !== undefined) {
      await updateDraft(entry, { requestId: entry.requestId, payment: entry.payment });
      setError('La caja actual no encuentra el abono anterior. Verifica el historial antes de reenviarlo.');
    }
  }

  async function send(entry: AccountPaymentDraft) {
    try {
      const receipt = await api<{ id: number }>(paymentPath, { payment: entry.payment, requestId: entry.requestId });
      await confirm(entry, receipt.id);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 400 || error.status === 409)) await updateDraft(entry, null);
      throw error;
    }
  }

  useEffect(() => {
    void load();
    function restore(verify: boolean) {
      try {
        const stored = readAccountPayment(key);
        setDraft(stored);
        setDraftReady(true);
        if (verify && stored) void run(() => check(stored));
      } catch {
        setDraftReady(false);
        setError('El navegador no pudo recuperar los abonos en espera. Vuelve a abrir la cuenta para intentarlo.');
      }
    }
    restore(true);
    const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) restore(false); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [id, key]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftReady || draft || !detail || paid <= 0 || paid > detail.account.balance) return;
    void run(async () => {
      const entry = { requestId: crypto.randomUUID(), payment };
      const saved = await updateAccountPayment(key, (current) => current ?? entry);
      setDraft(saved);
      if (saved?.requestId === entry.requestId) await send(entry);
    });
  }

  if (loadError) return <p role="alert">{loadError} <button className="secondary" onClick={() => void load()}>Volver a cargar</button></p>;
  if (!detail) return <p role="status">Cargando cuenta…</p>;

  const paid = totalPayment(payment);
  const sources = {
    sales: new Map(detail.sales.map((sale) => [sale.id, sale])),
    payments: new Map(detail.payments.map((entry) => [entry.id, entry])),
  };
  return (
    <section className="ledger" aria-label="Detalle de la cuenta">
      <div className="section-title"><h3>{detail.account.name}</h3><strong>Saldo {money.format(detail.account.balance)}</strong></div>
      {error && <p role="alert">{error}</p>}
      {draft && <section className="sale-tender" aria-label="Confirmación del abono">
        {draft.receiptId === undefined ? <>
          <p role="status">Abono por confirmar · <strong>{money.format(totalPayment(draft.payment))}</strong></p>
          <p>Verifica si la caja lo guardó. Si hace falta reenviarlo, reintenta este mismo abono.</p>
          <div className="actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => check(draft))}>Verificar si se guardó</button>
            <button type="button" disabled={busy} onClick={() => void run(() => send(draft))}>Reintentar el mismo abono</button>
          </div>
        </> : <>
          <p role="status"><strong>Abono #{draft.receiptId} {detail.payments.find((entry) => entry.id === draft.receiptId)?.voided ? 'anulado' : 'guardado'}.</strong>
            {' '}{money.format(totalPayment(draft.payment))}
            {detail.account.balance === 0 && ' · Cuenta saldada.'}
          </p>
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => updateDraft(draft, null))}>
            {detail.account.balance > 0 ? 'Registrar otro abono' : 'Cerrar confirmación'}
          </button>
        </>}
      </section>}
      {detail.account.balance > 0 && !draft && draftReady && (
        <form onSubmit={save}>
          <h4>Registrar abono</h4>
          <fieldset disabled={busy} className="plain-fieldset"><PaymentFields value={payment} onChange={setPayment} /></fieldset>
          <p>Total abonado: <strong>{money.format(paid)}</strong></p>
          {paid > detail.account.balance && <p role="alert">El abono supera el saldo.</p>}
          <button disabled={busy || paid <= 0 || paid > detail.account.balance}>{busy ? 'Guardando…' : 'Guardar abono'}</button>
        </form>
      )}
      <section aria-labelledby="current-account-history">
        <h4 id="current-account-history">Historial actual</h4>
        {detail.history.current ? <HistoryTimeline cycle={detail.history.current} sources={sources} />
          : <p>Sin movimientos pendientes. Los próximos cargos iniciarán un nuevo historial.</p>}
      </section>
      {detail.history.closed.length > 0 && <details className="account-history-archive">
        <summary>Historial anterior ({detail.history.closed.length})</summary>
        {detail.history.closed.map((cycle) => <ClosedCycle key={cycle.id} cycle={cycle} sources={sources} />)}
      </details>}
    </section>
  );
}

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setError('');
    try {
      setAccounts(await api<Account[]>('accounts'));
    } catch (error) {
      setError(message(error));
    }
  }

  useEffect(() => { void load(); }, []);

  function updateAccount(account: Account) {
    setAccounts((previous) => {
      const list = previous ?? [];
      return list.some((item) => item.id === account.id)
        ? list.map((item) => item.id === account.id ? account : item) : [...list, account];
    });
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const account = await api<Account>('accounts', { name: new FormData(form).get('name') });
      updateAccount(account);
      setSelectedAccount(account.id);
      setSearch('');
      form.reset();
      setStatus('Cuenta de ' + account.name + ' creada.');
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  const shown = accounts?.filter((account) => normalize(account.name).includes(normalize(search.trim())))
    .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name, 'es'));
  const selected = accounts?.find((account) => account.id === selectedAccount);

  return (
    <section aria-labelledby="accounts-title">
      <div className="sale-heading"><div><p className="section-eyebrow">Clientes</p><h2 id="accounts-title">Cuentas por nombre</h2></div></div>
      {error && <p role="alert">{error} {!accounts && <button className="secondary" onClick={() => void load()}>Reintentar</button>}</p>}
      {status && <p className="sale-confirmation" role="status">{status}</p>}
      {!accounts && !error && <p role="status">Cargando cuentas…</p>}
      {accounts && <>
        <div className="account-actions">
          <div className="sale-panel">
            <h3>Buscar cliente</h3>
            <label>Nombre o apodo<input type="search" data-key-search value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          </div>
          <form onSubmit={createAccount}>
            <h3>Nueva cuenta</h3>
            <div className="product-picker">
              <label>Nombre o apodo<input name="name" maxLength={100} required disabled={busy} /></label>
              <button disabled={busy}>{busy ? 'Guardando…' : 'Crear cuenta'}</button>
            </div>
          </form>
        </div>
        {shown?.length === 0 && <p>{accounts.length ? 'No se encontraron cuentas.' : 'Crea una cuenta para registrar fiado o consultar su historial.'}</p>}
        {Boolean(shown?.length) && <ul className="account-list">{shown?.map((account) => (
          <li key={account.id}>
            <button className="secondary row-between" aria-pressed={selectedAccount === account.id} onClick={() => setSelectedAccount(account.id)}>
              <span>{account.name}</span><strong>{money.format(account.balance)}</strong>
            </button>
          </li>
        ))}</ul>}
        {selected && <AccountDetail key={selected.id} id={selected.id} accountCreatedAt={selected.createdAt ?? ''} onBalance={updateAccount} />}
      </>}
    </section>
  );
}
