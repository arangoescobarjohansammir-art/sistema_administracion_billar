import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Account } from './Accounts';

type NameLookupProps = {
  accounts: Account[];
  label: string;
  text: string;
  onTextChange: (text: string) => void;
  onChoose: (account: Account) => void;
  required?: boolean;
  selectedId?: number;
  mustChoose?: boolean;
};

const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es')
  .trim().replace(/\s+/g, ' ');

export function CustomerLookup({ accounts, label, text, onTextChange, onChoose, required, selectedId, mustChoose }: NameLookupProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const query = selectedId === undefined ? normalize(text) : '';
  const matches = open ? accounts.map((account) => ({ account, name: normalize(account.name) }))
    .filter(({ name }) => name.includes(query))
    .sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query)) ||
      a.account.name.localeCompare(b.account.name, 'es') || a.account.id - b.account.id)
    .map(({ account }) => account) : [];
  const activeIndex = matches.findIndex((account) => account.id === highlighted);
  const optionId = (accountId: number) => id + '-customer-' + accountId;

  useEffect(() => {
    input.current?.setCustomValidity(mustChoose && selectedId === undefined && text.trim()
      ? 'Elige una cuenta de las sugerencias o borra el nombre.' : '');
  }, [mustChoose, selectedId, text]);

  function close() {
    setOpen(false);
    setHighlighted(null);
  }

  function choose(account: Account) {
    onChoose(account);
    close();
  }

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (!matches.length) return;
      const index = event.key === 'ArrowDown' ? Math.min(activeIndex + 1, matches.length - 1)
        : activeIndex < 0 ? matches.length - 1 : Math.max(activeIndex - 1, 0);
      const account = matches[index];
      setHighlighted(account.id);
      document.getElementById(optionId(account.id))?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && (open || event.repeat)) {
      const choice = matches[activeIndex] ?? (query && matches.length === 1 ? matches[0] : undefined);
      if (!matches.length && !mustChoose && !event.repeat) return;
      event.preventDefault();
      if (choice && !event.repeat) choose(choice);
    }
  }

  return <div className="customer-lookup">
    <label htmlFor={id}>{label}</label>
    <div className="customer-lookup-field">
      <input ref={input} id={id} role="combobox" aria-autocomplete="list" aria-expanded={open && matches.length > 0}
        aria-controls={open && matches.length > 0 ? id + '-list' : undefined}
        aria-activedescendant={activeIndex >= 0 ? optionId(matches[activeIndex].id) : undefined}
        autoComplete="off" placeholder="Escribe un nombre o apodo" maxLength={100} required={required}
        data-customer-lookup value={text} onKeyDown={navigate} onBlur={close}
        onFocus={(event) => {
          if (selectedId !== undefined) event.currentTarget.select();
          else if (text.trim()) setOpen(true);
        }}
        onChange={(event) => {
          const value = event.target.value;
          onTextChange(value);
          setHighlighted(null);
          setOpen(Boolean(value.trim()));
        }} />
      {mustChoose && text && <button className="secondary" type="button" aria-label="Borrar cliente"
        onClick={() => { onTextChange(''); input.current?.focus(); close(); }}>Borrar</button>}
    </div>
    {open && (matches.length ? <ul className="customer-lookup-options" id={id + '-list'} role="listbox" aria-label={label}>
      {matches.map((account) => <li id={optionId(account.id)} key={account.id} role="option"
        aria-selected={account.id === highlighted}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(account)}>{account.name}</li>)}
    </ul> : <p className="customer-lookup-options" role="status">No hay clientes que coincidan.</p>)}
  </div>;
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
