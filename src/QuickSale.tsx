import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { accountTokenValue, cashChange, mixedCreditPlan } from '../shared/tender';
import { tejoProductValue } from '../shared/tejo';
import { CashChangeField } from './CashTools';
import { AccountPicker } from './CustomerLookup';
import { api, emptyPayment, label, message, MixedCreditField, money, PaymentBreakdown, PaymentFields, TokenQuantity, totalPayment, useOperation,
  type Account, type Payment, type PaymentInput, type Product } from './Accounts';

type Item = { product: Product; quantity: number };
type Mode = 'order' | 'cash' | 'transfer' | 'tokens' | 'mixed' | 'credit';
type TokenUse = 'products' | 'account';
type RecentSale = { id: number; total: number; createdAt: string; voided: boolean; items: { label: string; quantity: number }[]; payment: Payment | null };
type RecentRedemption = { id: number; tokens: number; subtotal: number; extra: number; name: string | null;
  createdAt: string; items: { label: string; quantity: number }[] };
const normalize = (name: string) => name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
const time = new Intl.DateTimeFormat('es-CO', { timeStyle: 'short', timeZone: 'America/Bogota' });
const paymentOptions = [
  { id: 'cash', text: 'Efectivo' }, { id: 'transfer', text: 'Transferencia' },
  { id: 'tokens', text: 'Fichas' }, { id: 'mixed', text: 'Mixto' },
] as const;

