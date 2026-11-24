import { useState } from 'react';
import { cashChange, cashDenominations } from '../shared/tender';
import { money } from './Accounts';

export function CashChangeField({ due, received, onChange }: {
  due: number; received: string; onChange: (value: string) => void;
}) {
  const change = cashChange(due, received);
  return <div className="sale-tender">
    <label>Efectivo que entrega el cliente (opcional)
      <input type="number" min={0} step={1} inputMode="numeric" value={received} placeholder="Ej. 20.000"
        onChange={(event) => onChange(event.target.value)} />
    </label>
    <div className="row-between"><span>{change !== null && change < 0 ? 'Falta en efectivo' : 'Devuelto'}</span>
      <strong aria-live="polite">{change === null ? '—' : money.format(Math.abs(change))}</strong></div>
  </div>;
}

export function BillCounter({ disabled, targets }: {
  disabled: boolean; targets: { label: string; use: (total: string) => void }[];
}) {
  const [counts, setCounts] = useState<Record<number, string>>({});
  const total = cashDenominations.reduce((sum, value) => sum + value * Number(counts[value] || 0), 0);
  return <details className="bill-counter">
    <summary>Calculadora de billetes y monedas</summary>
    <fieldset className="plain-fieldset" disabled={disabled}>
      <div className="bill-count-grid">{cashDenominations.map((value) => <label key={value}>
        {money.format(value)}<input aria-label={'Cantidad de ' + money.format(value)} type="number" min={0} max={10000} step={1}
          inputMode="numeric" value={counts[value] ?? ''} placeholder="0" onChange={(event) => {
            const input = event.target.value;
            if (input === '' || (/^\d+$/.test(input) && Number(input) <= 10000)) {
              setCounts((previous) => ({ ...previous, [value]: input }));
            }
          }} />
      </label>)}</div>
      <p>Total contado: <strong aria-live="polite">{money.format(total)}</strong></p>
      <div className="actions">
        {targets.map((target) => <button key={target.label} type="button" className="secondary" onClick={() => target.use(String(total))}>{target.label}</button>)}
        <button className="secondary" type="button" onClick={() => setCounts({})}>Limpiar conteo</button>
      </div>
    </fieldset>
  </details>;
}
