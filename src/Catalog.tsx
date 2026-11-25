import { useEffect, useState, type FormEvent } from 'react';
import { api } from './Accounts';

type Product = {
  id: number;
  name: string;
  brand: string;
  presentation: string;
  price: number;
  packageName: string;
  unitsPerPackage: number;
  active: 0 | 1;
  hasPhoto: 0 | 1;
  stock: number;
};

type Movement = {
  id: number;
  units: number;
  reason: string;
  createdAt: string;
  quantity: number;
  inputUnit: string;
  unitsPerInput: number;
  cashMovementId: number | null;
};
type CashReference = { id: number; amount: number; category: string; reason: string };

const currency = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const date = new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota' });

async function request<T>(path: string, method = 'GET', data?: object): Promise<T> {
  const response = await fetch('/api/products' + path, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (response.status === 401 && result.code === 'CASH_SESSION_REQUIRED') window.dispatchEvent(new Event('cash-session-required'));
  if (!response.ok) throw new Error(result.error ?? 'No se pudo completar la operación.');
  return result as T;
}

function errorMessage(error: unknown) {
  return error instanceof TypeError
    ? 'No se pudo conectar con la caja local. Vuelve a intentarlo.'
    : error instanceof Error ? error.message : 'No se pudo completar la operación.';
}

function readPhoto(file: File): Promise<string> {
  if (file.size > 2 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    return Promise.reject(new Error('Selecciona una foto JPG, PNG o WebP de hasta 2 MB.'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('No se pudo leer la foto.'));
    reader.readAsDataURL(file);
  });
}

function ProductForm({ product, onSave, onCancel }: {
  product?: Product;
  onSave: (value: Product) => void;
  onCancel: () => void;
}) {
  const [pack, setPack] = useState(product?.packageName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const selectedPhoto = fields.get('photo');
    setBusy(true);
    setError('');
    try {
      let photo: string | null | undefined;
      if (selectedPhoto instanceof File && selectedPhoto.size) photo = await readPhoto(selectedPhoto);
      else if (fields.has('removePhoto')) photo = null;
      const result = await request<Product>(product ? '/' + product.id : '', product ? 'PUT' : 'POST', {
        name: fields.get('name'), brand: fields.get('brand'), presentation: fields.get('presentation'),
        price: Number(fields.get('price')), active: fields.has('active'),
        packageName: pack.trim(), unitsPerPackage: pack.trim() ? Number(fields.get('unitsPerPackage')) : 1,
        photo,
      });
      onSave(result);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} aria-label={product ? 'Editar producto' : 'Nuevo producto'}>
      <h3>{product ? 'Editar producto' : 'Nuevo producto'}</h3>
      <fieldset disabled={busy} className="field-grid">
        <label>Nombre<input name="name" required maxLength={100} defaultValue={product?.name} autoFocus /></label>
        <label>Marca <span>(opcional)</span><input name="brand" maxLength={100} defaultValue={product?.brand} /></label>
        <label>Presentación<input name="presentation" required maxLength={100} defaultValue={product?.presentation} placeholder="Ej. media botella" /></label>
        <label>Precio de venta (COP)<input name="price" type="number" min={0} max={1_000_000_000} step={1} required defaultValue={product?.price} /></label>
        <label>Empaque de compra <span>(opcional)</span><input name="packageName" maxLength={50} value={pack} onChange={(event) => setPack(event.target.value)} placeholder="Ej. canasta" /></label>
        <label>Unidades por empaque<input name="unitsPerPackage" type="number" min={1} max={10_000} step={1} required disabled={!pack.trim()} defaultValue={product?.unitsPerPackage ?? 1} /></label>
        <label className="wide">Foto <span>(JPG, PNG o WebP, hasta 2 MB)</span><input name="photo" type="file" accept="image/jpeg,image/png,image/webp" /></label>
        {Boolean(product?.hasPhoto) && <label className="check"><input name="removePhoto" type="checkbox" /> Quitar foto actual</label>}
        <label className="check"><input name="active" type="checkbox" defaultChecked={product ? Boolean(product.active) : true} /> Producto activo</label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button disabled={busy}>{busy ? 'Guardando…' : 'Guardar producto'}</button>
        <button disabled={busy} type="button" className="secondary" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}

function Inventory({ product, onMovement }: { product: Product; onMovement: (value: Product) => void }) {
  const [history, setHistory] = useState<Movement[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [direction, setDirection] = useState('in');
  const [purchases, setPurchases] = useState<CashReference[]>([]);
  const [unit, setUnit] = useState('unit');
  const [quantity, setQuantity] = useState('');
  const endpoint = '/' + product.id + '/movements';

  async function load() {
    setLoadError('');
    try {
      const [entries, references] = await Promise.all([
        request<Movement[]>(endpoint), api<CashReference[]>('cash/purchase-references'),
      ]);
      setHistory(entries);
      setPurchases(references);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }

  useEffect(() => { void load(); }, [endpoint]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const linkedExpense = data.get('cashMovementId');
    setBusy(true);
    setSaved(false);
    setSaveError('');
    try {
      const updated = await request<Product>(endpoint, 'POST', {
        direction, quantity: Number(quantity), unit, reason: data.get('reason'),
        cashMovementId: linkedExpense ? Number(linkedExpense) : undefined,
      });
      onMovement(updated);
      form.reset();
      setQuantity('');
      setUnit('unit');
      setDirection('in');
      setSaved(true);
      await load();
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="inventory" aria-label="Inventario del producto">
      <div className="section-title">
        <h3>Inventario de {product.name} · {product.presentation}</h3>
        <strong>{product.stock} unidades</strong>
      </div>
      {Boolean(product.active) && (
        <form onSubmit={save}>
          <h4>Registrar movimiento</h4>
          <fieldset disabled={busy} className="field-grid">
            <label>Tipo<select value={direction} onChange={(event) => setDirection(event.target.value)}>
              <option value="in">Entrada</option><option value="out">Salida manual</option>
            </select></label>
            <label>Unidad<select value={unit} onChange={(event) => setUnit(event.target.value)}>
              <option value="unit">Unidad de venta</option>
              {product.packageName && <option value="package">{product.packageName} ({product.unitsPerPackage} unidades)</option>}
            </select></label>
            <label>Cantidad<input type="number" min={1} max={1_000_000} step={1} required value={quantity}
              onChange={(event) => setQuantity(event.target.value)} /></label>
            <label>Motivo<input name="reason" required maxLength={240} placeholder="Ej. compra o producto dañado" /></label>
            {direction === 'in' && purchases.length > 0 && <label className="wide">Gasto de caja relacionado (opcional)
              <select name="cashMovementId"><option value="">Ninguno</option>
                {purchases.map((purchase) => <option key={purchase.id} value={purchase.id}>
                  #{purchase.id} · {purchase.category} · {currency.format(purchase.amount)} · {purchase.reason}
                </option>)}
              </select>
            </label>}
          </fieldset>
          {unit === 'package' && Number(quantity) > 0 && <p>Equivale a {Number(quantity) * product.unitsPerPackage} unidades.</p>}
          {saveError && <p role="alert">{saveError}</p>}
          {saved && <p role="status">Movimiento guardado.</p>}
          <button disabled={busy}>{busy ? 'Registrando…' : 'Registrar movimiento'}</button>
        </form>
      )}
      <h4>Historial de movimientos</h4>
      {loadError ? <p role="alert">{loadError} <button className="secondary" onClick={() => void load()}>Reintentar</button></p>
        : !history ? <p role="status">Cargando movimientos…</p>
        : history.length === 0 ? <p>Este producto todavía no tiene movimientos.</p>
        : <ul className="movements">{history.map((movement) => (
          <li key={movement.id}>
            <strong className={movement.units > 0 ? 'inbound' : 'outbound'}>{movement.units > 0 ? '+' : ''}{movement.units} unidades</strong>
            <span>{movement.reason}</span>
            {movement.inputUnit !== 'unidad' && <span>{movement.quantity} × {movement.inputUnit} de {movement.unitsPerInput} unidades</span>}
            {movement.cashMovementId !== null && <span>Gasto de caja #{movement.cashMovementId}</span>}
            <time dateTime={movement.createdAt}>{date.format(new Date(movement.createdAt))}</time>
          </li>
        ))}</ul>}
    </section>
  );
}

const searchText = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function Catalog() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [inventory, setInventory] = useState<number | null>(null);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [message, setMessage] = useState('');

  async function load() {
    setError('');
    try {
      setProducts(await request<Product[]>(''));
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  useEffect(() => { void load(); }, []);

  function upsert(product: Product) {
    setProducts((previous) => [...(previous ?? []).filter((item) => item.id !== product.id), product]);
  }

  const shown = products?.filter((product) => (showInactive || product.active) &&
    searchText([product.name, product.brand, product.presentation].join(' ')).includes(searchText(query.trim())))
    .sort((a, b) => b.active - a.active || a.name.localeCompare(b.name, 'es') || a.id - b.id);

  return (
    <section aria-labelledby="catalog-title">
      <div className="section-title">
        <h2 id="catalog-title">Productos e inventario</h2>
        {products && editing === null && <button onClick={() => { setMessage(''); setEditing('new'); setInventory(null); }}>Agregar producto</button>}
      </div>
      {error && <p role="alert">{error} <button className="secondary" onClick={() => void load()}>Reintentar</button></p>}
      {!products && !error && <p role="status">Cargando productos…</p>}
      {editing !== null && <ProductForm key={editing} product={products?.find((product) => product.id === editing)}
        onCancel={() => setEditing(null)} onSave={(product) => {
          upsert(product);
          setEditing(null);
          setPhotoVersion((value) => value + 1);
          setMessage(product.active ? 'Producto guardado.' : 'Producto guardado como inactivo.');
        }} />}
      {message && <p role="status">{message}</p>}
      {products && (
        <>
          <div className="catalog-tools">
            <label>Buscar producto<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nombre, marca o presentación" /></label>
            <label className="check"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /> Mostrar inactivos</label>
          </div>
          {shown?.length === 0 && <p>{products.length === 0 ? 'Agrega tu primer producto para comenzar.' : 'No hay productos con ese filtro.'}</p>}
          <ul className="products">{shown?.map((product) => (
            <li key={product.id} className="product">
              {product.hasPhoto ? <img src={'/api/products/' + product.id + '/photo?v=' + photoVersion} alt="" loading="lazy" />
                : <div className="photo-placeholder">Sin foto</div>}
              <div className="product-body">
                <h3>{product.name}</h3>
                <p>{[product.brand, product.presentation].filter(Boolean).join(' · ')}</p>
                <p className="product-values"><strong>{currency.format(product.price)}</strong><span>{product.stock} unidades</span></p>
                {!product.active && <p>Inactivo</p>}
                <div className="actions">
                  <button type="button" className="secondary" disabled={editing !== null}
                    onClick={() => { setMessage(''); setEditing(product.id); setInventory(null); }}>Editar</button>
                  <button type="button" className="secondary" disabled={editing !== null}
                    aria-expanded={inventory === product.id} onClick={() => {
                      setMessage('');
                      setInventory((current) => current === product.id ? null : product.id);
                    }}>Movimientos</button>
                </div>
              </div>
              {inventory === product.id && <Inventory key={product.id} product={product} onMovement={upsert} />}
            </li>
          ))}</ul>
        </>
      )}
    </section>
  );
}
