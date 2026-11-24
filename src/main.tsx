import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Catalog } from './Catalog';
import { Accounts, api } from './Accounts';
import { Billiards } from './Billiards';
import { Tejo } from './Tejo';
import { Cash } from './Cash';
import { QuickSale } from './QuickSale';
import { useCajaKeyboard } from './keyboard';
import './style.css';

type LocalNote = { text: string; updatedAt: string | null };

async function getNote(options?: RequestInit): Promise<LocalNote> {
  const response = await fetch('/api/local-note', options);
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

function App() {
  const [section, setSection] = useState<typeof modules[number][0] | null>(null);
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
          <div className="app-brand"><span className="app-mark" aria-hidden="true">TB</span>
            <div><h1>Tejo &amp; Billar</h1><p>Punto de venta</p></div></div>
          <div className="app-session">
            <AppClock />
            <span className="app-shift" data-open={cashOpen === true}>
              {cashOpen === null ? 'Caja local' : cashOpen ? 'Caja abierta' : 'Caja cerrada'}
            </span>
          </div>
        </div>
        <nav className="actions app-nav" data-main-nav aria-label="Secciones de caja">
          {modules.map(([id, name]) => <button key={id} type="button" className="navigation"
            aria-pressed={section === id} onClick={() => setSection(id)}>{name}</button>)}
        </nav>
      </header>
      <main>
        {section === null && <p role="status">Cargando caja…</p>}
        <div hidden={section !== 'sale'}>
          <QuickSale active={section === 'sale'} cashOpen={cashOpen} onCash={() => setSection('cash')} />
        </div>
        {section === 'catalog' && <Catalog />}
        {section === 'accounts' && <Accounts />}
        {section === 'billiards' && <Billiards />}
        {section === 'tejo' && <Tejo />}
        {section === 'cash' && <Cash onShiftChange={setCashOpen} />}
        {section === 'note' && <LocalNoteForm />}
      </main>
      <footer className="app-keys" aria-label="Atajos de teclado">
        <span><kbd>↑ ↓ ← →</kbd> Moverse</span><span><kbd>Enter</kbd> Elegir</span>
        <span><kbd>Tab</kbd> Cambiar de campo</span><span><kbd>Esc</kbd> Volver del cobro</span>
        {section === 'sale' && <><span><kbd>F2</kbd> Buscar</span><span><kbd>F4</kbd> Cobrar</span></>}
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
