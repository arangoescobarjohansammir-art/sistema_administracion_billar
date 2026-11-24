import { useEffect, useRef, useState, type FormEvent } from 'react';
import { cashChange } from '../shared/tender';
import { CashChangeField } from './CashTools';
import { courtLabel, tejoCourtsPerType, tejoProductValue, tejoTypes, type TejoType } from '../shared/tejo';
import { api, emptyPayment, label, message, money, PaymentFields, totalPayment, useOperation,
  type Account, type PaymentInput, type Product } from './Accounts';

type Player = Pick<Account, 'id' | 'name'> & { accountId?: number | null };
type Redemption = {
  id: number; name: string | null; tokens: number; allowance: number; subtotal: number; extra: number;
  createdAt: string; items: { label: string; quantity: number; unitPrice: number }[];
};
type Benefit = { accountId: number; customerId?: number | null; name: string; issuedAt: string | null; redemption: Redemption | null };
type Round = { id: number; number: number; loser: string | null; loserId: number | null; total: number; benefits: Benefit[]; flexible?: boolean };
type Group = { id: number; courtType: TejoType; courtNumber: number; flexible?: boolean; players: Player[]; rounds: Round[] };
type RedeemEntry = { groupId: number; roundId: number; player: Benefit; flexible?: boolean };
type Overview = {
  active: Group[]; recent: Group[]; physicalRedemptions: Redemption[];
  tokenCounts: { issued: number; redeemed: number; receivedAsPayment: number };
};
type Action = (path: string, payload: object, success: string) => Promise<boolean>;
type Basket = { product: Product; quantity: number }[];
const searchText = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');

function StartGroup({ locked, onStart }: { locked: boolean; onStart: (count: number) => Promise<boolean> }) {
  const [count, setCount] = useState('2');
  return <form onSubmit={(event) => { event.preventDefault(); if (!locked) void onStart(Number(count)); }}>
    <h4>Abrir cancha</h4>
    <label>Número de jugadores<input type="number" min={2} max={20} step={1} inputMode="numeric" required
      disabled={locked} value={count} onChange={(event) => setCount(event.target.value)} /></label>
    <button disabled={locked}>Iniciar grupo</button>
  </form>;
}

function RecordChicos({ group, accounts, locked, act }: { group: Group; accounts: Account[]; locked: boolean; act: Action }) {
  const [issueAll, setIssueAll] = useState(false);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [names, setNames] = useState<Record<number, string>>({});
  const pending = group.rounds.filter((round) => round.loser === null);
  const total = Object.values(counts).reduce((sum, count) => sum + Number(count), 0);
  const missingName = group.players.some((player) => Number(counts[player.id]) > 0 && player.accountId === null && !names[player.id]?.trim());
  const base = 'tejo/' + group.id;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || total <= 0 || total > pending.length || missingName) return;
    const losses = group.players.filter((player) => Number(counts[player.id]) > 0)
      .map((player) => ({ playerId: player.id, count: Number(counts[player.id]), name: names[player.id] }));
    if (await act(base + '/assign', { losses }, 'Chicos asignados. Puedes cobrar el saldo en Cuentas.')) {
      setCounts({});
      setNames({});
    }
  }

  return <>
    <div className="sale-panel">
      <div className="section-title"><h4>{group.players.length} jugadores</h4>
        <button type="button" className="secondary" disabled={locked || group.players.length >= 20}
          onClick={() => void act(base + '/guest', {}, 'Jugador agregado para los próximos chicos.')}>Agregar jugador</button></div>
      <p>{group.players.map((player) => player.name + ' (' + group.rounds.filter((round) => round.loserId === player.id).length + ' perdidos)').join(' · ')}</p>
      <label className="check"><input type="checkbox" checked={issueAll} disabled={locked} onChange={(event) => setIssueAll(event.target.checked)} />
        Ya entregué una ficha a cada jugador de este chico</label>
      <button type="button" disabled={locked} onClick={async () => {
        if (await act(base + '/record', { issueAll }, 'Chico registrado. Puedes asignar quién perdió después.')) setIssueAll(false);
      }}>Registrar chico {group.rounds.length + 1}</button>
    </div>
    {pending.length > 0 && <form onSubmit={save}>
      <div className="section-title"><h4>Asignar chicos perdidos</h4><strong>{pending.length} por asignar</strong></div>
      <datalist id={'tejo-customer-names-' + group.id}>{accounts.map((account) => <option key={account.id} value={account.name} />)}</datalist>
      <fieldset className="plain-fieldset" disabled={locked}>
        {group.players.map((player) => {
          const eligible = pending.filter((round) => round.benefits.some((benefit) => benefit.accountId === player.id)).length;
          return eligible > 0 && <div className="field-grid" key={player.id}>
            <label>{player.name} · chicos perdidos<input type="number" min={0} max={eligible} step={1} inputMode="numeric" placeholder="0"
              value={counts[player.id] ?? ''} onChange={(event) => setCounts((previous) => ({ ...previous, [player.id]: event.target.value }))} /></label>
            {player.accountId === null && Number(counts[player.id]) > 0 && <label>Nombre de {player.name.toLowerCase()}
              <input required maxLength={100} list={'tejo-customer-names-' + group.id} value={names[player.id] ?? ''}
                onChange={(event) => setNames((previous) => ({ ...previous, [player.id]: event.target.value }))} /></label>}
          </div>;
        })}
        {total > pending.length && <p role="alert">Solo quedan {pending.length} chicos por asignar.</p>}
        <button disabled={total <= 0 || total > pending.length || missingName}>Guardar pérdidas</button>
      </fieldset>
    </form>}
  </>;
}

