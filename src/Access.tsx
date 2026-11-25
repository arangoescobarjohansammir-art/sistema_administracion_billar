import { useState, type FormEvent } from 'react';
import type { Operator } from '../shared/operators';
import { api, message } from './Accounts';

export type CashSession = { setupNeeded: boolean; setupCodeRequired?: boolean; operator: Operator | null };

export function Access({ session, onChange }: { session: CashSession; onChange: (value: CashSession) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { setupNeeded, setupCodeRequired } = session;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const secret = fields.get('secret');
    setError('');
    if (setupNeeded && secret !== fields.get('confirmation')) {
      setError('Las contraseñas deben coincidir.');
      return;
    }
    setBusy(true);
    try {
      const values = { username: fields.get('username'), secret };
      onChange(await api<CashSession>(setupNeeded ? 'session/setup' : 'session/login', setupNeeded
        ? { ...values, name: fields.get('name'), setupCode: fields.get('setupCode') } : values));
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  return <main className="access-page">
    <form onSubmit={submit} className="access-card">
      <p>Club de Tejo Patio Bonito</p>
      <h1>{setupNeeded ? 'Configurar acceso a la caja' : 'Iniciar sesión en caja'}</h1>
      {setupNeeded && <p>Crea la cuenta local del administrador. Después podrás dar un PIN a cada cajero.</p>}
      <fieldset className="field-grid" disabled={busy}>
        {setupNeeded && <label>Nombre del administrador<input name="name" minLength={2} maxLength={80} autoComplete="name" required /></label>}
        <label>Usuario<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={32} required
          pattern={setupNeeded ? '[A-Za-z0-9][A-Za-z0-9._\\-]{2,31}' : undefined}
          title={setupNeeded ? 'Usa letras sin tildes, números, punto, guion o guion bajo.' : undefined} /></label>
        <label>{setupNeeded ? 'Contraseña del administrador' : 'Contraseña o PIN'}<input name="secret" type="password"
          autoComplete={setupNeeded ? 'new-password' : 'current-password'} minLength={setupNeeded ? 10 : undefined}
          maxLength={100} required /></label>
        {setupNeeded && <label>Repetir contraseña<input name="confirmation" type="password" minLength={10} maxLength={100}
          autoComplete="new-password" required /></label>}
        {setupCodeRequired && <label>Código de configuración<input name="setupCode" type="password" autoComplete="off" required /></label>}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy}>{busy ? 'Verificando…' : setupNeeded ? 'Crear cuenta de administrador' : 'Ingresar'}</button>
    </form>
  </main>;
}
