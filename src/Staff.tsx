import { useEffect, useState, type FormEvent } from 'react';
import { auditLabels, type AuditEntry, type Operator } from '../shared/operators';
import { api, message, money, useOperation } from './Accounts';
import { AccountCorrections } from './AccountCorrections';
import { StaffPaymentCorrections } from './StaffPaymentCorrections';

const clock = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota' });
type Sale = {
  id: number; customer: string | null; total: number; createdAt: string;
  cash: number | null; transfer: number | null; tokens: number | null; voidedAt: string | null;
  redemptionTokens: number;
  voidReason: string | null; stockReturned: number | null; items: { productId: number; label: string; quantity: number }[];
  creditShares: { accountId: number; name: string; amount: number }[];
};
type CorrectionScope = 'sales' | 'redemptions';
type CorrectionPage = { shiftId: number | null; entries: Sale[] };

function Users() {
  const [users, setUsers] = useState<Operator[] | null>(null);
  const [resetId, setResetId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setUsers(await api<Operator[]>('operators')); }
    catch (error) { setError(message(error)); }
  }
  useEffect(() => { void load(); }, []);

  async function update(path: string, data: object, success: string) {
    if (busy) return false;
    setError('');
    setStatus('');
    setBusy(true);
    try {
      await api(path, data);
      await load();
      setStatus(success);
      return true;
    } catch (error) {
      setError(message(error));
      return false;
    } finally { setBusy(false); }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (await update('operators', values, 'Usuario de caja creado.')) form.reset();
  }

  return <div className="cash-layout">
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    <form onSubmit={add}>
      <h3>Crear usuario de caja</h3>
      <fieldset className="field-grid" disabled={busy}>
        <label>Nombre del cajero<input name="name" minLength={2} maxLength={80} required /></label>
        <label>Usuario<input name="username" pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,31}" autoCapitalize="none" spellCheck={false}
          title="Usa de 3 a 32 letras sin tildes, números, puntos o guiones." required /></label>
        <label>PIN de seis dígitos<input name="secret" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
          autoComplete="new-password" required /></label>
      </fieldset>
      <button disabled={busy}>Crear usuario</button>
    </form>
    <section>
      <h3>Usuarios registrados</h3>
      {!users && !error && <p role="status">Cargando usuarios…</p>}
      {users && <ul className="ledger-list">{users.map((user) => <li key={user.id}>
        <div className="row-between"><strong>{user.name}</strong><span>{user.username}</span></div>
        <p>{user.role === 'admin' ? 'Administrador' : user.active ? 'Cajero activo' : 'Cajero desactivado'}</p>
        {user.role === 'cashier' && <div className="actions">
          <button className="secondary" disabled={busy} onClick={() => setResetId(resetId === user.id ? null : user.id)}>
            {resetId === user.id ? 'Cancelar cambio de PIN' : 'Cambiar PIN'}
          </button>
          <button className="secondary" disabled={busy} onClick={() => void update('operators/' + user.id, { active: !user.active },
            user.active ? 'Usuario desactivado.' : 'Usuario activado.')}>{user.active ? 'Desactivar' : 'Activar'}</button>
        </div>}
        {resetId === user.id && <form onSubmit={async (event) => {
          event.preventDefault();
          const secret = new FormData(event.currentTarget).get('secret');
          if (await update('operators/' + user.id, { secret }, 'PIN actualizado.')) setResetId(null);
        }}>
          <label>Nuevo PIN de seis dígitos<input name="secret" type="password" inputMode="numeric" pattern="[0-9]{6}"
            maxLength={6} autoComplete="new-password" disabled={busy} required /></label>
          <button disabled={busy}>Guardar PIN</button>
        </form>}
      </li>)}</ul>}
    </section>
  </div>;
}