function RegisterRound({ group, locked, act }: { group: Group; locked: boolean; act: Action }) {
  const [loser, setLoser] = useState('');
  const [issues, setIssues] = useState(false);
  const [payment, setPayment] = useState(emptyPayment);
  const total = group.players.length * tejoProductValue;
  const due = total - totalPayment(payment);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loser || due < 0 || locked) return;
    if (await act('tejo/' + group.id + '/rounds', {
      loserId: Number(loser), issueAll: issues, payment,
    }, 'Chico registrado.')) {
      setLoser('');
      setIssues(false);
      setPayment(emptyPayment);
    }
  }

  return (
    <form onSubmit={save}>
      <div className="section-title"><h4>Registrar chico {group.rounds.length + 1}</h4><strong>{money.format(total)}</strong></div>
      <fieldset disabled={locked} className="plain-fieldset">
        <label>Quién perdió<select required value={loser} onChange={(event) => setLoser(event.target.value)}>
          <option value="">Seleccionar jugador</option>
          {group.players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
        </select></label>
        <label className="check"><input type="checkbox" checked={issues} onChange={(event) => setIssues(event.target.checked)} />
          Ya entregué una ficha a cada participante</label>
        <PaymentFields value={payment} onChange={setPayment} />
        {due < 0 ? <p role="alert">El pago supera el valor del chico.</p> : <p>Saldo a cuenta de quien perdió: <strong>{money.format(due)}</strong></p>}
        <button disabled={!loser || due < 0}>Guardar chico</button>
      </fieldset>
    </form>
  );
}

const redemptionMethods = [
  ['cash', 'Efectivo'], ['transfer', 'Transferencia'], ['mixed', 'Pago mixto'], ['credit', 'Dejar fiado'],
] as const;
type RedemptionMethod = typeof redemptionMethods[number][0] | '';

