import { useEffect, useRef, useState, type FormEvent } from 'react';

export type Account = { id: number; name: string; balance: number };
export type PaymentInput = { cash: number; transfer: number; tokens: number };
export type Payment = PaymentInput & { id: number; saleId: number | null; tokenValue: number; createdAt: string };
type Sale = { id: number; total: number; createdAt: string; items: { label: string; quantity: number; unitPrice: number }[] };
type Detail = { account: Account; sales: Sale[]; payments: Payment[] };
export type Product = { id: number; name: string; brand: string; presentation: string; price: number; active: 0 | 1; stock: number; hasPhoto: 0 | 1 };

const tokenValue = 3000;
export const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota' });
export const emptyPayment = { cash: 0, transfer: 0, tokens: 0 };
export const totalPayment = (payment: PaymentInput, rate = tokenValue) => payment.cash + payment.transfer + payment.tokens * rate;
const normalize = (name: string) => name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
export const label = (product: Product) => [product.name, product.brand, product.presentation].filter(Boolean).join(' · ');

export async function api<T>(path: string, data?: object): Promise<T> {
  const response = await fetch('/api/' + path, {
    method: data ? 'POST' : 'GET',
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'No se pudo completar la operación.');
  return result as T;
}

export function message(error: unknown) {
  return error instanceof TypeError ? 'Se perdió la comunicación con la caja. Reintenta sin cambiar los valores.'
    : error instanceof Error ? error.message : 'No se pudo completar la operación.';
}

export function useOperation() {
  const last = useRef<{ payload: string; id: string } | null>(null);
  return async (path: string, data: object) => {
    const payload = JSON.stringify([path, data]);
    if (last.current?.payload !== payload) last.current = { payload, id: crypto.randomUUID() };
    const result = await api<{ id: number }>(path, { ...data, requestId: last.current.id });
    last.current = null;
    return result;
  };
}

export function PaymentFields({ value, onChange }: { value: PaymentInput; onChange: (value: PaymentInput) => void }) {
  return (
    <div className="field-grid">
      <label>Efectivo (COP)<input type="number" min={0} step={1} value={value.cash || ''}
        onChange={(event) => onChange({ ...value, cash: Number(event.target.value) })} placeholder="0" /></label>
      <label>Transferencia (COP)<input type="number" min={0} step={1} value={value.transfer || ''}
        onChange={(event) => onChange({ ...value, transfer: Number(event.target.value) })} placeholder="0" /></label>
      <label>Fichas · {money.format(tokenValue)} c/u<input type="number" min={0} step={1} value={value.tokens || ''}
        onChange={(event) => onChange({ ...value, tokens: Number(event.target.value) })} placeholder="0" /></label>
    </div>
  );
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

function AccountDetail({ id, onBalance }: { id: number; onBalance: (account: Account) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [payment, setPayment] = useState(emptyPayment);
  const [busy, setBusy] = useState(false);
  const write = useOperation();

  async function load() {
    setLoadError('');
    try {
      const result = await api<Detail>('accounts/' + id);
      setDetail(result);
      onBalance(result.account);
    } catch (error) {
      setLoadError(message(error));
    }
  }

  useEffect(() => { void load(); }, [id]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const receipt = await write('accounts/' + id + '/payments', { payment });
      setPayment(emptyPayment);
      setStatus('Abono #' + receipt.id + ' guardado.');
      await load();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p role="alert">{loadError} <button className="secondary" onClick={() => void load()}>Volver a cargar</button></p>;
  if (!detail) return <p role="status">Cargando cuenta…</p>;

  const paid = totalPayment(payment);
  return (
    <section className="ledger" aria-label="Detalle de la cuenta">
      <div className="section-title"><h3>{detail.account.name}</h3><strong>Saldo {money.format(detail.account.balance)}</strong></div>
      {detail.account.balance > 0 && (
        <form onSubmit={save}>
          <h4>Registrar abono</h4>
          <fieldset disabled={busy} className="plain-fieldset"><PaymentFields value={payment} onChange={setPayment} /></fieldset>
          <p>Total abonado: <strong>{money.format(paid)}</strong></p>
          {paid > detail.account.balance && <p role="alert">El abono supera el saldo.</p>}
          {error && <p role="alert">{error}</p>}
          <button disabled={busy || paid <= 0 || paid > detail.account.balance}>{busy ? 'Guardando…' : 'Guardar abono'}</button>
        </form>
      )}
      {status && <p role="status">{status}</p>}
      <div className="ledger-columns">
        <section><h4>Consumos</h4>
          {!detail.sales.length ? <p>Sin consumos.</p> : <ul className="ledger-list">{detail.sales.map((sale) => (
            <li key={sale.id}>
              <div className="row-between"><strong>Venta #{sale.id}</strong><strong>{money.format(sale.total)}</strong></div>
              <time dateTime={sale.createdAt}>{date.format(new Date(sale.createdAt))}</time>
              <SaleLines sale={sale} />
            </li>
          ))}</ul>}
        </section>
        <section><h4>Pagos</h4>
          {!detail.payments.length ? <p>Sin pagos.</p> : <ul className="ledger-list">{detail.payments.map((entry) => (
            <li key={entry.id}>
              <div className="row-between"><strong>{entry.saleId ? 'Pago de venta #' + entry.saleId : 'Abono #' + entry.id}</strong>
                <strong>{money.format(totalPayment(entry, entry.tokenValue))}</strong></div>
              <time dateTime={entry.createdAt}>{date.format(new Date(entry.createdAt))}</time>
              <p><PaymentBreakdown payment={entry} /></p>
            </li>
          ))}</ul>}
        </section>
      </div>
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
        {selectedAccount !== null && <AccountDetail key={selectedAccount} id={selectedAccount} onBalance={updateAccount} />}
      </>}
    </section>
  );
}
