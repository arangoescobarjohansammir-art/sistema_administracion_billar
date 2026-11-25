import { useEffect, useState, type FormEvent } from 'react';
import { cashChange, mixedCreditPlan } from '../shared/tender';
import { CashChangeField } from './CashTools';
import { AccountPicker, CustomerLookup } from './CustomerLookup';
import { ConsumptionProducts, ProductLookup } from './ProductPicker';
import { courtLabel, tejoCourtsPerType, tejoProductValue, tejoTeams, tejoTypes, type TejoTeam, type TejoType } from '../shared/tejo';
import { api, emptyPayment, label, message, MixedCreditField, money, PaymentFields, totalPayment, useOperation,
  type Account, type PaymentInput, type Product } from './Accounts';

type Player = Pick<Account, 'id' | 'name'> & { accountId?: number | null };
type Redemption = {
  id: number; name: string | null; tokens: number; allowance: number; subtotal: number; extra: number;
  createdAt: string; items: { label: string; quantity: number; unitPrice: number }[];
};
type Benefit = { accountId: number; customerId?: number | null; name: string; issuedAt: string | null; redemption: Redemption | null };
type Round = {
  id: number; number: number; loser: string | null; loserId: number | null; total: number; benefits: Benefit[]; flexible?: boolean;
  losingTeam?: TejoTeam | null; charges?: { playerId: number; name: string; amount: number }[];
};
type Group = { id: number; courtType: TejoType; courtNumber: number; flexible?: boolean; teamSize?: number; players: Player[]; rounds: Round[] };
type RedeemEntry = { groupId: number; roundId: number; player: Benefit; flexible?: boolean };
type Overview = { active: Group[]; recent: Group[]; availableTokens: number | null };
type Action = (path: string, payload: object, success: string) => Promise<boolean>;
type Basket = { product: Product; quantity: number }[];

const isPending = (round: Round) => round.loser === null && !round.losingTeam;
const teamPlayers = (players: Player[], size: number, team: TejoTeam) =>
  team === 'A' ? players.slice(0, size) : players.slice(size);

function StartGroup({ locked, onStart }: { locked: boolean; onStart: (count: number, teamSize?: number) => Promise<boolean> }) {
  const [count, setCount] = useState('2');
  const [size, setSize] = useState(0);
  const players = size ? size * 2 : Number(count);
  return <form onSubmit={(event) => { event.preventDefault(); if (!locked) void onStart(players, size || undefined); }}>
    <h4>Abrir cancha</h4>
    <div className="field-grid">
      <label>Modalidad<select disabled={locked} value={size} onChange={(event) => setSize(Number(event.target.value))}>
        <option value={0}>Individual</option>
        {[2, 3, 4].map((teamSize) => <option key={teamSize} value={teamSize}>{teamSize} vs {teamSize}</option>)}
      </select></label>
      {!size && <label>Número de jugadores<input type="number" min={2} max={20} step={1} inputMode="numeric" required
        disabled={locked} value={count} onChange={(event) => setCount(event.target.value)} /></label>}
    </div>
    {size > 0 && <p>{players} jugadores · <strong>{money.format(players * tejoProductValue)}</strong> por chico.
      Cada jugador del equipo perdedor paga <strong>{money.format(2 * tejoProductValue)}</strong>.</p>}
    <button disabled={locked}>Iniciar grupo</button>
  </form>;
}

function IssueAllTokens({ checked, onChange, canIssueAll, locked }: {
  checked: boolean; onChange: (checked: boolean) => void; canIssueAll: boolean; locked?: boolean;
}) {
  return <>
    <label className="check"><input type="checkbox" checked={canIssueAll && checked} disabled={locked || !canIssueAll}
      onChange={(event) => onChange(event.target.checked)} />
      Ya entregué una ficha a cada jugador de este chico</label>
    {!canIssueAll && <p>Puedes registrar el chico y dejar la entrega de fichas pendiente.</p>}
  </>;
}

