import { useEffect, useState, type FormEvent } from 'react';
import { inventoryCountLimit, inventoryUnitLimit, type CountProduct, type InventoryCount, type InventoryCountSummary } from '../shared/inventory-counts';
import { api, message, useOperation } from './Accounts';

const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota' });
const searchText = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const productName = (product: CountProduct) => [product.name, product.brand, product.presentation].filter(Boolean).join(' · ');
const formatDate = (value: string) => date.format(new Date(value));

function NewCount({ onSaved }: { onSaved: (id: number) => void }) {
  const [products, setProducts] = useState<CountProduct[] | null>(null);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const write = useOperation();

  async function load() {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const next = await api<CountProduct[]>('inventory-counts/products');
      if (products) {
        const previous = new Map(products.map((item) => [item.id, item.version]));
        const unchanged = new Set(next.filter((item) => previous.get(item.id) === item.version).map((item) => item.id));
        const kept = Object.fromEntries(Object.entries(counts).filter(([id]) => unchanged.has(Number(id))));
        if (Object.keys(kept).length !== Object.keys(counts).length) {
          setStatus('Se quitaron las cantidades de los productos que cambiaron. Cuenta esos productos de nuevo.');
        }
        setCounts(kept);
      }
      setProducts(next);
    } catch (error) {
      setError(message(error));
    } finally { setBusy(false); }
  }

  useEffect(() => { void load(); }, []);

  const lines = Object.keys(counts).length;
  const shown = products?.filter((item) => searchText(productName(item)).includes(searchText(query.trim())));
  function edit(id: number, value: string) {
    setCounts((previous) => {
      const next = { ...previous };
      if (value === '') delete next[id];
      else next[id] = value;
      return next;
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !products || lines < 1 || lines > inventoryCountLimit) return;
    const note = new FormData(event.currentTarget).get('note');
    const items = products.filter((item) => Object.hasOwn(counts, item.id))
      .map((item) => ({ productId: item.id, version: item.version, counted: Number(counts[item.id]) }));
    if (items.some((item) => !Number.isSafeInteger(item.counted) || item.counted < 0 || item.counted > inventoryUnitLimit)) {
      setError('Revisa las cantidades. Deben ser números enteros de 0 a 1.000.000.');
      return;
    }
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await write('inventory-counts', { items, note });
      onSaved(result.id);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  return <form onSubmit={save}>
    <div className="section-title"><h3>Registrar conteo físico</h3>
      <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>Actualizar productos</button>
    </div>
    <p>Busca los productos que quieras contar. Ingresa unidades de venta y deja en blanco los productos que no vas a revisar.</p>
    <label>Buscar para el conteo<input type="search" value={query} placeholder="Nombre, marca o presentación"
      onChange={(event) => setQuery(event.target.value)} /></label>
    {status && <p role="status">{status}</p>}
    {!products && busy && <p role="status">Cargando productos…</p>}
    {shown?.length === 0 && <p>{products?.length === 0 ? 'Agrega un producto activo para comenzar.' : 'No hay productos con esa búsqueda.'}</p>}
    {shown && shown.length > 0 && <ul className="ledger-list inventory-count-inputs">{shown.map((item) => (
      <li key={item.id} className="row-between">
        <div><strong>{productName(item)}</strong>
          {item.packageName && <small>{item.packageName} de {item.unitsPerPackage} unidades</small>}
        </div>
        <input type="number" inputMode="numeric" min={0} max={inventoryUnitLimit} step={1}
          aria-label={'Cantidad contada de ' + productName(item)} value={counts[item.id] ?? ''}
          disabled={busy} onChange={(event) => edit(item.id, event.target.value)} />
      </li>
    ))}</ul>}
    <label>Nota del conteo (opcional)<input name="note" maxLength={300} disabled={busy} /></label>
    <p aria-live="polite">{lines} {lines === 1 ? 'producto contado' : 'productos contados'}</p>
    {lines > inventoryCountLimit && <p role="alert">Puedes registrar hasta {inventoryCountLimit} productos por conteo.</p>}
    {error && <p role="alert">{error}</p>}
    <button disabled={busy || lines < 1 || lines > inventoryCountLimit}>Guardar y comparar</button>
  </form>;
}

function CountDetail({ count, isAdmin, reload }: {
  count: InventoryCount; isAdmin: boolean; reload: () => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const write = useOperation();
  const changed = count.items.some((row) => row.changed);

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || changed || count.adjustedAt) return;
    const note = new FormData(event.currentTarget).get('note');
    setError('');
    setBusy(true);
    try {
      await write('inventory-counts/' + count.id + '/apply', { note });
      await reload();
    } catch (error) {
      setError(message(error));
      await reload();
    } finally { setBusy(false); }
  }

  return <section>
    <h3>Conteo #{count.id}</h3>
    <p>{count.countedBy} · {formatDate(count.createdAt)}</p>
    {count.note && <p>Nota: {count.note}</p>}
    <div className="cash-reconciliation"><table>
      <thead><tr><th scope="col">Producto</th><th scope="col">Esperadas</th><th scope="col">Contadas</th><th scope="col">Diferencia</th></tr></thead>
      <tbody>{count.items.map((row) => {
        const difference = row.counted - row.expected;
        return <tr key={row.productId}>
          <th scope="row">{row.label}{row.changed && <small className="inventory-count-changed">Inventario actualizado después del conteo</small>}</th>
          <td>{row.expected}</td><td>{row.counted}</td>
          <td><strong className={difference < 0 ? 'outbound' : 'inbound'}>
            {difference === 0 ? 'Coincide' : difference < 0 ? 'Faltan ' + Math.abs(difference) : 'Sobran ' + difference}
          </strong></td>
        </tr>;
      })}</tbody>
    </table></div>
    {count.adjustedAt ? <p role="status">Ajustado por <strong>{count.adjustedBy}</strong> · {formatDate(count.adjustedAt)}. Motivo: {count.adjustmentNote}</p>
      : count.differences === 0 ? <p>Las existencias coinciden con el conteo.</p>
      : changed ? <p>Registra un conteo nuevo antes de ajustar. Hubo cambios de inventario después de este conteo.</p>
      : !isAdmin ? <p>El administrador puede revisar y aprobar el ajuste.</p>
      : <form onSubmit={apply}>
        <h4>Ajustar existencias</h4>
        <p>Aplica las diferencias de {count.differences} {count.differences === 1 ? 'producto' : 'productos'}.</p>
        <label>Motivo del ajuste<input name="note" maxLength={300} required disabled={busy} /></label>
        <br /><button disabled={busy}>Aplicar ajuste al inventario</button>
      </form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function InventoryCounts({ isAdmin }: { isAdmin: boolean }) {
  const [view, setView] = useState<'new' | 'history'>('new');
  const [history, setHistory] = useState<InventoryCountSummary[]>([]);
  const [detail, setDetail] = useState<InventoryCount | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');

  async function load(id: number | null, before?: number) {
    setError('');
    setBusy(true);
    try {
      const path = 'inventory-counts';
      const [saved, current] = await Promise.all([
        api<InventoryCountSummary[]>(path + (before ? '?before=' + before : '')),
        id === null ? Promise.resolve(null) : api<InventoryCount>(path + '/' + id),
      ]);
      setHistory((previous) => before ? [...previous, ...saved] : saved);
      setMore(saved.length === 40);
      setDetail(current);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  function openHistory(id: number | null) {
    setView('history');
    setSelected(id);
    setDetail(null);
    void load(id);
  }

  return <section aria-label="Conteos de inventario">
    <div className="actions accounts-nav">
      <button className="navigation" aria-pressed={view === 'new'} disabled={busy} onClick={() => setView('new')}>Nuevo conteo</button>
      <button className="navigation" aria-pressed={view === 'history'} disabled={busy} onClick={() => openHistory(selected)}>Historial de conteos</button>
    </div>
    {view === 'new' && <NewCount onSaved={openHistory} />}
    {view === 'history' && <>
      {error && <p role="alert">{error} <button className="secondary" disabled={busy} onClick={() => void load(selected)}>Reintentar</button></p>}
      {busy && !detail && <p role="status">Consultando conteos…</p>}
      {!busy && !error && history.length === 0 && <p>Todavía no hay conteos guardados.</p>}
      {detail && <CountDetail key={detail.id} count={detail} isAdmin={isAdmin} reload={() => load(detail.id)} />}
      <ul className="account-list">{history.map((row) => <li key={row.id}>
        <button className="secondary row-between" disabled={busy} aria-pressed={selected === row.id}
          onClick={() => openHistory(row.id)}>
          <span>Conteo #{row.id} · {row.countedBy} · {formatDate(row.createdAt)}</span>
          <span>{row.adjustedAt ? 'Ajustado' : row.differences > 0 ? row.differences + ' con diferencia' : 'Sin diferencias'}</span>
        </button>
      </li>)}</ul>
      {more && <button className="secondary" disabled={busy} onClick={() => void load(selected, history.at(-1)?.id)}>Cargar conteos anteriores</button>}
    </>}
  </section>;
}