function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  async function load(before?: number) {
    setBusy(true);
    setError('');
    try {
      const next = await api<AuditEntry[]>('audit' + (before ? '?before=' + before : ''));
      setEntries((previous) => before ? [...(previous ?? []), ...next] : next);
      setMore(next.length === 50);
    } catch (error) {
      setError(message(error));
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  return <section>
    <div className="section-title"><h3>Registro de operaciones</h3>
      <button className="secondary" disabled={busy} onClick={() => void load()}>Actualizar registro</button></div>
    {error && <p role="alert">{error}</p>}
    {!entries && busy && <p role="status">Cargando registro…</p>}
    {entries?.length === 0 && <p>Todavía no hay operaciones registradas con usuario.</p>}
    {entries && <ul className="ledger-list">{entries.map((entry) => <li key={entry.id}>
      <div className="row-between"><strong>{auditLabels[entry.kind]} #{entry.targetId}</strong>
        <time dateTime={entry.createdAt}>{clock.format(new Date(entry.createdAt))}</time></div>
      <p>{entry.actorName}{entry.shiftId === null ? '' : ' · Turno #' + entry.shiftId}</p>
      {entry.reason && <p>{entry.reason}</p>}
    </li>)}</ul>}
    {more && <button className="secondary" disabled={busy} onClick={() => void load(entries?.at(-1)?.id)}>Cargar operaciones anteriores</button>}
  </section>;
}

function VoidForm({ sale, scope, onDone, onCancel }: { sale: Sale; scope: CorrectionScope; onDone: () => void; onCancel: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const write = useOperation();
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      await write('corrections/' + scope + '/' + sale.id + '/void', {
        reason: values.get('reason'), stockReturned: values.get('stockReturned') === 'yes', confirmed: values.has('confirmed'),
      });
      onDone();
    } catch (error) {
      setError(message(error));
    } finally { setBusy(false); }
  }
  return <form onSubmit={save} className="sale-correction">
    <h4>Anular {scope === 'sales' ? 'venta' : 'canje'} #{sale.id}</h4>
    <fieldset disabled={busy}>
      <label>Motivo de la anulación<textarea name="reason" maxLength={300} required rows={2} /></label>
      <label>¿Todos los productos volvieron al inventario?
        <select name="stockReturned" defaultValue="" required>
          <option value="" disabled>Selecciona una opción</option><option value="yes">Sí, todos volvieron</option>
          <option value="no">No, conservar la salida de inventario</option>
        </select>
      </label>
      <label className="inline-check"><input type="checkbox" name="confirmed" required />
        {scope === 'redemptions' ? 'Confirmo que las fichas y cualquier pago adicional se devolvieron o que nunca los recibí.'
          : sale.cash || sale.transfer || sale.tokens ? 'Confirmo que devolví el pago por el medio indicado o que el cobro no llegó a realizarse.'
          : sale.creditShares.length ? 'Confirmo que corresponde retirar el cargo de las cuentas indicadas.'
            : 'Confirmo que corresponde retirar este cargo de la cuenta.'}</label>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="actions">
      <button disabled={busy}>Confirmar anulación</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
    </div>
  </form>;
}