function AssignTeamLosses({ group, size, accounts, locked, act, pending }: {
  group: Group; size: number; accounts: Account[]; locked: boolean; act: Action; pending: number;
}) {
  const [counts, setCounts] = useState<Record<TejoTeam, string>>({ A: '', B: '' });
  const [names, setNames] = useState<Record<number, string>>({});
  const teams = tejoTeams.map((team) => ({
    team, count: Number(counts[team]), members: teamPlayers(group.players, size, team),
  }));
  const losses = teams.filter(({ count }) => count > 0);
  const total = losses.reduce((sum, { count }) => sum + count, 0);
  const ready = total > 0 && total <= pending && teams.every(({ count }) => Number.isInteger(count) && count >= 0) &&
    losses.every(({ members }) => members.every(({ id, accountId }) => accountId !== null || Boolean(names[id]?.trim())));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || !ready) return;
    if (await act('tejo/' + group.id + '/assign', {
      losses: losses.map(({ team, count, members }) => ({
        team, count, players: members.map(({ id }) => ({ playerId: id, name: names[id] })),
      })),
    }, 'Chicos asignados. El cargo quedó repartido entre los jugadores de los equipos que perdieron.')) {
      setCounts({ A: '', B: '' });
      setNames({});
    }
  }

  return <form onSubmit={save}>
    <div className="section-title"><h4>Asignar chicos perdidos por equipo</h4><strong>{pending} por asignar</strong></div>
    {pending > 1 && <p>Los resultados se aplican a los chicos pendientes en orden de registro, empezando por las pérdidas del equipo A.</p>}
    <fieldset className="plain-fieldset" disabled={locked}>
      {teams.map(({ team, count, members }) => <div key={team} className="space-above">
        <label>Equipo {team} · chicos perdidos<input type="number" min={0} max={pending} step={1} inputMode="numeric" placeholder="0"
          value={counts[team]} onChange={(event) => setCounts({ ...counts, [team]: event.target.value })} /></label>
        {count > 0 && <>
          <p>Cargo por jugador: <strong>{money.format(count * 2 * tejoProductValue)}</strong></p>
          <div className="field-grid">
            {members.map((player) => player.accountId !== null ? <p key={player.id}>{player.name}</p>
              : <CustomerLookup key={player.id} accounts={accounts} label={'Nombre de ' + player.name.toLowerCase() + ' · equipo ' + team}
                text={names[player.id] ?? ''} required
                onTextChange={(name) => setNames((previous) => ({ ...previous, [player.id]: name }))}
                onChoose={({ name }) => setNames((previous) => ({ ...previous, [player.id]: name }))} />)}
          </div>
        </>}
      </div>)}
      {total > pending && <p role="alert">Solo quedan {pending} chicos por asignar.</p>}
      <button disabled={!ready}>Guardar pérdidas</button>
    </fieldset>
  </form>;
}

