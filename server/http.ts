import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

export async function readJson(request: IncomingMessage, limit = 4096): Promise<Record<string, unknown> | null> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') return null;
  let body = '';
  let oversized = false;
  request.setEncoding('utf8');
  for await (const chunk of request) {
    if (oversized) continue;
    if (body.length + chunk.length > limit) oversized = true;
    else body += chunk;
  }
  if (oversized) return null;
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
