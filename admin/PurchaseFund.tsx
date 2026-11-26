import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { dashboardRefreshMs, type PurchaseFunding, type PurchaseFundingResult, type RegisterSummary } from '../shared/admin';
import { maxPurchaseFunding } from '../shared/cash';

type Entry = PurchaseFunding & (PurchaseFundingResult | { status: 'pending'; movement_id: null; result_note: string });
type Draft = Pick<PurchaseFunding, 'id' | 'shift_id' | 'shift_opened_at' | 'amount' | 'note'>;
const statusLabel = { pending: 'Pendiente de sincronizar', applied: 'Aplicado en caja', rejected: 'Rechazado por la caja' };

export function PurchaseFund({ client, requester, shift, ready, formatMoney, formatTime, refresh }: {
  client: SupabaseClient; requester: string; shift: RegisterSummary | null; ready: boolean;
  formatMoney: (amount: number) => string; formatTime: (date: string) => string; refresh: number;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const draftKey = 'patio-bonito.purchase-funding.' + requester;
  const [draft, setDraft] = useState<Draft | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(draftKey) ?? 'null') as Draft | null;
    } catch {
      return null;
    }
  });
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  function remember(item: Draft | null) {
    setDraft(item);
    try {
      if (item) sessionStorage.setItem(draftKey, JSON.stringify(item));
      else sessionStorage.removeItem(draftKey);
    } catch {
      // The current view can still retry the request when browser storage is unavailable.
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    async function load() {
      try {
        const { data, error } = await client.from('purchase_funding').select('*')
          .order('created_at', { ascending: false }).limit(30).abortSignal(controller.signal);
        if (controller.signal.aborted) return;
        if (error) throw error;
        setEntries(data as Entry[]);
        setLoaded(true);
        setLoadError(false);
      } catch {
        if (!controller.signal.aborted) setLoadError(true);
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void load(), dashboardRefreshMs);
      }
    }
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [client, refresh]);

  useEffect(() => {
    if (draft && entries.some(({ id }) => id === draft.id)) {
      remember(null);
      formRef.current?.reset();
      setError('');
      setStatus('Aporte registrado.');
    }
  }, [draft, entries]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || (!draft && (!shift || !ready || !loaded || loadError))) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const amount = Number(fields.get('amount'));
    if (!draft && (!Number.isSafeInteger(amount) || amount < 1 || amount > maxPurchaseFunding || !fields.has('confirmed'))) return;
    const item = draft ?? { id: crypto.randomUUID(), shift_id: shift!.id, shift_opened_at: shift!.openedAt,
      amount, note: String(fields.get('note') ?? '').trim() };
    remember(item);
    setSaving(true);
    setError('');
    setStatus('');
    try {
      // Check for a previous receipt before resending, since its shift may have closed in the meantime.
      let entry: Entry | null = null;
      if (draft) {
        const previous = await client.from('purchase_funding').select('*').eq('id', item.id).maybeSingle<Entry>();
        if (previous.error) throw previous.error;
        entry = previous.data;
      }
      if (!entry) {
        const result = await client.from('purchase_funding').insert(item).select().single<Entry>();
        if (result.error?.code === '42501') {
          remember(null);
          setError('La caja cambió de turno o tu sesión perdió el acceso. Actualiza el panel antes de enviar el aporte.');
          return;
        }
        if (result.error) throw result.error;
        entry = result.data;
      }
      setEntries((list) => [entry, ...list.filter(({ id }) => id !== entry.id)].slice(0, 30));
      remember(null);
      form.reset();
      setStatus('Aporte registrado. El estado se actualiza cuando el computador de caja lo procesa.');
    } catch {
      setError('No pudimos confirmar el envío. Reintenta el mismo aporte para comprobar si quedó registrado.');
    } finally {
      setSaving(false);
    }
  }

  return <section className="panel purchase-fund">
    <h2>Fondo para compras</h2>
    {shift && ready && <p className="muted">Turno #{shift.id} · {shift.cashier}. El aporte se sumará al fondo cuando la caja se sincronice.</p>}
    {!ready ? <p className="muted">El computador de caja debe sincronizarse con la versión actualizada para recibir aportes.</p>
      : !shift && <p className="muted">Abre un turno en el computador de caja para enviar un aporte.</p>}
    {loadError && <p className="warning" role="alert">No se pudieron consultar los aportes. Actualiza el panel y revisa la conexión.</p>}
    {(draft || (shift && ready)) && <form onSubmit={save} ref={formRef}>
      <fieldset disabled={saving || Boolean(draft)}>
        <label>Efectivo que dejaste para compras (COP)<input name="amount" type="number" inputMode="numeric" min={1} max={maxPurchaseFunding} step={1} required /></label>
        <label>Nota (opcional)<input name="note" maxLength={300} placeholder="Ej. Pedido de cerveza" /></label>
        <label className="funding-confirm"><input type="checkbox" name="confirmed" required />Confirmo que entregué este efectivo para compras.</label>
      </fieldset>
      {draft && <p>Aporte por confirmar · {formatMoney(draft.amount)} · turno #{draft.shift_id}</p>}
      <button className="primary" disabled={saving || (!draft && (!loaded || loadError))}>
        {saving ? 'Enviando…' : draft ? 'Reintentar el mismo aporte' : 'Enviar aporte a caja'}
      </button>
    </form>}
    {error && <p className="warning" role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {entries.length > 0 && <details open>
      <summary>Aportes recientes</summary>
      <ul className="rows">{entries.map((entry) => <li key={entry.id}>
        <div><strong>{formatMoney(entry.amount)} · turno #{entry.shift_id}</strong>
          <small>{formatTime(entry.created_at)}{entry.note ? ' · ' + entry.note : ''}</small>
          {entry.result_note && <small className="warning">{entry.result_note}</small>}
        </div><strong>{statusLabel[entry.status]}</strong>
      </li>)}</ul>
    </details>}
  </section>;
}
