/**
 * Cliente da batch API para o app desktop (fetch assíncrono padrão —
 * Tauri roda o webview do sistema, sem as limitações de IO do Perry no Win32).
 */

export type Delivery = 'email' | 'whatsapp' | 'link';
export type ItemStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface BatchItemPayload {
  filename: string;
  contentBase64: string;
  signer: { name: string; email?: string; phoneNumber?: string };
  delivery: Delivery;
}

export interface BatchItemResult {
  id: string;
  filename: string;
  status: ItemStatus;
  signUrl: string | null;
  errorMessage: string | null;
}

export interface BatchStatus {
  id: string;
  progress: { total: number; pending: number; processing: number; done: number; failed: number };
  items: BatchItemResult[];
}

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly details: string;

  constructor(status: number, details: string) {
    super(`API respondeu ${status}: ${details.slice(0, 300)}`);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request<T>(config: ApiConfig, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new ApiError(response.status, text);
  return JSON.parse(text) as T;
}

export function createBatch(config: ApiConfig, items: BatchItemPayload[]): Promise<{ batchId: string }> {
  return request(config, 'POST', '/batches', { items });
}

export function getBatch(config: ApiConfig, batchId: string): Promise<BatchStatus> {
  return request(config, 'GET', `/batches/${batchId}`);
}

export function retryItem(config: ApiConfig, batchId: string, itemId: string): Promise<void> {
  return request(config, 'POST', `/batches/${batchId}/items/${itemId}/retry`, {});
}

/** 404 em lote inexistente = autenticado; 401 = chave errada; erro de rede = endereço inacessível. */
export async function testConnection(config: ApiConfig): Promise<'ok' | 'chave-invalida' | 'inacessivel'> {
  try {
    await getBatch(config, '00000000-0000-0000-0000-000000000000');
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return 'ok';
      if (error.status === 401) return 'chave-invalida';
    }
    return 'inacessivel';
  }
}
