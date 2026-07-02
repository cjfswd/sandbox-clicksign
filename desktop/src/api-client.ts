/**
 * Cliente da batch API para o app desktop — transporte SÍNCRONO via curl.exe
 * (presente em todo Windows 10/11).
 *
 * Por que não fetch/node:http: no perry/ui 0.5.1182 para Win32, o run loop
 * nativo não bombeia conclusões de IO assíncrono — promessas de rede nunca
 * resolvem dentro de apps de UI (funciona em binários sem perry/ui; o fix do
 * pump existe no fonte upstream, ainda sem release). Chamadas síncronas
 * bloqueiam a UI por dezenas de ms contra a API local — aceitável e confiável.
 * Reavaliar no próximo release do Perry.
 */
import { execFileSync } from 'node:child_process';

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

function requestSync<T>(config: ApiConfig, method: string, path: string, body?: unknown): T {
  const args = [
    '-s',
    '-w',
    '\n__HTTP_STATUS__:%{http_code}',
    '-X',
    method,
    `${config.baseUrl}${path}`,
    '-H',
    `x-api-key: ${config.apiKey}`,
    '-H',
    'content-type: application/json',
    '--connect-timeout',
    '5',
    '--max-time',
    '120',
  ];
  if (body !== undefined) args.push('--data-binary', '@-');

  const raw = execFileSync('curl.exe', args, {
    encoding: 'utf8',
    input: body === undefined ? undefined : JSON.stringify(body),
    maxBuffer: 256 * 1024 * 1024,
  });

  const marker = raw.lastIndexOf('\n__HTTP_STATUS__:');
  if (marker < 0) throw new Error('Resposta do curl sem marcador de status');
  const status = Number(raw.slice(marker + 17).trim());
  const text = raw.slice(0, marker);
  if (status < 200 || status >= 300) throw new ApiError(status, text);
  return JSON.parse(text) as T;
}

export function createBatchSync(config: ApiConfig, items: BatchItemPayload[]): { batchId: string } {
  return requestSync(config, 'POST', '/batches', { items });
}

export function getBatchSync(config: ApiConfig, batchId: string): BatchStatus {
  return requestSync(config, 'GET', `/batches/${batchId}`);
}

export function retryItemSync(config: ApiConfig, batchId: string, itemId: string): void {
  requestSync(config, 'POST', `/batches/${batchId}/items/${itemId}/retry`, {});
}

/** 404 em lote inexistente = autenticado; 401 = chave errada; outros = rede. */
export function testConnectionSync(config: ApiConfig): 'ok' | 'chave-invalida' | 'inacessivel' {
  try {
    getBatchSync(config, '00000000-0000-0000-0000-000000000000');
    return 'ok';
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return 'ok';
      if (error.status === 401) return 'chave-invalida';
    }
    return 'inacessivel';
  }
}
