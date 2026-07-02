/**
 * Servidor HTTP da batch API (Hono), implementando o contrato
 * contracts/batch-contract.ts. Autenticação por x-api-key (critério 6);
 * erros internos são sanitizados para nunca vazar segredos (critério 5).
 */
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { BatchRepository } from '../infra/repository.ts';
import type { PdfStore } from '../infra/pdf-store.ts';
import { registerBatchRoutes } from './handlers.ts';

export interface AppDeps {
  repo: BatchRepository;
  pdfStore: PdfStore;
  apiKey: string;
  /** Acorda o worker quando entra trabalho novo (lote criado / retry). */
  wakeWorker: () => void;
  /** Valores que jamais podem aparecer em respostas ou logs de erro. */
  secrets?: string[];
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const secrets = [deps.apiKey, ...(deps.secrets ?? [])].filter((s) => s.length > 0);

  app.use('*', async (c, next) => {
    const provided = c.req.header('x-api-key') ?? '';
    if (!safeEquals(provided, deps.apiKey)) {
      return c.json({ message: 'Não autorizado' }, 401);
    }
    await next();
  });

  app.onError((error, c) => {
    console.error('Erro interno:', sanitize(error.message, secrets));
    return c.json({ message: 'Erro interno' }, 500);
  });

  registerBatchRoutes(app, deps);
  return app;
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sanitize(message: string, secrets: string[]): string {
  return secrets.reduce((msg, secret) => msg.replaceAll(secret, '[REDACTED]'), message);
}