function RedeemForm({ entry, accounts, products, locked, act, onCancel }: {
  entry?: RedeemEntry;
  accounts: Account[]; products: Product[]; locked: boolean; act: Action; onCancel?: () => void;
}) {
  const [tokens, setTokens] = useState('1');
  const [payee, setPayee] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [basket, setBasket] = useState<Basket>([]);
  const [method, setMethod] = useState<RedemptionMethod>('');
  const [payment, setPayment] = useState(emptyPayment);
  const [received, setReceived] = useState('');
  const results = useRef<HTMLDivElement>(null);
  const validTokens = Boolean(entry) || (Number.isInteger(Number(tokens)) && Number(tokens) >= 1 && Number(tokens) <= 1000);
  const allowance = (entry ? 1 : Number(tokens)) * tejoProductValue;
  const subtotal = basket.reduce((sum, { product, quantity }) => sum + product.price * quantity, 0);
  const extra = Math.max(0, subtotal - allowance);
  const unused = Math.max(0, allowance - subtotal);
  const methods = extra === 0 ? emptyPayment : method === 'cash' ? { ...emptyPayment, cash: extra }
    : method === 'transfer' ? { ...emptyPayment, transfer: extra } : method === 'mixed' ? payment : emptyPayment;
  const remaining = extra - totalPayment(methods);
  const knownPlayer = Boolean(entry && (!entry.flexible || entry.player.customerId));
  const change = cashChange(methods.cash, received);
  const needsAccount = remaining > 0 && (method === 'credit' || method === 'mixed');
  const quantitiesValid = basket.every(({ product, quantity }) => Number.isInteger(quantity) && quantity > 0 && quantity <= product.stock);
  const ready = !locked && validTokens && basket.length > 0 && quantitiesValid &&
    (extra === 0 || (Boolean(method) && remaining >= 0 && (remaining === 0 || Boolean(payee) || knownPlayer) &&
      (methods.cash <= 0 || change === null || (Number.isInteger(change) && change >= 0))));
  const matches = products.filter((product) => searchText(label(product)).includes(searchText(query.trim())));
  const visible = expanded ? matches : matches.slice(0, 12);

  function add(product: Product) {
    setBasket((previous) => previous.some(({ product: item }) => item.id === product.id)
      ? previous.map((item) => item.product.id === product.id ? { ...item, quantity: Math.min(item.quantity + 1, product.stock) } : item)
      : [...previous, { product, quantity: 1 }]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    const items = basket.map(({ product, quantity }) => ({ productId: product.id, quantity, unitPrice: product.price }));
    const accountId = needsAccount && payee ? Number(payee) : null;
    if (entry) {
      if (await act('tejo/' + entry.groupId + (entry.flexible ? '/flex-benefits' : '/benefits'), {
        roundId: entry.roundId, playerId: entry.player.accountId, choice: 'products', items, payment: methods, accountId,
      }, 'Consumo del chico registrado.')) onCancel?.();
    } else {
      const tokenText = tokens + (tokens === '1' ? ' ficha recibida.' : ' fichas recibidas.');
      if (await act('tejo/redemptions', { tokens: Number(tokens), accountId, items, payment: methods }, 'Canje registrado. ' +
        tokenText + (methods.cash && change !== null ? ' Devuelto: ' + money.format(change) + '.' : ''))) {
        setTokens('1');
        setPayee('');
        setQuery('');
        setExpanded(false);
        setBasket([]);
        setMethod('');
        setPayment(emptyPayment);
        setReceived('');
      }
    }
  }

  return (
    <form className="redemption-form" onSubmit={save} aria-label="Registrar canje">
      <div className="section-title"><h3>{entry ? 'Consumo de ' + entry.player.name : 'Canje por productos'}</h3></div>
      <fieldset disabled={locked} className="plain-fieldset">
        {!entry && <section className="redemption-step" aria-labelledby="redeem-tokens">
          <h4 id="redeem-tokens">1. Fichas que entrega el cliente</h4>
          <div className="redemption-token-row">
            <label>Cantidad de fichas<input type="number" min={1} max={1000} step={1} inputMode="numeric" required value={tokens}
              onFocus={(event) => event.currentTarget.select()} onChange={(event) => setTokens(event.target.value)} /></label>
            <p>Disponible para productos<strong>{validTokens ? money.format(allowance) : '—'}</strong></p>
          </div>
          <p className="secondary-text">Cada ficha cubre hasta {money.format(tejoProductValue)} en productos. Para abonar {money.format(3000)} por ficha, ve a <strong>Cuentas</strong>.</p>
        </section>}
        {entry && <p className="secondary-text">Este chico cubre hasta <strong>{money.format(allowance)}</strong> en productos para {entry.player.name}.</p>}
        <section className="redemption-step" aria-labelledby="redeem-products">
          <h4 id="redeem-products">{entry ? 'Productos que lleva' : '2. Productos que lleva'}</h4>
          <label>Buscar producto<input type="search" data-key-search autoFocus={Boolean(entry)} value={query}
            placeholder="Busca por nombre, marca o presentación" onChange={(event) => { setQuery(event.target.value); setExpanded(false); }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'Enter') return;
              event.preventDefault();
              results.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
            }} /></label>
          {!products.length && <p>Agrega existencias en Inventario para poder canjear productos.</p>}
          {products.length > 0 && !matches.length && <p>No se encontraron productos.</p>}
          <div className="sale-products redemption-products" ref={results}>
            {visible.map((product) => {
              const current = basket.find((item) => item.product.id === product.id);
              return <button className="sale-product" key={product.id} type="button"
                disabled={(current?.quantity ?? 0) >= product.stock || (!current && basket.length >= 50)}
                aria-label={'Agregar ' + label(product) + ' por ' + money.format(product.price)} onClick={() => add(product)}>
                <strong className="sale-product-name">{product.name}</strong>
                <span className="secondary-text">{[product.brand, product.presentation].filter(Boolean).join(' · ')}</span>
                <b>{money.format(product.price)}</b>
              </button>;
            })}
          </div>
          {!expanded && matches.length > visible.length && <button type="button" className="secondary space-above"
            onClick={() => setExpanded(true)}>Ver los {matches.length} productos</button>}
          {basket.length > 0 && <ul className="cart-list">{basket.map(({ product, quantity }) => (
            <li key={product.id}>
              <div><strong>{label(product)}</strong><p>{money.format(product.price * quantity)}</p></div>
              <label>Cantidad<input type="number" min={1} max={product.stock} step={1} inputMode="numeric" required value={quantity || ''}
                aria-label={'Cantidad de ' + label(product)} onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setBasket((previous) => previous.map((item) => item.product.id === product.id
                  ? { ...item, quantity: Number(event.target.value) } : item))} /></label>
              <button className="secondary" type="button" aria-label={'Quitar ' + label(product)}
                onClick={() => setBasket((previous) => previous.filter((item) => item.product.id !== product.id))}>Quitar</button>
            </li>
          ))}</ul>}
        </section>
        <section className="redemption-step redemption-review" aria-labelledby="redeem-review">
          <h4 id="redeem-review">{entry ? 'Revisar y confirmar' : '3. Revisar y confirmar'}</h4>
          <div className="totals">
            <span>Valor de los productos<strong>{money.format(subtotal)}</strong></span>
            <span>{entry ? 'Cubre el chico' : 'Cubren las fichas'}<strong>{money.format(Math.min(allowance, subtotal))}</strong></span>
            <span>Por cobrar<strong>{money.format(extra)}</strong></span>
          </div>
          {!basket.length && <p>Agrega los productos que se van a entregar.</p>}
          {basket.length > 0 && validTokens && extra === 0 && unused === 0 && <p>El canje cubre todo. No hay dinero por cobrar.</p>}
          {basket.length > 0 && validTokens && unused > 0 && <p className="redemption-note">Puedes agregar productos por {money.format(unused)}. Si confirmas así, ese valor no se devuelve ni queda como saldo.</p>}
          {extra > 0 && validTokens && <div className="redemption-payment">
            <h4>¿Cómo paga lo que falta?</h4>
            <div className="actions">{redemptionMethods.map(([id, name]) => <button key={id} type="button" className="secondary"
              aria-pressed={method === id} onClick={() => { setMethod(id); setReceived(''); }}>{name}</button>)}</div>
            {method === 'mixed' && <PaymentFields value={payment} onChange={setPayment} />}
            {methods.cash > 0 && <CashChangeField due={methods.cash} received={received} onChange={setReceived} />}
            {remaining < 0 && <p role="alert">El pago supera lo que falta por cobrar.</p>}
            {needsAccount && (knownPlayer ? <p>Queda fiado a {entry?.player.name}: <strong>{money.format(remaining)}</strong></p>
              : <label>Cuenta para anotar {money.format(remaining)}<select required value={payee} onChange={(event) => setPayee(event.target.value)}>
                <option value="">Seleccionar cliente</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select></label>)}
          </div>}
          <div className="actions">
            <button disabled={!ready}>Confirmar canje y entrega</button>
            {onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancelar</button>}
          </div>
        </section>
      </fieldset>
    </form>
  );
}

