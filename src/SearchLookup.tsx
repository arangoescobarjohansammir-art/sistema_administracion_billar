import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';

type LookupOption = { id: number; name: string; detail?: string };
type LookupProps<Option> = {
  options: Option[];
  label: string;
  text: string;
  onTextChange: (text: string) => void;
  onChoose: (option: Option) => void;
  placeholder: string;
  listLabel: string;
  listPlaceholder: string;
  emptyMessage?: string;
  clearLabel?: string;
  validationMessage?: string;
  allowFreeText?: boolean;
  autoFocus?: boolean;
  keySearch?: boolean;
  required?: boolean;
  selectedId?: number;
  maxLength?: number;
};

export const normalizeSearch = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es')
  .trim().replace(/\s+/g, ' ');

export function SearchLookup<Option extends LookupOption>({
  options, label, text, onTextChange, onChoose, placeholder, listLabel, listPlaceholder, emptyMessage, clearLabel, validationMessage,
  allowFreeText, autoFocus, keySearch, required, selectedId, maxLength,
}: LookupProps<Option>) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const query = selectedId === undefined ? normalizeSearch(text) : '';
  const ordered = useMemo(() => [...options].sort((a, b) => a.name.localeCompare(b.name, 'es') || a.id - b.id)
    .map((option) => ({ option, name: normalizeSearch(option.name) })), [options]);
  const listSelection = selectedId ?? (allowFreeText ? ordered.find(({ name }) => query === name)?.option.id : undefined);
  const matches = open ? ordered
    .filter(({ name }) => name.includes(query))
    .sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query)))
    .map(({ option }) => option) : [];
  const activeIndex = matches.findIndex((option) => option.id === highlighted);
  const optionId = (option: LookupOption) => id + '-option-' + option.id;

  useEffect(() => {
    input.current?.setCustomValidity(validationMessage && selectedId === undefined && text.trim() ? validationMessage : '');
  }, [validationMessage, selectedId, text]);

  function close() {
    setOpen(false);
    setHighlighted(null);
  }

  function choose(option: Option) {
    onChoose(option);
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
      const option = matches[index];
      setHighlighted(option.id);
      document.getElementById(optionId(option))?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && (open || event.repeat || (keySearch && selectedId === undefined))) {
      const choice = matches[activeIndex] ?? (query && matches.length === 1 ? matches[0] : undefined);
      if (!matches.length && allowFreeText && !event.repeat) return;
      event.preventDefault();
      if (choice && !event.repeat) choose(choice);
    }
  }

  return <div className="search-lookup">
    <label htmlFor={id}>{label}</label>
    <select className="search-lookup-select" aria-label={listLabel} value={listSelection ?? ''} disabled={!options.length}
      onChange={(event) => {
        const value = event.currentTarget.value;
        const choice = options.find((option) => String(option.id) === value);
        if (choice) choose(choice);
        else if (!value) { onTextChange(''); close(); }
      }}>
      <option value="">{listPlaceholder}</option>
      {ordered.map(({ option }) => <option key={option.id} value={option.id}>
        {option.name}{option.detail ? ' · ' + option.detail : ''}
      </option>)}
    </select>
    <div className="search-lookup-field">
      <input ref={input} id={id} role="combobox" aria-autocomplete="list" aria-expanded={open && matches.length > 0}
        aria-controls={open && matches.length > 0 ? id + '-list' : undefined}
        aria-activedescendant={activeIndex >= 0 ? optionId(matches[activeIndex]) : undefined}
        autoComplete="off" placeholder={placeholder} maxLength={maxLength} required={required} autoFocus={autoFocus}
        data-search-lookup data-key-search={keySearch ? '' : undefined} value={text} onKeyDown={navigate} onBlur={close}
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
      {clearLabel && text && <button className="secondary" type="button" aria-label={clearLabel}
        onClick={() => { onTextChange(''); input.current?.focus(); close(); }}>Borrar</button>}
    </div>
    {open && (matches.length ? <ul className="search-lookup-options" id={id + '-list'} role="listbox" aria-label={label}>
      {matches.map((option) => <li id={optionId(option)} key={option.id} role="option"
        aria-selected={option.id === highlighted}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
        <span>{option.name}</span>{option.detail && <strong>{option.detail}</strong>}
      </li>)}
    </ul> : emptyMessage && <p className="search-lookup-options" role="status">{emptyMessage}</p>)}
  </div>;
}