function RecordChicos({ group, accounts, locked, act, availableTokens }: {
  group: Group; accounts: Account[]; locked: boolean; act: Action; availableTokens: number | null;
}) {
  const [issueAll, setIssueAll] = useState(false);
  const canIssueAll = (availableTokens ?? 0) >= group.players.length;
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [names, setNames] = useState<Record<number, string>>({});
  const pending = group.rounds.filter(isPending);
  const size = group.teamSize ?? 0;
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
      <div className="section-title"><h4>{size ? size + ' vs ' + size + ' · ' : ''}{group.players.length} jugadores</h4>
        {size === 0 && <button type="button" className="secondary" disabled={locked || group.players.length >= 20}
          onClick={() => void act(base + '/guest', {}, 'Jugador agregado para los próximos chicos.')}>Agregar jugador</button>}</div>
      {size ? <div className="field-grid">
        {tejoTeams.map((team) => <div key={team}>
          <strong>Equipo {team} · {group.rounds.filter((round) => round.losingTeam === team).length} perdidos</strong>
          <p>{teamPlayers(group.players, size, team).map(({ name }) => name).join(' · ')}</p>
        </div>)}
      </div> : <p>{group.players.map((player) => player.name + ' (' + group.rounds.filter((round) => round.loserId === player.id).length + ' perdidos)').join(' · ')}</p>}
      <IssueAllTokens checked={issueAll} onChange={setIssueAll} canIssueAll={canIssueAll} locked={locked} />
      <button type="button" disabled={locked} onClick={async () => {
        if (await act(base + '/record', { issueAll: canIssueAll && issueAll },
          'Chico registrado. Puedes asignar quién perdió después.')) setIssueAll(false);
      }}>Registrar chico {group.rounds.length + 1}</button>
    </div>
    {pending.length > 0 && (size ? <AssignTeamLosses group={group} size={size} accounts={accounts}
      locked={locked} act={act} pending={pending.length} /> : <form onSubmit={save}>
      <div className="section-title"><h4>Asignar chicos perdidos</h4><strong>{pending.length} por asignar</strong></div>
      <fieldset className="plain-fieldset" disabled={locked}>
        {group.players.map((player) => {
          const eligible = pending.filter((round) => round.benefits.some((benefit) => benefit.accountId === player.id)).length;
          return eligible > 0 && <div className="field-grid" key={player.id}>
            <label>{player.name} · chicos perdidos<input type="number" min={0} max={eligible} step={1} inputMode="numeric" placeholder="0"
              value={counts[player.id] ?? ''} onChange={(event) => setCounts((previous) => ({ ...previous, [player.id]: event.target.value }))} /></label>
            {player.accountId === null && Number(counts[player.id]) > 0 && <CustomerLookup accounts={accounts}
              label={'Nombre de ' + player.name.toLowerCase()} text={names[player.id] ?? ''} required
              onTextChange={(name) => setNames((previous) => ({ ...previous, [player.id]: name }))}
              onChoose={({ name }) => setNames((previous) => ({ ...previous, [player.id]: name }))} />}
          </div>;
        })}
        {total > pending.length && <p role="alert">Solo quedan {pending.length} chicos por asignar.</p>}
        <button disabled={total <= 0 || total > pending.length || missingName}>Guardar pérdidas</button>
      </fieldset>
    </form>)}
  </>;
}