function RedeemedProducts({ redemption }: { redemption: Redemption }) {
  return <ul className="sale-lines">{redemption.items.map((item, index) => (
    <li key={index}><span>{item.quantity} × {item.label}</span><span>{money.format(item.quantity * item.unitPrice)}</span></li>
  ))}</ul>;
}

function RoundHistory({ group, locked, onRedeem, act }: {
  group: Group; locked?: boolean; onRedeem?: (round: Round, player: Benefit) => void; act?: Action;
}) {
  if (!group.rounds.length) return <p>Sin chicos registrados.</p>;
  return (
    <ul className="ledger-list">{group.rounds.map((round) => (
      <li key={round.number}>
        <div className="row-between"><strong>Chico {round.number} · {round.loser ? (round.flexible ? 'cargo de ' : 'perdió ') + round.loser : 'sin perdedor asignado'}</strong><strong>{money.format(round.total)}</strong></div>
        <details className="space-above"><summary>Fichas y consumos · {round.benefits.filter((benefit) => !benefit.issuedAt && !benefit.redemption).length} pendientes</summary>
        <ul className="tejo-benefits">{round.benefits.map((benefit) => (
          <li key={benefit.accountId}>
            <div className="row-between"><strong>{benefit.name}</strong>
              <span>{benefit.issuedAt ? 'Ficha entregada' : benefit.redemption ? 'Consumió su derecho' : 'Pendiente'}</span></div>
            {benefit.redemption && <>
              <RedeemedProducts redemption={benefit.redemption} />
              {benefit.redemption.extra > 0 && <p>Excedente: {money.format(benefit.redemption.extra)}</p>}
            </>}
            {!benefit.issuedAt && !benefit.redemption && act && onRedeem && <div className="actions">
              <button className="secondary" type="button" disabled={locked} onClick={() => void act('tejo/' + group.id + (round.flexible ? '/flex-benefits' : '/benefits'), {
                roundId: round.id, playerId: benefit.accountId, choice: 'token',
              }, 'Ficha entregada y registrada.')}>Entregar ficha</button>
              <button className="secondary" type="button" disabled={locked} onClick={() => onRedeem(round, benefit)}>Registrar consumo</button>
            </div>}
          </li>
        ))}</ul></details>
      </li>
    ))}</ul>
  );
}

