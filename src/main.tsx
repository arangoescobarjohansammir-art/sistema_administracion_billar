import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Catalog } from './Catalog';
import { Accounts } from './Accounts';
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

function App() {
  const [section, setSection] = useState<'catalog' | 'accounts' | 'note'>('catalog');

  return (
    <main>
      <header>
        <p>Caja local</p>
        <h1>Tejo y billar</h1>
        <nav className="actions" aria-label="Secciones de caja">
          <button className="navigation" aria-pressed={section === 'catalog'} onClick={() => setSection('catalog')}>Inventario</button>
          <button className="navigation" aria-pressed={section === 'accounts'} onClick={() => setSection('accounts')}>Ventas y cuentas</button>
          <button className="navigation" aria-pressed={section === 'note'} onClick={() => setSection('note')}>Nota de caja</button>
        </nav>
      </header>
      {section === 'catalog' && <Catalog />}
      {section === 'accounts' && <Accounts />}
      {section === 'note' && <LocalNoteForm />}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
