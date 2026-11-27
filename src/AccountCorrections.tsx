import { useEffect, useState, type FormEvent } from 'react';
import { courtLabel, type TejoType } from '../shared/tejo';
import { AccountPicker } from './CustomerLookup';
import { api, message, money, PaymentBreakdown, totalPayment, useOperation, type Account, type Payment } from './Accounts';

type PaymentEntry = Omit<Payment, 'saleId'> & { customer: string; voidedAt: string | null; voidReason: string | null };
type ChargeEntry = {
  id: number; accountId: number; customer: string; total: number; createdAt: string;
  hasPayment: 0 | 1;
} & (
  { chico: number; courtType: TejoType; courtNumber: number } |
  { tableNumber: number; sessionId: number }
);
type Entry = PaymentEntry | ChargeEntry;
type Mode = 'payments' | 'tejo' | 'billiards';
const descriptions = {
  payments: { title: 'Anular abonos', help: 'Anula un abono del turno abierto. Si corresponde, después puedes registrar el abono correcto en Cuentas.' },
  tejo: { title: 'Corregir cargos de tejo', help: 'Traslada un cargo de tejo del turno abierto a la cuenta correcta.' },
  billiards: { title: 'Corregir cargos de billar', help: 'Traslada una parte fiada de una mesa liquidada en el turno abierto a la cuenta correcta.' },
};
type Page = { shiftId: number | null; entries: Entry[] };
const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'America/Bogota' });
const isPayment = (entry: Entry): entry is PaymentEntry => 'cash' in entry;

function CorrectionForm({ mode, entry, accounts, onDone, onCancel }: {
  mode: Mode; entry: Entry; accounts: Account[]; onDone: (status: string) => void; onCancel: () => void;
}) {
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const write = useOperation();
  const payment = isPayment(entry);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (!payment && !account)) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await write('corrections/' + mode + '/' + entry.id + (payment ? '/void' : '/move'), {
        reason: fields.get('reason'), confirmed: fields.has('confirmed'), accountId: payment ? undefined : Number(account),
      }, mode === 'billiards' ? 'Traslado de cargo de billar #' + entry.id : undefined);
      onDone(payment ? 'Abono #' + entry.id + ' anulado.' : 'Cargo trasladado a la cuenta correcta. Nuevo cargo #' + result.id + '.');
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  return <form onSubmit={save} className="sale-correction">
    <h4>{payment ? 'Anular abono #' : 'Cambiar cuenta del cargo #'}{entry.id}</h4>
    <fieldset className="plain-fieldset" disabled={busy}>
      {!payment && <AccountPicker accounts={accounts.filter((item) => item.id !== entry.accountId)}
        label="Cuenta correcta" value={account} required onChange={setAccount} />}
      <label>Motivo<textarea name="reason" maxLength={300} required rows={2} /></label>
      <label className="inline-check"><input type="checkbox" name="confirmed" required />
        {payment ? 'Confirmo que devolví el pago por el medio indicado o que el abono no se recibió.'
          : 'Confirmo que el cargo debe quedar a nombre del cliente seleccionado.'}</label>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="actions">
      <button disabled={busy || (!payment && !account)}>{payment ? 'Confirmar anulación' : 'Confirmar traslado'}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
    </div>
  </form>;
}

export function AccountCorrections({ mode }: { mode: Mode }) {
  const [page, setPage] = useState<Page | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const { title, help } = descriptions[mode];

  async function load(before?: number) {
    setBusy(true);
    setError('');
    try {
      const [result, people] = await Promise.all([
        api<Page>('corrections/' + mode + (before ? '?before=' + before : '')),
        mode !== 'payments' && !before ? api<Account[]>('accounts') : Promise.resolve(null),
      ]);
      setPage((previous) => before && previous?.shiftId === result.shiftId
        ? { ...result, entries: [...previous.entries, ...result.entries] } : result);
      setMore(result.entries.length === 50);
      if (people) setAccounts(people);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return <section aria-labelledby="account-correction-title">
    <div className="section-title"><h3 id="account-correction-title">{title}</h3>
      <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>Actualizar</button></div>
    <p>{help}</p>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {!page && busy && <p role="status">Consultando movimientos…</p>}
    {page?.entries.length === 0 && <p>{page.shiftId === null ? 'Abre un turno de caja para ver los movimientos.'
      : 'No hay movimientos para corregir en este turno.'}</p>}
    {page && <ul className="ledger-list">{page.entries.map((entry) => {
      const payment = isPayment(entry);
      const action = payment ? 'Anular abono #' : 'Cambiar cuenta del cargo #';
      return <li key={entry.id}>
        <div className="row-between"><strong>{payment ? 'Abono #' : 'Cargo #'}{entry.id} · {entry.customer}
          {payment && entry.voidedAt ? ' · Anulado' : ''}</strong>
          <strong>{money.format(payment ? totalPayment(entry, entry.tokenValue) : entry.total)}</strong></div>
        <time dateTime={entry.createdAt}>{date.format(new Date(entry.createdAt))}</time>
        {payment ? <p><PaymentBreakdown payment={{ ...entry, saleId: null }} /></p>
          : 'tableNumber' in entry ? <p>Mesa {entry.tableNumber} · Liquidación #{entry.sessionId}</p>
          : <p>{courtLabel(entry.courtType, entry.courtNumber)} · chico {entry.chico}</p>}
        {payment && entry.voidedAt ? <p>Anulado el {date.format(new Date(entry.voidedAt))} · {entry.voidReason}</p>
          : !payment && entry.hasPayment ? <p>Este cargo tiene un cobro asociado.</p>
          : selected === entry.id ? <CorrectionForm key={entry.id} mode={mode} entry={entry} accounts={accounts}
            onCancel={() => setSelected(null)} onDone={(notice) => {
              setSelected(null); setStatus(notice); void load();
            }} />
          : <button type="button" className="secondary space-above" disabled={busy}
            onClick={() => { setSelected(entry.id); setStatus(''); }}>{action}{entry.id}</button>}
      </li>;
    })}</ul>}
    {more && <button type="button" className="secondary" disabled={busy}
      onClick={() => void load(page?.entries.at(-1)?.id)}>Cargar movimientos anteriores</button>}
  </section>;
}