function Corrections({ scope }: { scope: CorrectionScope }) {
  const [data, setData] = useState<CorrectionPage | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const redemption = scope === 'redemptions';
  const name = redemption ? 'Canje' : 'Venta';
  async function load(before?: number) {
    setError('');
    setBusy(true);
    try {
      const response = await api<{ shiftId: number | null } & Record<CorrectionScope, Sale[]>>(
        'corrections/' + scope + (before ? '?before=' + before : ''));
      const result = { shiftId: response.shiftId, entries: response[scope] };
      setData((previous) => before && previous?.shiftId === result.shiftId
        ? { ...result, entries: [...previous.entries, ...result.entries] } : result);
      setMore(result.entries.length === 50);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  return <section>
    <div className="section-title"><h3>{redemption ? 'Anular canje de fichas' : 'Anular venta de productos'}</h3>
      <button className="secondary" disabled={busy} onClick={() => void load()}>Actualizar {redemption ? 'canjes' : 'ventas'}</button></div>
    <p>{redemption ? 'Canjes de fichas físicas registrados en Venta durante el turno abierto. Confirma qué se devolvió antes de anular.'
      : 'Ventas directas de productos del turno abierto. El sistema conserva la venta original y registra la corrección en el cuadre.'}</p>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {!data && busy && <p role="status">Consultando operaciones…</p>}
    {data?.entries.length === 0 && <p>{data.shiftId === null ? 'Abre un turno de caja para consultar sus operaciones.'
      : redemption ? 'Todavía no se han registrado canjes en este turno.' : 'Todavía no se han registrado ventas directas en este turno.'}</p>}
    {data && <ul className="ledger-list">{data.entries.map((sale) => <li key={sale.id}>
      <div className="row-between"><strong>{name} #{sale.id}{sale.voidedAt ? (redemption ? ' · Anulado' : ' · Anulada') : ''}</strong><strong>{money.format(sale.total)}</strong></div>
      <p>{sale.customer ?? 'Sin nombre'} · {clock.format(new Date(sale.createdAt))}</p>
      <p>{sale.items.map((item) => item.quantity + ' × ' + item.label).join(' · ')}</p>
      {sale.creditShares.map((part) => <p key={part.accountId}>{part.name} · Fiado: {money.format(part.amount)}</p>)}
      <p>Cobro registrado: {[
        sale.redemptionTokens ? sale.redemptionTokens + (sale.redemptionTokens === 1 ? ' ficha de canje' : ' fichas de canje') : '',
        sale.cash ? 'Efectivo ' + money.format(sale.cash) : '',
        sale.transfer ? 'Transferencia ' + money.format(sale.transfer) : '',
        sale.tokens ? sale.tokens + ' fichas' : '',
      ].filter(Boolean).join(' · ') || 'Sin pago registrado'}</p>
      {sale.voidedAt ? <p>Motivo: {sale.voidReason} · {sale.stockReturned ? 'Productos devueltos al inventario' : 'Sin devolución a inventario'}</p>
        : selected === sale.id ? <VoidForm key={sale.id} sale={sale} scope={scope} onCancel={() => setSelected(null)}
            onDone={() => { setSelected(null); setStatus(name + ' #' + sale.id + (redemption ? ' anulado.' : ' anulada.')); void load(); }} />
          : <button className="secondary" disabled={busy} onClick={() => { setSelected(sale.id); setStatus(''); }}>Anular {name.toLowerCase()} #{sale.id}</button>}
    </li>)}</ul>}
    {more && <button className="secondary" disabled={busy} onClick={() => void load(data?.entries.at(-1)?.id)}>Cargar operaciones anteriores</button>}
  </section>;
}

export function Staff() {
  const [section, setSection] = useState<'users' | 'audit' | 'sales' | 'redemptions' | 'payments' | 'tejo' | 'staff-payments'>('users');
  return <section aria-labelledby="staff-title">
    <h2 id="staff-title">Personal y correcciones</h2>
    <nav className="actions accounts-nav" aria-label="Administración de caja">
      <button className="navigation" aria-pressed={section === 'users'} onClick={() => setSection('users')}>Usuarios</button>
      <button className="navigation" aria-pressed={section === 'audit'} onClick={() => setSection('audit')}>Registro</button>
      <button className="navigation" aria-pressed={section === 'sales'} onClick={() => setSection('sales')}>Anular ventas</button>
      <button className="navigation" aria-pressed={section === 'redemptions'} onClick={() => setSection('redemptions')}>Anular canjes</button>
      <button className="navigation" aria-pressed={section === 'payments'} onClick={() => setSection('payments')}>Anular abonos</button>
      <button className="navigation" aria-pressed={section === 'tejo'} onClick={() => setSection('tejo')}>Corregir cargos de tejo</button>
      <button className="navigation" aria-pressed={section === 'staff-payments'} onClick={() => setSection('staff-payments')}>Corregir pagos al personal</button>
    </nav>
    {section === 'users' && <Users />}
    {section === 'audit' && <AuditLog />}
    {(section === 'sales' || section === 'redemptions') && <Corrections key={section} scope={section} />}
    {(section === 'payments' || section === 'tejo') && <AccountCorrections key={section} mode={section} />}
    {section === 'staff-payments' && <StaffPaymentCorrections />}
  </section>;
}
