import { useEffect, useRef, useState, type FormEvent } from 'react';

export type Account = { id: number; name: string; balance: number };
export type PaymentInput = { cash: number; transfer: number; tokens: number };
type Payment = PaymentInput & { id: number; saleId: number | null; tokenValue: number; createdAt: string };
type Sale = { id: number; total: number; createdAt: string; items: { label: string; quantity: number; unitPrice: number }[] };
type DirectSale = Sale & { payment: Payment | null };
type Detail = { account: Account; sales: Sale[]; payments: Payment[] };
export type Product = { id: number; name: string; brand: string; presentation: string; price: number; active: 0 | 1; stock: number };
type CartItem = { product: Product; quantity: number };

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

function PaymentBreakdown({ payment }: { payment: Payment }) {
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
  const [mode, setMode] = useState<'sale' | 'accounts'>('sale');
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [directSales, setDirectSales] = useState<DirectSale[]>([]);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null);
  const [saleAccount, setSaleAccount] = useState('');
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [payment, setPayment] = useState(emptyPayment);
  const [busy, setBusy] = useState(false);
  const write = useOperation();

  async function load() {
    setLoadError('');
    try {
      const [people, catalog, sales] = await Promise.all([
        api<Account[]>('accounts'), api<Product[]>('products'), api<DirectSale[]>('sales'),
      ]);
      setAccounts(people);
      setProducts(catalog.filter((product) => product.active && product.stock > 0));
      setDirectSales(sales);
    } catch (error) {
      setLoadError(message(error));
    }
  }

  useEffect(() => { void load(); }, []);

  function updateAccount(account: Account) {
    setAccounts((previous) => (previous ?? []).some((item) => item.id === account.id)
      ? previous!.map((item) => item.id === account.id ? account : item) : [...(previous ?? []), account]);
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
      setSaleAccount(String(account.id));
      setSearch('');
      form.reset();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  function addItem() {
    const product = products.find((item) => item.id === Number(productId));
    if (!product) return;
    setStatus('');
    setError('');
    setProductId('');
    setCart((previous) => previous.some((item) => item.product.id === product.id) ?
      previous.map((item) => item.product.id === product.id ? { product, quantity: Math.min(item.quantity + 1, product.stock) } : item)
      : [...previous, { product, quantity: 1 }]);
  }

  async function saveSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !cart.length) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await write('sales', {
        accountId: saleAccount ? Number(saleAccount) : null, payment,
        items: cart.map(({ product, quantity }) => ({ productId: product.id, quantity, unitPrice: product.price })),
      });
      setCart([]);
      setPayment(emptyPayment);
      setStatus('Venta #' + result.id + ' guardada.');
      await load();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  const total = cart.reduce((amount, item) => amount + item.quantity * item.product.price, 0);
  const paid = totalPayment(payment);
  const remaining = total - paid;
  const shown = accounts?.filter((account) => normalize(account.name).includes(normalize(search.trim())))
    .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name, 'es'));

  function switchMode(next: 'sale' | 'accounts') {
    setMode(next);
    setError('');
    setStatus('');
  }

  return (
    <section aria-labelledby="accounts-title">
      <h2 id="accounts-title">Ventas y cuentas</h2>
      <nav className="actions accounts-nav" aria-label="Ventas y cuentas">
        <button type="button" disabled={busy} className="navigation" aria-pressed={mode === 'sale'} onClick={() => switchMode('sale')}>Registrar venta</button>
        <button type="button" disabled={busy} className="navigation" aria-pressed={mode === 'accounts'} onClick={() => switchMode('accounts')}>Cuentas por nombre</button>
      </nav>
      {loadError && <p role="alert">{loadError} <button className="secondary" onClick={() => void load()}>Reintentar</button></p>}
      {!accounts && !loadError && <p role="status">Cargando ventas y cuentas…</p>}
      {accounts && mode === 'sale' && (
        <>
          <form onSubmit={saveSale}>
            <h3>Nueva venta</h3>
            <fieldset className="plain-fieldset" disabled={busy}>
              <div className="field-grid">
                <label>Cuenta<select value={saleAccount} onChange={(event) => setSaleAccount(event.target.value)}>
                  <option value="">Sin nombre · pago completo</option>
                  {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                </select></label>
                <div className="product-picker">
                  <label>Producto<select value={productId} onChange={(event) => setProductId(event.target.value)}>
                    <option value="">Seleccionar producto</option>
                    {products.map((product) => <option key={product.id} value={product.id}>{label(product)} · {money.format(product.price)}</option>)}
                  </select></label>
                  <button type="button" className="secondary" disabled={!productId || cart.length >= 50} onClick={addItem}>Agregar</button>
                </div>
              </div>
              {!products.length && <p>Agrega existencias en Inventario para registrar una venta.</p>}
              {cart.length > 0 && <ul className="cart-list">{cart.map(({ product, quantity }) => (
                <li key={product.id}>
                  <div><strong>{label(product)}</strong><p>{money.format(product.price)} por unidad</p></div>
                  <label>Cantidad<input type="number" min={1} max={product.stock} step={1} required value={quantity || ''}
                    onChange={(event) => setCart((previous) => previous.map((item) => item.product.id === product.id
                      ? { ...item, quantity: Number(event.target.value) } : item))} /></label>
                  <button className="secondary" type="button" onClick={() => setCart((previous) => previous.filter((item) => item.product.id !== product.id))}>Quitar</button>
                </li>
              ))}</ul>}
              <PaymentFields value={payment} onChange={setPayment} />
              <div className="totals">
                <span>Total <strong>{money.format(total)}</strong></span>
                <span>Pago <strong>{money.format(paid)}</strong></span>
                {remaining >= 0 && <span>Saldo de la venta <strong>{money.format(remaining)}</strong></span>}
              </div>
              {remaining < 0 && <p role="alert">El pago supera el total de la venta.</p>}
              {cart.length > 0 && remaining > 0 && !saleAccount && <p>Elige una cuenta por nombre para dejar el saldo fiado.</p>}
              {cart.length > 0 && remaining > 0 && saleAccount && <p>El saldo se anotará a la cuenta seleccionada.</p>}
              {error && <p role="alert">{error}</p>}
              {status && <p role="status">{status}</p>}
              <button disabled={!cart.length || remaining < 0 || (!saleAccount && remaining > 0)}>{busy ? 'Guardando…' : 'Guardar venta'}</button>
            </fieldset>
          </form>
          <h3>Ventas recientes sin nombre</h3>
          {!directSales.length ? <p>Sin ventas sin nombre.</p> : <ul className="ledger-list">{directSales.map((sale) => (
            <li key={sale.id}>
              <div className="row-between"><strong>Venta #{sale.id}</strong><strong>{money.format(sale.total)}</strong></div>
              <time dateTime={sale.createdAt}>{date.format(new Date(sale.createdAt))}</time>
              <SaleLines sale={sale} />
              {sale.payment && <PaymentBreakdown payment={sale.payment} />}
            </li>
          ))}</ul>}
        </>
      )}
      {accounts && mode === 'accounts' && (
        <>
          <form onSubmit={createAccount}>
            <h3>Nueva cuenta</h3>
            <div className="product-picker">
              <label>Nombre o apodo<input name="name" maxLength={100} required disabled={busy} /></label>
              <button disabled={busy}>{busy ? 'Guardando…' : 'Crear cuenta'}</button>
            </div>
            {error && <p role="alert">{error}</p>}
          </form>
          <div className="catalog-tools"><label>Buscar por nombre o apodo<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
          {shown?.length === 0 && <p>{accounts.length ? 'No se encontraron cuentas.' : 'Crea una cuenta para registrar fiado o consultar su historial.'}</p>}
          {Boolean(shown?.length) && <ul className="account-list">{shown?.map((account) => (
            <li key={account.id}>
              <button className="secondary row-between" aria-pressed={selectedAccount === account.id}
                onClick={() => { setSelectedAccount(account.id); setSaleAccount(String(account.id)); }}>
                <span>{account.name}</span><strong>{money.format(account.balance)}</strong>
              </button>
            </li>
          ))}</ul>}
          {selectedAccount !== null && <AccountDetail key={selectedAccount} id={selectedAccount} onBalance={updateAccount} />}
        </>
      )}
    </section>
  );
}
