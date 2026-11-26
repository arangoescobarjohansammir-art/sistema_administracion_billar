import { useEffect, useState, type FormEvent } from 'react';
import { api, message, money, useOperation } from './Accounts';

type Payment = {
  id: number; employee: string; reason: string; originalAmount: number; amount: number; createdAt: string;
  correctedAt: string | null; correctionReason: string | null; compensationId: number | null;
};
type Entry = { id: number; category: string; amount: number; reason: string; createdAt: string };
type Page = { shiftId: number | null; payments: Payment[]; compensations: Entry[] };
const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' });
const timestamp = (value: string) => date.format(new Date(value));
const path = 'corrections/staff-payments';

function CorrectionForm({ payment, compensations, onCancel, onSaved }: {
  payment: Payment; compensations: Entry[]; onCancel: () => void; onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [compensation, setCompensation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const write = useOperation();
  const real = Number(amount);
  const valid = amount !== '' && Number.isInteger(real) && real >= 0 && real <= 1_000_000_000 && real !== payment.originalAmount;
  const difference = payment.originalAmount - real;
  const matching = valid ? compensations.filter((entry) => entry.id > payment.id && entry.amount === difference) : [];
  const compensationDecided = matching.length === 0 || compensation !== '';
  const linked = compensation !== '' && compensation !== 'none';

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !valid || !compensationDecided) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await write(path + '/' + payment.id + '/adjust', {
        amount: real, compensationId: linked ? Number(compensation) : null,
        reason: fields.get('reason'), confirmed: fields.has('confirmed'),
      });
      onSaved();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  return <form className="sale-correction" onSubmit={save}>
    <h4>Corregir pago #{payment.id}</h4>
    <fieldset disabled={busy}>
      <label>Importe pagado realmente (COP)<input type="number" min={0} max={1_000_000_000} step={1}
        value={amount} onChange={(event) => { setAmount(event.target.value); setCompensation(''); }} required /></label>
      <p>Si nunca se entregó el pago, escribe 0.</p>
      {matching.length > 0 && <label>Entrada usada para compensar el error
        <select required value={compensation} onChange={(event) => setCompensation(event.target.value)}>
          <option value="" disabled>Elige cómo se compensó</option>
          <option value="none">Sin entrada compensatoria</option>
          {matching.map((entry) => <option key={entry.id} value={entry.id}>
            #{entry.id} · {money.format(entry.amount)} · {timestamp(entry.createdAt)} · {entry.category} · {entry.reason}
          </option>)}
        </select>
      </label>}
      {valid && compensationDecided && <p>El efectivo esperado en caja {linked ? 'queda igual.'
        : difference > 0 ? 'aumenta en ' + money.format(difference) + '.' : 'disminuye en ' + money.format(-difference) + '.'}</p>}
      <label>Motivo de la corrección<textarea name="reason" maxLength={300} rows={2} required /></label>
      <label className="inline-check"><input name="confirmed" type="checkbox" required />
        {linked ? 'Confirmo el importe pagado y que esta entrada se registró para compensar el error.'
          : 'Confirmo que este es el importe realmente pagado.'}</label>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="actions">
      <button disabled={busy || !valid || !compensationDecided}>Guardar corrección</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
    </div>
  </form>;
}

export function StaffPaymentCorrections() {
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setError('');
    setBusy(true);
    try { setPage(await api<Page>(path)); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  useEffect(() => { void load(); }, []);

  return <section>
    <div className="section-title"><h3>Corregir pagos al personal</h3>
      <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>Actualizar pagos</button>
    </div>
    <p>Elige un pago del turno abierto. Si ya registraste una entrada para compensar el error, vincúlala a la corrección.</p>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {!page && busy && <p role="status">Consultando pagos…</p>}
    {page?.payments.length === 0 && <p>{page.shiftId === null ? 'Abre un turno para consultar sus pagos.' : 'Todavía no hay pagos al personal en el turno.'}</p>}
    {page && <ul className="ledger-list">{page.payments.map((payment) => <li key={payment.id}>
      <div className="row-between"><strong>Pago #{payment.id} · {payment.employee}{payment.correctedAt ? ' · Corregido' : ''}</strong>
        <strong>{money.format(payment.amount)}</strong></div>
      <p>{timestamp(payment.createdAt)} · {payment.reason}</p>
      {payment.correctedAt ? <p>Original {money.format(payment.originalAmount)} · {payment.correctionReason}
        {payment.compensationId ? ' · Entrada vinculada #' + payment.compensationId : ''}</p>
        : selected === payment.id ? <CorrectionForm payment={payment} compensations={page.compensations} onCancel={() => setSelected(null)}
          onSaved={() => { setSelected(null); setStatus('Pago #' + payment.id + ' corregido.'); void load(); }} />
        : <button type="button" className="secondary" disabled={busy} onClick={() => { setSelected(payment.id); setStatus(''); }}>
          Corregir pago #{payment.id}</button>}
    </li>)}</ul>}
  </section>;
}