export function QuickSale({ active, cashOpen, onCash }: { active: boolean; cashOpen: boolean | null; onCash: () => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [recent, setRecent] = useState<RecentSale[]>([]);
  const [redemptions, setRedemptions] = useState<RecentRedemption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [mode, setMode] = useState<Mode>('order');
  const [accountId, setAccountId] = useState('');
  const [mixedCredit, setMixedCredit] = useState('');
  const [payment, setPayment] = useState<PaymentInput>(emptyPayment);
  const [tokenUse, setTokenUse] = useState<TokenUse>('products');
  const [received, setReceived] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const checkout = useRef<HTMLFormElement>(null);
  const write = useOperation();

  async function load() {
    setLoadError('');
    try {
      const [catalog, people, sales, canjes] = await Promise.all([
        api<Product[]>('products'), api<Account[]>('accounts'), api<RecentSale[]>('sales'),
        api<RecentRedemption[]>('tejo/redemptions'),
      ]);
      setProducts(catalog.filter((product) => product.active && product.stock > 0));
      setAccounts(people);
      setRecent(sales);
      setRedemptions(canjes);
      setLoaded(true);
    } catch (error) {
      setLoadError(message(error));
    }
  }

  useEffect(() => { if (active) void load(); }, [active]);

  const total = items.reduce((sum, { product, quantity }) => sum + product.price * quantity, 0);
  const showsTokens = mode === 'tokens' || mode === 'mixed';
  const tokens = showsTokens ? payment.tokens : 0;
  const usesProductRate = mode === 'tokens' || (mode === 'mixed' && tokenUse === 'products');
  const productRedemption = usesProductRate && tokens > 0;
  const coveredProducts = productRedemption ? Math.min(total, tokens * tejoProductValue) : 0;
  const due = total - coveredProducts;
  const methods = mode === 'mixed' ? { ...payment, tokens: productRedemption ? 0 : tokens } :
    mode === 'cash' ? { ...emptyPayment, cash: total } : mode === 'transfer' ? { ...emptyPayment, transfer: total } : emptyPayment;
  const cashDue = methods.cash;
  const change = cashChange(cashDue, received);
  const remaining = due - totalPayment(methods);
  const accountRequired = mode === 'credit' || remaining > 0;
  const locked = busy || Boolean(loadError);
  const canCheckout = cashOpen === true && items.length > 0 && !locked &&
    items.every(({ quantity, product }) => Number.isInteger(quantity) && quantity >= 1 && quantity <= product.stock);
  const canConfirm = canCheckout && mode !== 'order' && remaining >= 0 &&
    (mode !== 'mixed' || mixedCreditPlan(remaining, mixedCredit).valid) &&
    (!accountRequired || Boolean(accountId)) &&
    (mode !== 'tokens' || tokens > 0) && Number.isInteger(tokens) && tokens >= 0 &&
    (!productRedemption || tokens <= 1000) &&
    (cashDue <= 0 || change === null || (Number.isInteger(change) && change >= 0));
  const visible = products.filter((product) => normalize(label(product)).includes(normalize(query.trim())));

  function add(product: Product) {
    if (locked || mode !== 'order') return;
    setStatus('');
    setError('');
    const current = items.find((item) => item.product.id === product.id);
    if ((current && current.quantity >= product.stock) || (!current && items.length >= 50)) {
      setError(current ? 'Ya agregaste todas las unidades disponibles de ' + product.name + '.' : 'Esta venta admite hasta 50 productos distintos.');
      return;
    }
    setItems((previous) => previous.some((item) => item.product.id === product.id)
      ? previous.map((item) => item.product.id === product.id ? { ...item, quantity: Math.min(item.quantity + 1, product.stock) } : item)
      : [...previous, { product, quantity: 1 }]);
  }

  function decrement(id: number) {
    const item = items.find((entry) => entry.product.id === id);
    if (item?.quantity === 1) search.current?.focus();
    setError('');
    setItems((previous) => previous.map((entry) => entry.product.id === id
      ? { ...entry, quantity: entry.quantity - 1 } : entry).filter((entry) => entry.quantity > 0));
  }

  function showPayment(next: 'cash' | 'credit') {
    if (!canCheckout) return;
    setError('');
    setMode(next);
    requestAnimationFrame(() => {
      checkout.current?.querySelector<HTMLElement>(next === 'credit' ? '[data-customer-lookup]' : '[data-confirm-sale]')?.focus();
    });
  }

  function back() {
    setMode('order');
    setError('');
    requestAnimationFrame(() => {
      const button = checkout.current?.querySelector<HTMLButtonElement>('[data-key-checkout]');
      if (button && !button.disabled) button.focus(); else search.current?.focus();
    });
  }

  function changeQuantity(id: number, quantity: number) {
    setItems((previous) => previous.map((item) => item.product.id === id ? { ...item, quantity } : item));
  }

  function fromSearch(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      const first = results.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      if (first) { event.preventDefault(); first.focus(); }
    } else if (event.key === 'Escape' && query) {
      event.preventDefault();
      setQuery('');
    }
  }

  function reset() {
    setItems([]);
    setQuery('');
    setPayment(emptyPayment);
    setTokenUse('products');
    setReceived('');
    setAccountId('');
    setMixedCredit('');
    setMode('order');
  }

  function chooseMethod(next: 'cash' | 'transfer' | 'tokens' | 'mixed') {
    setMode(next);
    setReceived('');
    setError('');
    if (next === 'tokens') {
      setTokenUse('products');
      requestAnimationFrame(() => checkout.current?.querySelector<HTMLInputElement>('.sale-token-quantity input')?.focus());
    }
  }

  function completeWith(method: 'cash' | 'transfer') {
    setTokenUse('products');
    setMixedCredit('');
    setPayment({ ...emptyPayment, tokens, [method]: due });
    chooseMethod('mixed');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canConfirm || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const payload = {
        accountId: accountId ? Number(accountId) : null, payment: methods,
        items: items.map(({ product, quantity }) => ({ productId: product.id, quantity, unitPrice: product.price })),
      };
      const receipt = productRedemption
        ? await write('tejo/redemptions', { ...payload, tokens })
        : await write('sales', payload);
      reset();
      const summary = remaining > 0 ? 'Saldo fiado: ' + money.format(remaining)
        : productRedemption ? 'Cubierto con fichas: ' + money.format(coveredProducts) + ' · Cobrado: ' + money.format(due)
          : 'Total: ' + money.format(total);
      setStatus((productRedemption ? 'Canje #' + receipt.id + ' guardado. ' : 'Venta #' + receipt.id + ' guardada. ') + summary +
        (cashDue > 0 && change !== null ? ' · Devuelto: ' + money.format(change) : '') + '.');
      await load();
      if (active) requestAnimationFrame(() => search.current?.focus());
    } catch (error) {
      setError(message(error));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="sale-title">
      <div className="sale-heading">
        <div><p className="section-eyebrow">Mostrador</p><h2 id="sale-title">Registrar venta</h2></div>
        {items.length > 0 && mode === 'order' && <button type="button" className="secondary" disabled={locked}
          onClick={() => { if (window.confirm('¿Vaciar los productos de la venta actual?')) { reset(); setError(''); setStatus(''); search.current?.focus(); } }}>Vaciar venta</button>}
      </div>
      {cashOpen === false && <div className="sale-callout"><strong>Abre un turno para poder cobrar.</strong>
        <button className="secondary" onClick={onCash}>Ir a Caja</button></div>}
      {loadError && <p role="alert">{loadError} <button className="secondary" onClick={() => void load()}>Actualizar datos</button></p>}
      {status && <p className="sale-confirmation" role="status">{status}</p>}
      <div className="sale-workspace">
        <section className="sale-panel" aria-label="Productos para vender">
          <div className="section-title"><h3>Productos</h3><span className="secondary-text">{visible.length} {visible.length === 1 ? 'producto' : 'productos'}</span></div>
          <label className="sale-search">Buscar producto
            <input type="search" ref={search} data-key-search value={query} placeholder="Busca por nombre, marca o presentación"
              onChange={(event) => setQuery(event.target.value)} onKeyDown={fromSearch} />
          </label>
          {!loaded && !loadError && <p role="status">Cargando productos…</p>}
          {loaded && !products.length && <p>Agrega productos con existencias en Inventario para empezar.</p>}
          {products.length > 0 && !visible.length && <p>No se encontraron productos.</p>}
          <div className="sale-products" ref={results}>
            {visible.map((product) => (
              <button type="button" className="sale-product" key={product.id} disabled={locked || mode !== 'order'}
                onClick={() => add(product)} aria-label={'Agregar ' + label(product) + ' por ' + money.format(product.price)}>
                <span className="sale-thumb" data-tint={product.id % 4}>
                  {product.hasPhoto ? <img src={'/api/products/' + product.id + '/photo'} alt="" loading="lazy" />
                    : <span aria-hidden="true">{product.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span>}
                </span>
                <span className="sale-product-name">{product.name}</span>
                <span className="secondary-text">{[product.brand, product.presentation].filter(Boolean).join(' · ')}</span>
                <b>{money.format(product.price)}</b>
              </button>
            ))}
          </div>
        </section>
        <form ref={checkout} className="sale-panel sale-order" onSubmit={save} aria-label="Cuenta actual"
          data-key-scope={mode !== 'order' ? '' : undefined}>
          <div className="section-title"><h3>Cuenta actual</h3>
            <span className="sale-badge">{items.reduce((sum, item) => sum + item.quantity, 0)} unidades</span></div>
          {items.length > 0 ? <ul className="sale-lines register-lines">{items.map(({ product, quantity }) => (
            <li key={product.id}>
              <div><strong>{label(product)}</strong><span className="secondary-text">{money.format(product.price)} c/u</span></div>
              <div><b>{money.format(product.price * quantity)}</b><div className="quantity-controls">
                <button className="secondary" type="button" disabled={locked || mode !== 'order'} aria-label={'Quitar una unidad de ' + label(product)} onClick={() => decrement(product.id)}>−</button>
                <input className="quantity-input" type="number" inputMode="numeric" min={1} max={product.stock} step={1}
                  aria-label={'Cantidad de ' + label(product)} disabled={locked || mode !== 'order'} value={quantity || ''}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => changeQuantity(product.id, Number(event.target.value))} />
                <button className="secondary" type="button" disabled={locked || mode !== 'order' || quantity >= product.stock} aria-label={'Agregar otra unidad de ' + label(product)} onClick={() => add(product)}>+</button>
              </div></div>
            </li>
          ))}</ul> : <p className="secondary-text">Elige un producto para empezar.</p>}
          <div className="order-totals">
            <div className="row-between sale-grand"><span>Total a cobrar</span><strong aria-live="polite">{money.format(total)}</strong></div>
            {items.some(({ product, quantity }) => !Number.isInteger(quantity) || quantity < 1 || quantity > product.stock) &&
              <p role="alert">Revisa las cantidades. Deben estar entre 1 y las unidades disponibles.</p>}
            {error && <p role="alert">{error}</p>}
            {mode === 'order' ? <div className="order-actions">
              <button type="button" disabled={!canCheckout} data-key-checkout onClick={() => showPayment('cash')}>Cobrar {money.format(total)}</button>
              <button type="button" disabled={!canCheckout} className="secondary" onClick={() => showPayment('credit')}>Anotar fiado</button>
            </div> : <fieldset className="plain-fieldset" disabled={locked}>
              {mode !== 'credit' && <div className="payment-options payment-options-four" aria-label="Medio de pago">{paymentOptions.map(({ id, text }) =>
                <button key={id} type="button" className="secondary" aria-pressed={mode === id} onClick={() => chooseMethod(id)}>{text}</button>)}</div>}
              {showsTokens && <div className="sale-token-quantity">
                <TokenQuantity count={tokens} rate={usesProductRate ? tejoProductValue : accountTokenValue}
                  max={usesProductRate ? 1000 : undefined} onChange={(count) => setPayment({ ...payment, tokens: count })} />
                {mode === 'mixed' && tokens > 0 && <label>Cómo se usan las fichas
                  <select value={tokenUse} onChange={(event) => setTokenUse(event.target.value === 'account' ? 'account' : 'products')}>
                    <option value="products">Canje por productos · {money.format(tejoProductValue)} por ficha</option>
                    <option value="account">Abono a una cuenta · {money.format(accountTokenValue)} por ficha</option>
                  </select></label>}
                {productRedemption && <div className="sale-tender" aria-live="polite">
                  <div className="row-between"><span>Las fichas cubren</span><strong>{money.format(coveredProducts)}</strong></div>
                  <div className="row-between"><span>Queda por pagar</span><strong>{money.format(due)}</strong></div>
                  {tokens * tejoProductValue > total && <p>El valor de ficha que sobre no se devuelve ni queda como saldo.</p>}
                </div>}
                {mode === 'tokens' && tokens > 0 && due > 0 && <div className="actions">
                  <button className="secondary" type="button" onClick={() => completeWith('cash')}>Completar en efectivo</button>
                  <button className="secondary" type="button" onClick={() => completeWith('transfer')}>Completar por transferencia</button>
                  <button className="secondary" type="button" onClick={() => chooseMethod('mixed')}>Dividir el resto</button>
                </div>}
              </div>}
              {mode === 'mixed' && <PaymentFields value={payment} onChange={setPayment} showTokens={false} />}
              {mode === 'mixed' && <MixedCreditField remaining={remaining} amount={mixedCredit} onChange={setMixedCredit}
                hasAccount={Boolean(accountId)} />}
              <AccountPicker accounts={accounts} value={accountId} required={accountRequired} onChange={setAccountId}
                label={'Cuenta del cliente' + (accountRequired ? '' : ' (opcional)')} />
              {cashDue > 0 && <CashChangeField due={cashDue} received={received} onChange={setReceived} />}
              {mode === 'credit' && !accounts.length && <p>Crea una cuenta en el módulo Cuentas.</p>}
              {remaining < 0 && <p role="alert">El pago supera el total.</p>}
              {remaining > 0 && mode === 'tokens' && <p>{accountId ? 'Queda fiado: ' : 'Falta asignar: '}<strong>{money.format(remaining)}</strong></p>}
              <div className="order-actions">
                <button type="submit" data-confirm-sale disabled={!canConfirm}>
                  {busy ? 'Guardando…' : mode === 'credit' ? 'Guardar fiado' : 'Confirmar pago'}
                </button>
                <button type="button" data-key-cancel className="secondary" onClick={back}>Volver a la cuenta</button>
              </div>
            </fieldset>}
          </div>
        </form>
      </div>
      <details className="recent-sales"><summary>Ventas recientes sin nombre</summary>
        {!recent.length ? <p>Sin ventas sin nombre.</p> : <ul className="ledger-list">{recent.map((sale) => (
          <li key={sale.id}><div className="row-between"><strong>Venta #{sale.id}{sale.voided ? ' · Anulada' : ''}</strong><strong>{money.format(sale.total)}</strong></div>
            <time dateTime={sale.createdAt}>{time.format(new Date(sale.createdAt))}</time>
            <p>{sale.items.map((item) => item.quantity + ' × ' + item.label).join(' · ')}</p>
            {sale.payment && <p><PaymentBreakdown payment={sale.payment} /></p>}</li>
        ))}</ul>}
      </details>
      <details className="recent-sales"><summary>Canjes en ventas recientes</summary>
        {!redemptions.length ? <p>Sin canjes registrados.</p> : <ul className="ledger-list">{redemptions.map((entry) => (
          <li key={entry.id}><div className="row-between"><strong>Canje #{entry.id} · {entry.tokens} {entry.tokens === 1 ? 'ficha' : 'fichas'}</strong>
            <strong>{money.format(entry.subtotal)}</strong></div>
            <time dateTime={entry.createdAt}>{time.format(new Date(entry.createdAt))}</time>
            <p>{entry.items.map((item) => item.quantity + ' × ' + item.label).join(' · ')}</p>
            <p>Excedente: {money.format(entry.extra)}{entry.name ? ' · ' + entry.name : ''}</p>
          </li>
        ))}</ul>}
      </details>
    </section>
  );
}
