import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { accountingMoney, accountingDate } from '../shared/accounting-tables';
import { cashMovements, type CashMovementKind } from '../shared/cash';
import type { Operator } from '../shared/operators';
import { api, ApiError, message } from './api';

const journalKey = 'caja.operacion.v1';
type Draft = {
  requestId: string; path: string; data: object; username: string; createdAt: string; label: string;
};
type Receipt = { status: 'missing' | 'saved' | 'discarded'; id: number | null };
type Write = (path: string, data: object, label?: string) => Promise<{ id: number }>;
type Recovery = { draft: Draft | null; storageError: boolean };
const Operation = createContext<Write | null>(null);
const operationAreas: Record<string, string> = {
  cash: 'caja', billiards: 'billar', tejo: 'tejo', corrections: 'corrección', 'inventory-counts': 'conteo de inventario',
};

function currentDraft(): Draft | null {
  const raw = localStorage.getItem(journalKey);
  return raw === null ? null : JSON.parse(raw) as Draft;
}

function changeDraft(update: (current: Draft | null) => Draft | null) {
  const write = () => {
    const current = currentDraft();
    const next = update(current);
    if (next === null) localStorage.removeItem(journalKey);
    else if (next !== current) localStorage.setItem(journalKey, JSON.stringify(next));
    return next;
  };
  return navigator.locks ? navigator.locks.request(journalKey, write) : Promise.resolve().then(write);
}

const receiptPath = (draft: Draft) => 'operations/' + draft.requestId;
const send = (draft: Draft) => api<{ id: number }>(draft.path, { ...draft.data, requestId: draft.requestId });
const clear = (draft: Draft) => changeDraft((current) => current?.requestId === draft.requestId ? null : current);

function operationLabel(path: string, data: Record<string, unknown>, label?: string) {
  if (path.endsWith('/movements') && typeof data.kind === 'string' && Object.hasOwn(cashMovements, data.kind)) {
    return cashMovements[data.kind as CashMovementKind].label + ' · ' + accountingMoney(Number(data.amount));
  }
  if (path.startsWith('tejo/') && path.endsWith('/record')) return 'Registro de chico · Grupo #' + path.split('/')[1];
  return label ?? 'Operación de ' + (operationAreas[path.split('/')[0]] ?? 'caja');
}

function ReviewOperation({ draft, operator, onFinished, onLogout }: {
  draft: Draft; operator: Operator; onFinished: () => void; onLogout: () => void;
}) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const running = useRef(false);
  const sameOperator = draft.username === operator.username;

  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { setError(message(failure)); }
    finally { running.current = false; setBusy(false); }
  }

  async function verify() {
    setReceipt(await api<Receipt>(receiptPath(draft)));
  }

  useEffect(() => {
    heading.current?.focus();
    void run(verify);
  }, [draft.requestId]);

  async function retry() {
    const checked = await api<Receipt>(receiptPath(draft));
    if (checked.status !== 'missing') { setReceipt(checked); return; }
    const result = await send(draft);
    setReceipt({ status: 'saved', id: result.id });
  }

  return <main>
    <section className="sale-tender" aria-label="Recuperación de caja">
      <h2 ref={heading} tabIndex={-1}>Operación por confirmar</h2>
      <p><strong>{draft.label}</strong> · {accountingDate(draft.createdAt)}</p>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Consultando la caja…</p>}
      {receipt?.status === 'saved' && <p role="status"><strong>La caja ya guardó esta operación.</strong> Referencia #{receipt.id}.</p>}
      {receipt?.status === 'discarded' && <p role="status">La operación se descartó sin registrarse.</p>}
      {receipt?.status === 'missing' && <p>La caja todavía no encuentra esta operación. Puedes reenviar los mismos datos o descartarla si ya verificaste lo ocurrido.</p>}
      {receipt?.status === 'missing' && !sameOperator && <p>Inicia sesión como {draft.username} para reenviarla.</p>}
      <div className="actions">
        {receipt && receipt.status !== 'missing'
          ? <button type="button" disabled={busy} onClick={() => void run(async () => { await clear(draft); onFinished(); })}>Continuar a caja</button>
          : <>
            <button type="button" className="secondary" disabled={busy} onClick={() => void run(verify)}>Verificar si se guardó</button>
            {receipt?.status === 'missing' && sameOperator && <button type="button" disabled={busy}
              onClick={() => void run(retry)}>Reintentar la misma operación</button>}
            {receipt?.status === 'missing' && (sameOperator || operator.role === 'admin') && <button type="button" className="secondary" disabled={busy}
              onClick={() => void run(async () => setReceipt(await api<Receipt>(receiptPath(draft), {})))}>Descartar si sigue sin guardarse</button>}
          </>}
        <button type="button" className="secondary" disabled={busy} onClick={onLogout}>Cerrar sesión</button>
      </div>
    </section>
  </main>;
}

function readRecovery(): Recovery {
  try { return { draft: currentDraft(), storageError: false }; }
  catch { return { draft: null, storageError: true }; }
}

export function OperationRecovery({ operator, onLogout, children }: {
  operator: Operator; onLogout: () => void; children: ReactNode;
}) {
  const [recovery, setRecovery] = useState(readRecovery);
  const refresh = () => setRecovery(readRecovery());
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === journalKey || event.key === null) refresh();
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);

  const write: Write = async (path, data, label) => {
    const draft = { requestId: crypto.randomUUID(), path, data, username: operator.username,
      createdAt: new Date().toISOString(), label: operationLabel(path, data as Record<string, unknown>, label) };
    let reserved: Draft | null;
    try { reserved = await changeDraft((current) => current ?? draft); }
    catch { throw new Error('El navegador no pudo guardar la operación antes de enviarla. Revisa el almacenamiento del navegador.'); }
    if (reserved?.requestId !== draft.requestId) {
      refresh();
      throw new Error('Revisa la operación pendiente antes de registrar otra.');
    }
    try {
      const result = await send(draft);
      await clear(draft);
      return result;
    } catch (failure) {
      if (failure instanceof ApiError && [400, 403, 404, 405, 409, 413].includes(failure.status)) {
        // Mark a rejected request as discarded before reopening the form. A delayed retry must not apply it.
        try {
          const receipt = await api<Receipt>(receiptPath(draft), {});
          if (receipt.status === 'discarded') await clear(draft);
        } catch {
          // Keep the operation for recovery when the server cannot confirm the discard.
        }
      }
      refresh();
      throw failure;
    }
  };

  if (recovery.storageError) return <main><p role="alert">El navegador no pudo leer la operación pendiente.</p>
    <button type="button" onClick={refresh}>Volver a comprobar</button></main>;
  if (recovery.draft) return <ReviewOperation key={recovery.draft.requestId} draft={recovery.draft} operator={operator}
    onFinished={refresh} onLogout={onLogout} />;
  return <Operation.Provider value={write}>{children}</Operation.Provider>;
}

export function useOperation(): Write {
  const write = useContext(Operation);
  if (!write) throw new Error('La recuperación de operaciones de caja no está disponible.');
  return write;
}
