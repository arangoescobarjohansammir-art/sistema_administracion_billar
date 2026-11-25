import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Catalog } from './Catalog';
import { Accounts, api } from './Accounts';
import { Billiards } from './Billiards';
import { Tejo } from './Tejo';
import { Cash } from './Cash';
import { QuickSale } from './QuickSale';
import { Access, type CashSession } from './Access';
import { Staff } from './Staff';
import type { Operator } from '../shared/operators';
import clubIcon from '../shared/brand/club-icon.png';
import { useCajaKeyboard } from './keyboard';
import './style.css';

type LocalNote = { text: string; updatedAt: string | null };

async function getNote(options?: RequestInit): Promise<LocalNote> {
  const response = await fetch('/api/local-note', options);
  if (response.status === 401) window.dispatchEvent(new Event('cash-session-required'));
  if (!response.ok) throw new Error('No se pudo completar la operación.');
  return response.json() as Promise<LocalNote>;
}

function LocalNoteForm() {
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<LocalNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const note = await getNote();
      setDraft(note.text);
      setSaved(note);
    } catch {
      setError('No se pudo cargar la nota. Verifica que la caja local esté iniciada.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !saved) return;
    setSaving(true);
    setError('');
    try {
      const note = await getNote({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: draft }),
      });
      setSaved(note);
      setDraft(note.text);
    } catch {
      setError('No se guardó la nota. Puedes volver a intentarlo.');
    } finally {
      setSaving(false);
    }
  }

  let status = 'Todavía no hay una nota guardada.';
  if (loading) status = 'Cargando nota…';
  else if (!saved) status = 'Sin acceso a la nota.';
  else if (draft.trim() !== saved.text) status = 'Hay cambios sin guardar.';
  else if (saved.updatedAt) status = 'Guardada en este computador.';

  return (
      <form onSubmit={save}>
        <h2>Nota de caja</h2>
        <label htmlFor="note">Observación</label>
        <textarea id="note" rows={5} value={draft} maxLength={500}
          disabled={!saved || loading || saving}
          onChange={(event) => setDraft(event.target.value)} />
        <p role="status">{status}</p>
        {error && <p role="alert">{error}</p>}
        {saved
          ? <button type="submit" disabled={saving || draft.trim() === saved.text}>
              {saving ? 'Guardando…' : 'Guardar nota'}
            </button>
          : <button type="button" disabled={loading} onClick={() => void load()}>Volver a cargar</button>}
      </form>
  );
}

const modules = [
  ['sale', 'Venta'], ['billiards', 'Billar'], ['tejo', 'Tejo'], ['accounts', 'Cuentas'],
  ['catalog', 'Inventario'], ['cash', 'Caja'], ['note', 'Nota de caja'],
] as const;
type Section = typeof modules[number][0] | 'staff';

const localDate = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeZone: 'America/Bogota' });
const localClock = new Intl.DateTimeFormat('es-CO', { timeStyle: 'medium', timeZone: 'America/Bogota' });

function AppClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  return <time className="app-clock" aria-label="Fecha y hora, Colombia" dateTime={now.toISOString()}>
    <span>{localDate.format(now)}</span><strong>{localClock.format(now)}</strong>
  </time>;
}

