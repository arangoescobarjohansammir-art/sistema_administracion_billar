import { createClient, type Session } from '@supabase/supabase-js';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { adminSnapshotId, alertPeriodStart, clubDay, clubTimeZone, dashboardRefreshMs, syncWarningMs,
  type AdminSnapshot, type RegisterSummary } from '../shared/admin';
import { billiardTables } from '../shared/billiard';
import { courtLabel, tejoCourtsPerType } from '../shared/tejo';
import { demoSnapshot } from './demo';
import { PurchaseFund } from './PurchaseFund';
import clubIcon from '../shared/brand/club-icon.png';
import './style.css';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const supabase = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url ?? '') && key?.startsWith('sb_publishable_')
  ? createClient(url, key) : null;
const isDemo = new URLSearchParams(location.search).get('demo') === '1';
const today = () => clubDay(new Date());
const currency = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0, useGrouping: true });
const dateTime = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: clubTimeZone });
const shortDay = new Intl.DateTimeFormat('es-CO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: clubTimeZone });
const dayLabel = (day: string) => shortDay.format(new Date(day + 'T12:00:00Z'));
const money = (value: number | null) => value === null ? '—' : currency.format(value);
const formatTime = (value: string) => dateTime.format(new Date(value));
const count = (value: number | null) => value === null ? '—' : String(value);

type CloudSnapshot = { payload: AdminSnapshot; synced_at: string };
type Tab = 'Alertas' | 'Ventas' | 'Caja' | 'Juegos' | 'Inventario';
const tabs: Tab[] = ['Alertas', 'Ventas', 'Caja', 'Juegos', 'Inventario'];

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return <div className="stat"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Brand() {
  return <div className="brand"><img className="mark" src={clubIcon} width={48} height={48} alt="" />
    <div><p>Club de Tejo Patio Bonito</p><h1>Administración</h1></div>
  </div>;
}

function Sales({ data }: { data: AdminSnapshot }) {
  const [chosenDay, setChosenDay] = useState('');
  const availableDay = data.daily.find((row) => row.day === chosenDay);
  const selected = availableDay ?? data.daily.at(-1);
  const chart = data.daily.slice(-7);
  const peak = Math.max(1, ...chart.map((row) => row.sales));
  if (!selected) return <p className="panel">Todavía no hay ventas sincronizadas.</p>;
  return <>
    <section className="panel">
      <div className="section-title"><h2>Ventas por día</h2>
        <label>Día <select value={selected.day} onChange={(event) => setChosenDay(event.target.value)}>
          {[...data.daily].reverse().map(({ day }) => <option key={day} value={day}>
            {day === today() ? 'Hoy · ' : ''}{dayLabel(day)}
          </option>)}
        </select></label>
      </div>
      <dl className="stats">
        <Stat label="Ventas y cargos">{money(selected.sales)}</Stat>
        <Stat label="Operaciones registradas">{selected.transactions}</Stat>
        <Stat label="Efectivo recibido">{money(selected.cash)}</Stat>
        <Stat label="Transferencias recibidas">{money(selected.transfer)}</Stat>
        <Stat label="Valor pagado con fichas">{money(selected.tokenAmount)} <small>({selected.tokens})</small></Stat>
        <Stat label="Saldo pendiente total">{money(data.pendingBalance)}</Stat>
      </dl>
      <p className="muted">Los cobros del día incluyen abonos a cuentas anteriores. El saldo pendiente reúne todas las cuentas.</p>
    </section>
    <section className="panel">
      <h2>Últimos 7 días registrados</h2>
      <ul className="sales-chart">
        {chart.map((row) => <li key={row.day}>
          <button className="chart-row" aria-pressed={row.day === selected.day} onClick={() => setChosenDay(row.day)}>
            <span>{dayLabel(row.day)}</span><span className="track" aria-hidden="true">
              <span style={{ width: (row.sales / peak * 100) + '%' }} />
            </span><strong>{money(row.sales)}</strong>
          </button>
        </li>)}
      </ul>
    </section>
    <section className="panel">
      <h2>Cuentas pendientes</h2>
      {data.openBalances.length ? <ul className="rows">{data.openBalances.map((account) => <li key={account.id}>
        <span>{account.name}</span><strong>{money(account.balance)}</strong>
      </li>)}</ul> : <p className="muted">No hay cuentas con saldo pendiente.</p>}
    </section>
  </>;
}

function difference(value: number | null, format: (amount: number) => string) {
  if (value === null) return 'Sin conteo';
  if (value === 0) return 'Cuadrado';
  return (value < 0 ? 'Faltan ' : 'Sobran ') + format(Math.abs(value));
}

function closureDifferences(shift: RegisterSummary) {
  const amounts = [
    { label: 'Caja de ventas', value: shift.salesDifference, format: money },
    { label: 'Fondo para compras', value: shift.purchasesDifference, format: money },
    { label: 'Transferencias', value: shift.transferDifference, format: money },
    { label: 'Fichas', value: shift.tokenDifference, format: count },
  ];
  return amounts.filter(({ value }) => value !== null && value !== 0);
}

function Alerts({ data, openClosure, openInventory }: {
  data: AdminSnapshot; openClosure: (id: number) => void; openInventory: () => void;
}) {
  const start = alertPeriodStart(data.day).getTime();
  const recentClosures = data.closures.flatMap((shift) => {
    const discrepancies = closureDifferences(shift);
    return shift.closedAt && Date.parse(shift.closedAt) >= start && discrepancies.length
      ? [{ ...shift, closedAt: shift.closedAt, discrepancies }] : [];
  });
  const withdrawals = data.unexpectedWithdrawals;
  const soldOut = data.inventory.filter((item) => item.stock <= 0);

  return <div className="alert-panels">
    <section className="panel">
      <div className="section-title"><h2>Cierres con diferencias</h2>
        <span className="alert-total">{recentClosures.length}</span></div>
      {recentClosures.length === 0 ? <p className="muted">Sin diferencias en los últimos 7 días registrados.</p> :
        <ul className="alert-list">{recentClosures.map((shift) => <li key={shift.id}>
          <strong>Turno #{shift.id}</strong>
          <small>{formatTime(shift.closedAt)} · {shift.cashier}</small>
          <ul className="alert-differences">{shift.discrepancies.map(({ label, value, format }) => (
            <li key={label}><span>{label}</span><strong className="warning">{difference(value, format)}</strong></li>
          ))}</ul>
          {shift.closingNote && <p>{shift.closingNote}</p>}
          <button type="button" onClick={() => openClosure(shift.id)}>Ver cierre #{shift.id}</button>
        </li>)}</ul>}
    </section>
    <section className="panel">
      <div className="section-title"><h2>Retiros imprevistos</h2>
        {withdrawals && <span className="alert-total">{withdrawals.length}</span>}</div>
      {withdrawals === undefined ? <p className="muted">Aún no se han sincronizado los datos de retiros.</p>
        : withdrawals.length === 0 ? <p className="muted">Sin retiros imprevistos en los últimos 7 días registrados.</p>
        : <ul className="alert-list">{withdrawals.map((entry) => <li key={entry.id}>
          <div className="alert-line"><strong>{entry.kind === 'sales_expense' ? 'Compra o gasto imprevisto' : 'Retiro de ventas'}</strong>
            <strong>{money(entry.amount)}</strong></div>
          <small>{formatTime(entry.createdAt)} · Turno #{entry.shiftId}</small>
          <p><strong>{entry.category}</strong> · {entry.reason}</p>
        </li>)}</ul>}
    </section>
    <section className="panel">
      <div className="section-title"><h2>Productos agotados</h2><span className="alert-total">{soldOut.length}</span></div>
      {data.inventory.length === 0 ? <p className="muted">Aún no hay productos activos en el inventario.</p>
        : soldOut.length === 0 ? <p className="muted">Todos los productos activos tienen existencias.</p>
        : <>
          <ul className="alert-list">{soldOut.map((item) => <li key={item.id}>
            <strong>{item.name}</strong>
            {(item.brand || item.presentation) && <small>{[item.brand, item.presentation].filter(Boolean).join(' · ')}</small>}
          </li>)}</ul>
          <button type="button" onClick={openInventory}>Ver inventario</button>
        </>}
    </section>
  </div>;
}

function Register({ shift }: { shift: RegisterSummary }) {
  return <dl className="stats">
    <Stat label="Ventas del turno">{money(shift.salesTotal)}</Stat>
    <Stat label="Efectivo recibido">{money(shift.cashReceived)}</Stat>
    <Stat label="Transferencias del turno">{money(shift.transferExpected)}</Stat>
    <Stat label="Efectivo esperado en ventas">{money(shift.salesExpected)}</Stat>
    <Stat label="Fondo de compras esperado">{money(shift.purchasesExpected)}</Stat>
    <Stat label="Fichas esperadas">{count(shift.expectedTokens)}</Stat>
    {shift.closedAt && <>
      <Stat label="Cuadre de caja de ventas">{difference(shift.salesDifference, money)}</Stat>
      <Stat label="Cuadre del fondo de compras">{difference(shift.purchasesDifference, money)}</Stat>
      <Stat label="Cuadre de transferencias">{difference(shift.transferDifference, money)}</Stat>
      <Stat label="Cuadre de fichas">{difference(shift.tokenDifference, count)}</Stat>
      <Stat label="Ventas entregadas">{money(shift.salesDelivery)}</Stat>
      <Stat label="Base para próximo turno">{money(shift.nextBase)}</Stat>
    </>}
  </dl>;
}

function Cash({ data, focusShift, funding }: { data: AdminSnapshot; focusShift: number | null; funding?: ReactNode }) {
  useEffect(() => {
    if (focusShift !== null) document.querySelector<HTMLElement>('#closure-' + focusShift + ' summary')?.focus();
  }, [focusShift]);
  return <>
    <section className="panel">
      <h2>Caja {data.active ? 'abierta' : 'cerrada'}</h2>
      {data.active ? <>
        <p className="muted">Turno #{data.active.id} · {data.active.cashier}<br />Abrió {formatTime(data.active.openedAt)}</p>
        <Register shift={data.active} />
      </> : <p className="muted">No hay un turno abierto en la última sincronización.</p>}
    </section>
    {funding}
    <section className="panel">
      <h2>Historial de cierres</h2>
      {data.closures.length === 0 && <p className="muted">Aún no hay cierres registrados.</p>}
      {data.closures.map((shift) => <details key={shift.id} id={'closure-' + shift.id} open={shift.id === focusShift}>
        <summary>Turno #{shift.id} · {formatTime(shift.closedAt!)}</summary>
        <p className="muted">{shift.cashier} · Abrió {formatTime(shift.openedAt)}</p>
        <Register shift={shift} />
        {shift.closingNote && <p className="muted"><strong>Observación del cierre</strong><br />{shift.closingNote}</p>}
      </details>)}
    </section>
  </>;
}

function Games({ data }: { data: AdminSnapshot }) {
  const { billiard, tejo } = data.play;
  return <>
    <section className="panel">
      <h2>Billar <span className="muted">{billiard.length}/{billiardTables} ocupadas</span></h2>
      {billiard.length ? <ul className="rows">{billiard.map((item) => <li key={item.table}>
        <span>Mesa {item.table}</span><strong>{item.paused ? 'Tiempo detenido' : 'En juego'}</strong>
      </li>)}</ul> : <p className="muted">Todas las mesas están libres.</p>}
    </section>
    <section className="panel">
      <h2>Tejo <span className="muted">{tejo.length}/{tejoCourtsPerType * 2} ocupadas</span></h2>
      {tejo.length ? <ul className="rows">{tejo.map((item) => <li key={item.type + item.court}>
        <span>{courtLabel(item.type, item.court)}</span><strong>{item.rounds} {item.rounds === 1 ? 'chico' : 'chicos'}</strong>
      </li>)}</ul> : <p className="muted">Todas las canchas están libres.</p>}
    </section>
  </>;
}

function Inventory({ data }: { data: AdminSnapshot }) {
  const [query, setQuery] = useState('');
  const items = data.inventory.filter((item) => [item.name, item.brand, item.presentation].join(' ')
    .toLocaleLowerCase('es').includes(query.trim().toLocaleLowerCase('es')));
  return <section className="panel">
    <div className="section-title"><h2>Inventario</h2>
      <label>Buscar <input type="search" value={query} placeholder="Nombre o marca"
        onChange={(event) => setQuery(event.target.value)} /></label>
    </div>
    {items.length ? <ul className="rows">{items.map((item) => <li key={item.id}>
      <span><strong>{item.name}</strong><small>{[item.brand, item.presentation].filter(Boolean).join(' · ')}</small></span>
      <strong className={item.stock <= 0 ? 'warning' : ''}>{item.stock} {item.stock === 1 ? 'unidad' : 'unidades'}</strong>
    </li>)}</ul> : <p className="muted">{query ? 'No se encontraron productos.' : 'Aún no hay productos registrados.'}</p>}
  </section>;
}

function Dashboard({ data, updatedAt, funding }: { data: AdminSnapshot; updatedAt?: string; funding?: ReactNode }) {
  const [tab, setTab] = useState<Tab>('Alertas');
  const [focusShift, setFocusShift] = useState<number | null>(null);
  const [time, setTime] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setTime(Date.now());
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const stale = updatedAt && time - Date.parse(updatedAt) >= syncWarningMs;
  return <>
    {updatedAt && <div className={stale ? 'status sync-late' : 'status'} role="status">
      {stale && <strong>Sincronización atrasada</strong>}
      <span>Última sincronización: {formatTime(updatedAt)}</span>
    </div>}
    <nav aria-label="Secciones de administración">
      {tabs.map((item) => <button key={item} aria-pressed={tab === item} onClick={() => { setFocusShift(null); setTab(item); }}>{item}</button>)}
    </nav>
    {tab === 'Alertas' && <Alerts data={data} openClosure={(id) => { setFocusShift(id); setTab('Caja'); }}
      openInventory={() => setTab('Inventario')} />}
    {tab === 'Ventas' && <Sales data={data} />}
    {tab === 'Caja' && <Cash data={data} focusShift={focusShift} funding={funding} />}
    {tab === 'Juegos' && <Games data={data} />}
    {tab === 'Inventario' && <Inventory data={data} />}
  </>;
}

function Login() {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setWorking(true);
    setError('');
    try {
      const { error } = await supabase!.auth.signInWithPassword({
        email: String(fields.get('email')).trim(), password: String(fields.get('password')),
      });
      if (error) setError('No se pudo iniciar sesión. Revisa tu correo, contraseña y conexión.');
    } catch {
      setError('No se pudo conectar. Intenta de nuevo.');
    } finally {
      setWorking(false);
    }
  }

  return <section className="panel login">
    <h2>Iniciar sesión</h2>
    {supabase ? <form onSubmit={signIn}>
      <label>Correo electrónico<input type="email" name="email" autoComplete="username" required /></label>
      <label>Contraseña<input type="password" name="password" autoComplete="current-password" required /></label>
      {error && <p className="warning" role="alert">{error}</p>}
      <button className="primary" type="submit" disabled={working}>{working ? 'Ingresando…' : 'Ingresar'}</button>
    </form> : <p className="muted">Este panel aún necesita conexión con el proyecto Supabase del club.</p>}
    <a href="?demo=1">Ver demostración</a>
  </section>;
}

