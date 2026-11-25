import { useState } from 'react';
import type { Account } from './Accounts';
import { SearchLookup } from './SearchLookup';

export function CustomerLookup({ accounts, label, text, onTextChange, onChoose, required, selectedId, mustChoose }: {
  accounts: Account[]; label: string; text: string; onTextChange: (text: string) => void; onChoose: (account: Account) => void;
  required?: boolean; selectedId?: number; mustChoose?: boolean;
}) {
  return <SearchLookup options={accounts} label={label} text={text} onTextChange={onTextChange} onChoose={onChoose}
    selectedId={selectedId} required={required} maxLength={100} allowFreeText={!mustChoose}
    placeholder="Escribe un nombre o apodo" emptyMessage="No hay clientes que coincidan."
    listLabel={'Lista de clientes · ' + label} listPlaceholder="Elegir cliente de la lista"
    clearLabel={mustChoose ? 'Borrar cliente' : undefined}
    validationMessage={mustChoose ? 'Elige una cuenta de las sugerencias o borra el nombre.' : undefined} />;
}

export function AccountPicker({ accounts, label, value, onChange, required }: {
  accounts: Account[]; label: string; value: string; onChange: (value: string) => void; required?: boolean;
}) {
  const [query, setQuery] = useState('');
  const selected = accounts.find((account) => String(account.id) === value);
  return <CustomerLookup accounts={accounts} label={label} text={selected?.name ?? query}
    selectedId={selected?.id} mustChoose required={required}
    onTextChange={(text) => { setQuery(text); if (value) onChange(''); }}
    onChoose={(account) => { setQuery(''); onChange(String(account.id)); }} />;
}
