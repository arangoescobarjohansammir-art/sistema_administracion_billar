import { useState } from 'react';
import { label, money, type Product } from './Accounts';
import { normalizeSearch, SearchLookup } from './SearchLookup';

export function ProductCard({ product, action, onClick, disabled, selected }: {
  product: Product; action: string; onClick: () => void; disabled?: boolean; selected?: boolean;
}) {
  return <button type="button" className="sale-product" disabled={disabled} aria-pressed={selected}
    onClick={onClick} aria-label={action + ' ' + label(product) + ' por ' + money.format(product.price)}>
    <span className="sale-thumb" data-tint={product.id % 4}>
      {product.hasPhoto ? <img src={'/api/products/' + product.id + '/photo'} alt="" loading="lazy" />
        : <span aria-hidden="true">{product.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span>}
    </span>
    <span className="sale-product-name">{product.name}</span>
    <span className="secondary-text">{[product.brand, product.presentation].filter(Boolean).join(' · ')}</span>
    <b>{money.format(product.price)}</b>
  </button>;
}

export function ProductLookup({ products, selected, query, onQueryChange, onChoose, required, autoFocus }: {
  products: Product[]; selected?: Product; query: string;
  onQueryChange: (value: string) => void; onChoose: (product: Product) => void; required?: boolean; autoFocus?: boolean;
}) {
  const options = products.map((product) => ({ id: product.id, name: label(product), detail: money.format(product.price), product }));
  return <SearchLookup options={options} label="Buscar producto" text={selected ? label(selected) : query} selectedId={selected?.id}
    onTextChange={onQueryChange} onChoose={({ product }) => onChoose(product)} required={required} autoFocus={autoFocus} keySearch
    placeholder="Escribe el nombre, marca o presentación"
    clearLabel="Borrar búsqueda de producto"
    validationMessage={required ? 'Elige un producto de las sugerencias o de las tarjetas.' : undefined} />;
}

const previewCount = 12;

export function ConsumptionProducts({ products, query, action, onChoose, unavailable, selectedId }: {
  products: Product[]; query: string; action: string; onChoose: (product: Product) => void;
  unavailable?: (product: Product) => boolean; selectedId?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const search = normalizeSearch(query);
  const matches = products.filter((product) => normalizeSearch(label(product)).includes(search));
  const visible = expanded ? matches : matches.slice(0, previewCount);
  if (!products.length) return <p>Agrega existencias en Inventario para registrar consumos.</p>;
  if (!matches.length) return <p role="status">No se encontraron productos.</p>;
  return <div className="space-above">
    <div className="sale-products">
      {visible.map((product) => <ProductCard key={product.id} product={product} action={action}
        disabled={unavailable?.(product)} selected={selectedId === undefined ? undefined : product.id === selectedId}
        onClick={() => onChoose(product)} />)}
    </div>
    {!expanded && matches.length > visible.length && <button className="secondary space-above" type="button"
      onClick={() => setExpanded(true)}>Ver los {matches.length} productos</button>}
  </div>;
}