function SyncedDashboard({ session }: { session: Session }) {
  const [snapshot, setSnapshot] = useState<CloudSnapshot | null>(null);
  const [status, setStatus] = useState('Consultando la caja…');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const allowed = session.user.app_metadata.caja_admin === true;
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    let timer: number;
    async function load() {
      setBusy(true);
      try {
        const { data, error } = await supabase!.from('admin_snapshots').select('payload,synced_at')
          .eq('id', adminSnapshotId).abortSignal(controller.signal).maybeSingle<CloudSnapshot>();
        if (controller.signal.aborted) return;
        if (error) {
          if (error.code === '42501' || error.code === 'PGRST301') setSnapshot(null);
          setStatus('No se pudo consultar. Verifica tu conexión o vuelve a iniciar sesión.');
        } else if (!data) {
          setSnapshot(null);
          setStatus('Esperando la primera sincronización del computador de caja.');
        } else if (data.payload.version !== 1) {
          setSnapshot(null);
          setStatus('Actualiza el panel para consultar los datos.');
        } else {
          setSnapshot(data);
          setStatus('');
        }
      } catch {
        if (!controller.signal.aborted) setStatus('Conexión interrumpida. Se volverá a intentar.');
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
          timer = window.setTimeout(() => void load(), dashboardRefreshMs);
        }
      }
    }
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [session.access_token, allowed, refresh]);

  if (!allowed) return <p className="panel warning" role="alert">Esta cuenta no tiene acceso al panel del club.</p>;
  return <>
    <div className="refresh"><button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
      {busy ? 'Consultando…' : 'Actualizar'}
    </button></div>
    {status && <p className="status" role="status">{status}</p>}
    {snapshot && <Dashboard data={snapshot.payload} updatedAt={snapshot.synced_at}
      funding={<PurchaseFund client={supabase!} requester={session.user.id} shift={snapshot.payload.active} ready={snapshot.payload.purchaseFundingEnabled === true}
        formatMoney={money} formatTime={formatTime} refresh={refresh} />} />}
  </>;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(isDemo || !supabase);
  const [signOutError, setSignOutError] = useState(false);
  const [example] = useState(() => isDemo
    ? { data: demoSnapshot(), updatedAt: new Date(Date.now() - 7 * 60_000).toISOString() } : null);
  useEffect(() => {
    if (!supabase || isDemo) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, current) => {
      setSession(current);
      setReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);
  async function signOut() {
    setSignOutError(false);
    try {
      const { error } = await supabase!.auth.signOut({ scope: 'local' });
      if (error) setSignOutError(true);
    } catch {
      setSignOutError(true);
    }
  }

  return <main className="shell">
    <header><Brand />
      {example && <a href="?">Salir de demo</a>}
      {!example && session && <button onClick={() => void signOut()}>Cerrar sesión</button>}
    </header>
    {signOutError && <p className="status warning" role="alert">No se pudo cerrar la sesión. Intenta de nuevo.</p>}
    {example ? <>
      <p className="status demo">Demostración · Datos ficticios</p>
      <Dashboard data={example.data} updatedAt={example.updatedAt} />
    </> : !ready ? <p role="status">Verificando sesión…</p> : session
      ? <SyncedDashboard key={session.user.id} session={session} /> : <Login />}
  </main>;
}

createRoot(document.getElementById('admin-root')!).render(<App />);
