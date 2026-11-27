export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function api<T>(path: string, data?: object): Promise<T> {
  const response = await fetch('/api/' + path, {
    method: data ? 'POST' : 'GET',
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined,
  });
  const restart = 'La pantalla no coincide con el servidor de caja. Detén el servidor anterior y ejecuta npm start.';
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(restart);
  const result = await response.json();
  if (response.status === 401 && result.code === 'CASH_SESSION_REQUIRED') window.dispatchEvent(new Event('cash-session-required'));
  if (response.status === 404 && (result.code === 'API_ROUTE_NOT_FOUND' || result.error === 'Página no encontrada.')) {
    throw new Error(restart);
  }
  if (!response.ok) throw new ApiError(response.status, result.error ?? 'No se pudo completar la operación.');
  return result as T;
}

export function message(error: unknown) {
  return error instanceof TypeError ? 'Se perdió la comunicación con la caja. Reintenta sin cambiar los valores.'
    : error instanceof Error ? error.message : 'No se pudo completar la operación.';
}