function App({ operator, onLogout }: { operator: Operator; onLogout: () => void }) {
  const [section, setSection] = useState<Section | null>(null);
  const [cashOpen, setCashOpen] = useState<boolean | null>(null);
  const header = useRef<HTMLElement>(null);
  useCajaKeyboard();
  useEffect(() => {
    void api<{ active: unknown }>('cash').then((cash) => {
      setCashOpen(Boolean(cash.active));
      setSection((previous) => previous ?? (cash.active ? 'sale' : 'cash'));
    }).catch(() => setSection((previous) => previous ?? 'cash'));
  }, []);
  useEffect(() => {
    const element = header.current;
    const app = element?.parentElement;
    if (!element || !app) return;
    const measure = () => app.style.setProperty('--header-size', element.offsetHeight + 'px');
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div id="caja-app">
      <header className="app-header" ref={header}>
        <div className="app-header-inner">
          <div className="app-brand"><img className="app-mark" src={clubIcon} width={48} height={48} alt="" />
            <div><h1>Club de Tejo Patio Bonito</h1><p>Punto de venta</p></div></div>
          <div className="app-session">
            <AppClock />
            <span className="app-shift" data-open={cashOpen === true}>
              {cashOpen === null ? 'Caja local' : cashOpen ? 'Caja abierta' : 'Caja cerrada'}
            </span>
            <span className="operator-name" title={operator.name}>{operator.name}</span>
            <button className="secondary" type="button" onClick={onLogout}>Cerrar sesión</button>
          </div>
        </div>
        <nav className="actions app-nav" data-main-nav aria-label="Secciones de caja">
          {modules.map(([id, name]) => <button key={id} type="button" className="navigation"
            aria-pressed={section === id} onClick={() => setSection(id)}>{name}</button>)}
          {operator.role === 'admin' && <button type="button" className="navigation" aria-pressed={section === 'staff'}
            onClick={() => setSection('staff')}>Personal</button>}
        </nav>
      </header>
      <main>
        {section === null && <p role="status">Cargando caja…</p>}
        <div hidden={section !== 'sale'}>
          <QuickSale active={section === 'sale'} cashOpen={cashOpen} onCash={() => setSection('cash')} />
        </div>
        {section === 'catalog' && <Catalog isAdmin={operator.role === 'admin'} />}
        {section === 'accounts' && <Accounts />}
        {section === 'billiards' && <Billiards />}
        {section === 'tejo' && <Tejo />}
        {section === 'cash' && <Cash operatorName={operator.name} onShiftChange={setCashOpen} />}
        {section === 'note' && <LocalNoteForm />}
        {section === 'staff' && operator.role === 'admin' && <Staff />}
      </main>
      <footer className="app-keys" aria-label="Atajos de teclado">
        <span><kbd>↑ ↓ ← →</kbd> Moverse</span><span><kbd>Enter</kbd> Elegir</span>
        <span><kbd>Tab</kbd> Cambiar de campo</span><span><kbd>Esc</kbd> Volver del cobro</span>
        {section === 'sale' && <><span><kbd>F2</kbd> Buscar</span><span><kbd>F4</kbd> Cobrar</span></>}
      </footer>
    </div>
  );
}

function Root() {
  const [session, setSession] = useState<CashSession | null>(null);
  const [error, setError] = useState('');
  const sessionChannel = useRef<BroadcastChannel | null>(null);

  async function load() {
    setError('');
    try { setSession(await api<CashSession>('session')); }
    catch { setError('No se pudo consultar la sesión. Verifica que la caja local esté iniciada.'); }
  }

  useEffect(() => {
    void load();
    const onExpired = () => setSession({ setupNeeded: false, operator: null });
    window.addEventListener('cash-session-required', onExpired);
    const channel = new BroadcastChannel('cash-session');
    sessionChannel.current = channel;
    channel.onmessage = () => { void load(); };
    return () => {
      window.removeEventListener('cash-session-required', onExpired);
      channel.close();
      sessionChannel.current = null;
    };
  }, []);

  function changeSession(value: CashSession) {
    setSession(value);
    sessionChannel.current?.postMessage(null);
  }

  async function logOut() {
    try { changeSession(await api<CashSession>('session/logout', {})); setError(''); }
    catch { setError('No se pudo cerrar la sesión. Vuelve a intentarlo.'); }
  }

  if (session?.operator) return <>
    {error && <p className="cash-error" role="alert">{error}</p>}
    <App key={session.operator.id} operator={session.operator} onLogout={() => void logOut()} />
  </>;
  if (session) return <Access key={String(session.setupNeeded)} session={session} onChange={changeSession} />;
  return <main>{error ? <p role="alert">{error} <button className="secondary" onClick={() => void load()}>Reintentar</button></p>
    : <p role="status">Verificando sesión…</p>}</main>;
}

createRoot(document.getElementById('root')!).render(<Root />);