export function Tejo() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [mode, setMode] = useState<'courts' | 'tokens'>('courts');
  const [type, setType] = useState<TejoType>('maxi');
  const [court, setCourt] = useState(1);
  const [redemption, setRedemption] = useState<RedeemEntry | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const write = useOperation();

  async function load() {
    setLoadError('');
    try {
      const [data, people, catalog] = await Promise.all([
        api<Overview>('tejo'), api<Account[]>('accounts'), api<Product[]>('products'),
      ]);
      setOverview(data);
      setAccounts(people);
      setProducts(catalog.filter((product) => product.active && product.stock > 0));
    } catch (error) {
      setLoadError(message(error));
    }
  }

  useEffect(() => { void load(); }, []);

  const locked = busy || Boolean(loadError);

  async function act(path: string, payload: object, success: string) {
    if (locked) return false;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await write(path, payload);
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

  function clearSelection() {
    setRedemption(null);
    setError('');
    setStatus('');
  }

  const group = overview?.active.find((item) => item.courtType === type && item.courtNumber === court);
  const benefits = group?.rounds.flatMap((round) => round.benefits) ?? [];
  const pending = benefits.filter((benefit) => !benefit.issuedAt && !benefit.redemption).length;
  const pendingResults = group?.rounds.filter((round) => round.loser === null).length ?? 0;

  return (
    <section aria-labelledby="tejo-title">
      <div className="section-title"><h2 id="tejo-title">Tejo</h2><strong>{money.format(tejoProductValue)} por participante y chico</strong></div>
      <nav className="actions accounts-nav" aria-label="Secciones de tejo">
        <button className="navigation" aria-pressed={mode === 'courts'} disabled={busy} onClick={() => { setMode('courts'); clearSelection(); }}>Canchas y chicos</button>
        <button className="navigation" aria-pressed={mode === 'tokens'} disabled={busy} onClick={() => { setMode('tokens'); clearSelection(); }}>Canjear fichas</button>
      </nav>
      {loadError && <p role="alert">{loadError} <button className="secondary" onClick={() => void load()}>Actualizar datos</button></p>}
      {!loadError && !overview && <p role="status">Cargando canchas…</p>}
      {overview && mode === 'courts' && <>
        {tejoTypes.map((courtType) => (
          <section key={courtType} aria-label={courtType === 'maxi' ? 'Maxitejo' : 'Tejo largo'}>
            <h3>{courtType === 'maxi' ? 'Maxitejo' : 'Tejo largo'}</h3>
            <ul className="billiard-grid">{Array.from({ length: tejoCourtsPerType }, (_, index) => index + 1).map((number) => {
              const entry = overview.active.find((item) => item.courtType === courtType && item.courtNumber === number);
              return <li key={number}><button className="table-button" aria-label={courtLabel(courtType, number)}
                aria-pressed={courtType === type && number === court} disabled={busy} onClick={() => {
                  setType(courtType); setCourt(number); clearSelection();
                }}><strong>Cancha {number}</strong><span data-occupied={Boolean(entry)}>{entry ? entry.rounds.length + (entry.rounds.length === 1 ? ' chico' : ' chicos') : 'Libre'}</span></button></li>;
            })}</ul>
          </section>
        ))}
        <section className="billiard-panel" aria-label={courtLabel(type, court)}>
          <div className="section-title"><h3>{courtLabel(type, court)}</h3>
            {group && <strong>{group.rounds.length} {group.rounds.length === 1 ? 'chico registrado' : 'chicos registrados'}</strong>}</div>
          {error && <p role="alert">{error}</p>}
          {status && <p role="status">{status}</p>}
          {!group ? <StartGroup key={courtLabel(type, court)} locked={locked}
            onStart={(playerCount) => act('tejo', { courtType: type, courtNumber: court, playerCount }, 'Cancha abierta.')} />
            : <>
              {!group.flexible && <p>{group.players.map((player) => player.name).join(' · ')}</p>}
              <p>{benefits.filter((benefit) => benefit.issuedAt).length} fichas entregadas ·{' '}
                {benefits.filter((benefit) => benefit.redemption).length} consumos · {pending} pendientes</p>
              {group.flexible ? <RecordChicos key={group.id} group={group} locked={locked} act={act} accounts={accounts} />
                : <RegisterRound key={group.id} group={group} locked={locked} act={act} />}
              {redemption && redemption.groupId === group.id && <RedeemForm key={String(redemption.flexible) + ':' + redemption.roundId + ':' + redemption.player.accountId}
                entry={redemption} accounts={accounts} products={products} locked={locked} act={act} onCancel={() => setRedemption(null)} />}
              <RoundHistory group={group} locked={locked} act={act}
                onRedeem={(round, player) => {
                  setError(''); setStatus(''); setRedemption({ groupId: group.id, roundId: round.id, player, flexible: round.flexible });
                }} />
              <button className="secondary" disabled={locked || pending > 0 || pendingResults > 0}
                onClick={() => void act('tejo/' + group.id + '/close', {}, 'Grupo cerrado. Cancha libre.')}>Cerrar grupo y liberar cancha</button>
              {pending > 0 && <p>Registra los derechos pendientes para liberar la cancha.</p>}
              {pendingResults > 0 && <p>Asigna los chicos perdidos para liberar la cancha.</p>}
            </>}
        </section>
        {overview.recent.length > 0 && <section className="tejo-history"><h3>Últimos grupos cerrados</h3>
          {overview.recent.map((entry) => <details key={entry.id}><summary>{courtLabel(entry.courtType, entry.courtNumber)} · Grupo #{entry.id} · {entry.rounds.length} {entry.rounds.length === 1 ? 'chico' : 'chicos'}</summary>
            <RoundHistory group={entry} /></details>)}
        </section>}
      </>}
      {overview && mode === 'tokens' && <>
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        <RedeemForm accounts={accounts} products={products} locked={locked} act={act} />
        <details className="recent-sales"><summary>Historial de canjes y totales de fichas</summary>
        <div className="totals" aria-label="Totales históricos de fichas">
          <span>Entregadas en tejo <strong>{overview.tokenCounts.issued}</strong></span>
          <span>Recibidas por canje <strong>{overview.tokenCounts.redeemed}</strong></span>
          <span>Recibidas como pago <strong>{overview.tokenCounts.receivedAsPayment}</strong></span>
        </div>
        {!overview.physicalRedemptions.length ? <p>Sin canjes registrados.</p> : <ul className="ledger-list">
          {overview.physicalRedemptions.map((item) => <li key={item.id}>
            <div className="row-between"><strong>Canje #{item.id} · {item.tokens} {item.tokens === 1 ? 'ficha' : 'fichas'}</strong>
              <strong>{item.name ?? 'Sin nombre'}</strong></div>
            <RedeemedProducts redemption={item} />
            <p>Excedente: {money.format(item.extra)}</p>
          </li>)}
        </ul>}</details>
      </>}
    </section>
  );
}
