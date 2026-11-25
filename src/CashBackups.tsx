import { useEffect, useState } from 'react';
import type { BackupStatus, CashBackups as BackupOverview } from '../shared/backup';
import { api, message } from './Accounts';

const date = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota',
});
const labels: Record<BackupStatus['state'], string> = {
  pending: 'Por comprobar',
  checking: 'Verificando…',
  verified: 'Verificado',
  error: 'Requiere atención',
  unconfigured: 'Sin configurar',
};

function CopyStatus({ title, backup }: { title: string; backup: BackupStatus }) {
  return <div>
    <dt>{title}</dt>
    <dd className={backup.state === 'error' ? 'cash-error' : undefined}>{labels[backup.state]}</dd>
    {backup.copiedAt && <dd>Fecha de la copia <time dateTime={backup.copiedAt}>{date.format(new Date(backup.copiedAt))}</time></dd>}
    {backup.verifiedAt && <dd>Última verificación <time dateTime={backup.verifiedAt}>{date.format(new Date(backup.verifiedAt))}</time></dd>}
    {backup.state === 'unconfigured' && <dd>Configura una carpeta en otro disco para guardar la segunda copia.</dd>}
    {backup.state === 'error' && <dd>{backup.error} La caja volverá a intentarlo automáticamente.</dd>}
  </div>;
}

export function CashBackups({ refresh }: { refresh: number }) {
  const [backups, setBackups] = useState<BackupOverview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer: number;
    async function load() {
      try {
        const status = await api<BackupOverview>('cash/backups');
        if (!stopped) {
          setBackups(status);
          setError('');
        }
      } catch (error) {
        if (!stopped) setError(message(error));
      } finally {
        if (!stopped) timer = window.setTimeout(() => void load(), 5_000);
      }
    }
    void load();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [refresh]);
  return <section className="sale-panel cash-backups" aria-labelledby="cash-backups-title">
    <h3 id="cash-backups-title">Copias de seguridad</h3>
    {error ? <p role="alert">No se pudo consultar el estado. {error}</p> : !backups
      ? <p role="status">Consultando copias…</p>
      : <dl>
        <CopyStatus title="Copia local" backup={backups.local} />
        <CopyStatus title="Copia en otro disco" backup={backups.secondary} />
      </dl>}
  </section>;
}