function RegisterRound({ group, locked, act, availableTokens }: {
  group: Group; locked: boolean; act: Action; availableTokens: number | null;
}) {
  const [loser, setLoser] = useState('');
  const [issues, setIssues] = useState(false);
  const [payment, setPayment] = useState(emptyPayment);
  const total = group.players.length * tejoProductValue;
  const due = total - totalPayment(payment);
  const canIssueAll = availableTokens !== null && availableTokens + payment.tokens >= group.players.length;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loser || due < 0 || locked) return;
    if (await act('tejo/' + group.id + '/rounds', {
      loserId: Number(loser), issueAll: canIssueAll && issues, payment,
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
        <IssueAllTokens checked={issues} onChange={setIssues} canIssueAll={canIssueAll} />
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
  entry: RedeemEntry;
  accounts: Account[]; products: Product[]; locked: boolean; act: Action; onCancel?: () => void;
}) {
  const [payee, setPayee] = useState('');
  const [query, setQuery] = useState('');
  const [basket, setBasket] = useState<Basket>([]);
  const [method, setMethod] = useState<RedemptionMethod>('');
  const [mixedCredit, setMixedCredit] = useState('');
  const [payment, setPayment] = useState(emptyPayment);
  const [received, setReceived] = useState('');
  const allowance = tejoProductValue;
  const subtotal = basket.reduce((sum, { product, quantity }) => sum + product.price * quantity, 0);
  const extra = Math.max(0, subtotal - allowance);
  const unused = Math.max(0, allowance - subtotal);
  const methods = extra === 0 ? emptyPayment : method === 'cash' ? { ...emptyPayment, cash: extra }
    : method === 'transfer' ? { ...emptyPayment, transfer: extra } : method === 'mixed' ? payment : emptyPayment;
  const remaining = extra - totalPayment(methods);
  const plan = mixedCreditPlan(remaining, mixedCredit);
  const credit = method === 'mixed' ? plan.credit : remaining;
  const knownPlayer = !entry.flexible || Boolean(entry.player.customerId);
  const change = cashChange(methods.cash, received);
  const needsAccount = credit > 0 && (method === 'credit' || method === 'mixed');
  const quantitiesValid = basket.every(({ product, quantity }) => Number.isInteger(quantity) && quantity > 0 && quantity <= product.stock);
  const ready = !locked && basket.length > 0 && quantitiesValid &&
    (extra === 0 || (Boolean(method) && remaining >= 0 && (remaining === 0 || Boolean(payee) || knownPlayer) &&
      (method !== 'mixed' || plan.valid) &&
      (methods.cash <= 0 || change === null || (Number.isInteger(change) && change >= 0))));
  function unavailable(product: Product) {
    const current = basket.find((item) => item.product.id === product.id);
    return (current?.quantity ?? 0) >= product.stock || (!current && basket.length >= 50);
  }

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
    if (await act('tejo/' + entry.groupId + (entry.flexible ? '/flex-benefits' : '/benefits'), {
      roundId: entry.roundId, playerId: entry.player.accountId, choice: 'products', items, payment: methods, accountId,
    }, 'Consumo del chico registrado.')) onCancel?.();
  }

  return (
    <form className="redemption-form" onSubmit={save} aria-label="Registrar consumo del chico">
      <div className="section-title"><h3>Consumo de {entry.player.name}</h3></div>
      <fieldset disabled={locked} className="plain-fieldset">
        <p className="secondary-text">Este chico cubre hasta <strong>{money.format(allowance)}</strong> en productos para {entry.player.name}.</p>
        <section className="redemption-step" aria-labelledby="redeem-products">
          <h4 id="redeem-products">Productos que lleva</h4>
          <ProductLookup products={products.filter((product) => !unavailable(product))} query={query} autoFocus
            onQueryChange={setQuery} onChoose={add} />
          <ConsumptionProducts key={query} products={products} query={query} action="Agregar" onChoose={add}
            unavailable={unavailable} />
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
          <h4 id="redeem-review">Revisar y confirmar</h4>
          <div className="totals">
            <span>Valor de los productos<strong>{money.format(subtotal)}</strong></span>
            <span>Cubre el chico<strong>{money.format(Math.min(allowance, subtotal))}</strong></span>
            <span>Por cobrar<strong>{money.format(extra)}</strong></span>
          </div>
          {!basket.length && <p>Agrega los productos que se van a entregar.</p>}
          {basket.length > 0 && extra === 0 && unused === 0 && <p>El chico cubre todo. No hay dinero por cobrar.</p>}
          {basket.length > 0 && unused > 0 && <p className="redemption-note">Puedes agregar productos por {money.format(unused)}. Si confirmas así, ese valor no se devuelve ni queda como saldo.</p>}
          {extra > 0 && <div className="redemption-payment">
            <h4>¿Cómo paga lo que falta?</h4>
            <div className="actions">{redemptionMethods.map(([id, name]) => <button key={id} type="button" className="secondary"
              aria-pressed={method === id} onClick={() => { setMethod(id); setReceived(''); }}>{name}</button>)}</div>
            {method === 'mixed' && <PaymentFields value={payment} onChange={setPayment} />}
            {method === 'mixed' && <MixedCreditField remaining={remaining} amount={mixedCredit} onChange={setMixedCredit}
              hasAccount={knownPlayer || Boolean(payee)} />}
            {methods.cash > 0 && <CashChangeField due={methods.cash} received={received} onChange={setReceived} />}
            {remaining < 0 && <p role="alert">El pago supera lo que falta por cobrar.</p>}
            {needsAccount && (knownPlayer ? <p>{method === 'mixed' ? <>Cuenta del fiado: <strong>{entry.player.name}</strong></>
              : <>Queda fiado a {entry.player.name}: <strong>{money.format(credit)}</strong></>}</p>
              : <AccountPicker accounts={accounts} label={'Cuenta para anotar ' + money.format(credit)} required
                value={payee} onChange={setPayee} />)}
          </div>}
          <div className="actions">
            <button disabled={!ready}>Confirmar consumo y entrega</button>
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

function RoundHistory({ group, locked, onRedeem, act, availableTokens }: {
  group: Group; locked?: boolean; onRedeem?: (round: Round, player: Benefit) => void; act?: Action; availableTokens?: number | null;
}) {
  if (!group.rounds.length) return <p>Sin chicos registrados.</p>;
  return (
    <ul className="ledger-list">{group.rounds.map((round) => (
      <li key={round.number}>
        <div className="row-between"><strong>Chico {round.number} · {round.losingTeam ? 'perdió el equipo ' + round.losingTeam
          : round.loser ? (round.flexible ? 'cargo de ' : 'perdió ') + round.loser : 'sin perdedor asignado'}</strong>
          <strong>{money.format(round.total)}</strong></div>
        {Boolean(round.charges?.length) && <ul className="sale-lines" aria-label="Cargos del equipo perdedor">
          {round.charges?.map(({ playerId, name, amount }) => <li key={playerId}><span>{name}</span><strong>{money.format(amount)}</strong></li>)}
        </ul>}
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
              <button className="secondary" type="button" disabled={locked || !availableTokens} onClick={() => void act('tejo/' + group.id + (round.flexible ? '/flex-benefits' : '/benefits'), {
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
  const pendingResults = group?.rounds.filter(isPending).length ?? 0;

  return (
    <section aria-labelledby="tejo-title">
      <div className="section-title"><h2 id="tejo-title">Tejo</h2><strong>{money.format(tejoProductValue)} por participante y chico</strong></div>
      {loadError && <p role="alert">{loadError} <button className="secondary" onClick={() => void load()}>Actualizar datos</button></p>}
      {!loadError && !overview && <p role="status">Cargando canchas…</p>}
      {overview && <>
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
            onStart={(playerCount, teamSize) => act('tejo', { courtType: type, courtNumber: court, playerCount, teamSize }, 'Cancha abierta.')} />
            : <>
              {!group.flexible && <p>{group.players.map((player) => player.name).join(' · ')}</p>}
              <p>{benefits.filter((benefit) => benefit.issuedAt).length} fichas entregadas ·{' '}
                {benefits.filter((benefit) => benefit.redemption).length} consumos · {pending} pendientes</p>
              <p>{overview.availableTokens === null
                ? 'Registra el conteo inicial en Caja para habilitar la entrega de fichas.'
                : <>Fichas disponibles en caja: <strong>{overview.availableTokens}</strong></>}</p>
              {group.flexible ? <RecordChicos key={group.id} group={group} locked={locked} act={act} accounts={accounts}
                availableTokens={overview.availableTokens} />
                : <RegisterRound key={group.id} group={group} locked={locked} act={act} availableTokens={overview.availableTokens} />}
              {redemption && redemption.groupId === group.id && <RedeemForm key={String(redemption.flexible) + ':' + redemption.roundId + ':' + redemption.player.accountId}
                entry={redemption} accounts={accounts} products={products} locked={locked} act={act} onCancel={() => setRedemption(null)} />}
              <RoundHistory group={group} locked={locked} act={act} availableTokens={overview.availableTokens}
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
    </section>
  );
}
