/**
 * Testa BatchRepository via mockIPC (@tauri-apps/api/mocks), interceptando
 * as chamadas invoke('plugin:sql|...') que @tauri-apps/plugin-sql emite.
 * Escopo: mapeamento de rowToItem() (snake_case → camelCase, guarda de
 * integridade de 'done') e a forma/ordem das queries SQL de createBatch.
 * Não valida semântica SQL real (sem SQLite de verdade rodando) — isso
 * continua sendo verificado manualmente/via `tauri dev`, como documentado
 * em .superpowers/sdd/testing-infra-proposal.md.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { BatchRepository } from './repository.ts';

// Linha 'pending' com todos os campos obrigatórios de ItemRow preenchidos.
const pendingItemRow = {
  id: 'item-1',
  batch_id: 'batch-1',
  filename: 'documento.pdf',
  signer_name: 'Ana Silva',
  signer_email: null,
  signer_phone: null,
  delivery: 'link',
  status: 'pending',
  retry_count: 0,
  envelope_id: null,
  signer_id: null,
  sign_url: null,
  error_message: null,
  clicksign_status: null,
  clicksign_status_checked_at: null,
  deadline_at: null,
};

const batchRow = { id: 'batch-1', created_at: '2026-01-01T00:00:00.000Z' };

beforeEach(() => clearMocks());

describe('BatchRepository (mockIPC)', () => {
  it('getBatch mapeia uma linha pending corretamente', async () => {
    mockIPC((cmd, args) => {
      if (cmd === 'plugin:sql|load') return 'sqlite:sandbox/batches.db';
      if (cmd === 'plugin:sql|select') {
        const query = (args as { query: string }).query;
        if (query.includes('FROM batches WHERE id')) return [batchRow];
        if (query.includes('FROM items WHERE batch_id')) return [pendingItemRow];
      }
      throw new Error(`comando inesperado: ${cmd}`);
    });

    const repo = await BatchRepository.load('sandbox/batches.db');
    const batch = await repo.getBatch('batch-1');

    expect(batch).not.toBeNull();
    const item = batch?.items[0];
    expect(item).toBeDefined();
    expect(item?.status).toBe('pending');
    expect(item?.id).toBe('item-1');
    expect(item?.filename).toBe('documento.pdf');
    expect(item?.signer.name).toBe('Ana Silva');
    expect(item?.signer.email).toBeUndefined();
  });

  it('getBatch mapeia uma linha done com todos os campos da Clicksign', async () => {
    const doneItemRow = {
      ...pendingItemRow,
      status: 'done',
      envelope_id: 'env-1',
      signer_id: 'signer-1',
      sign_url: 'https://clicksign.example/sign/env-1',
    };

    mockIPC((cmd, args) => {
      if (cmd === 'plugin:sql|load') return 'sqlite:sandbox/batches.db';
      if (cmd === 'plugin:sql|select') {
        const query = (args as { query: string }).query;
        if (query.includes('FROM batches WHERE id')) return [batchRow];
        if (query.includes('FROM items WHERE batch_id')) return [doneItemRow];
      }
      throw new Error(`comando inesperado: ${cmd}`);
    });

    const repo = await BatchRepository.load('sandbox/batches.db');
    const batch = await repo.getBatch('batch-1');

    const item = batch?.items[0];
    expect(item).toBeDefined();
    if (!item || item.status !== 'done') throw new Error('esperava item done');
    expect(item.envelopeId).toBe('env-1');
    expect(item.signerId).toBe('signer-1');
    expect(item.signUrl).toBe('https://clicksign.example/sign/env-1');
  });

  it('getBatch lança erro quando uma linha done não tem envelope_id (guarda de integridade)', async () => {
    const brokenDoneRow = {
      ...pendingItemRow,
      status: 'done',
      envelope_id: null,
      signer_id: 'signer-1',
      sign_url: 'https://clicksign.example/sign/env-1',
    };

    mockIPC((cmd, args) => {
      if (cmd === 'plugin:sql|load') return 'sqlite:sandbox/batches.db';
      if (cmd === 'plugin:sql|select') {
        const query = (args as { query: string }).query;
        if (query.includes('FROM batches WHERE id')) return [batchRow];
        if (query.includes('FROM items WHERE batch_id')) return [brokenDoneRow];
      }
      throw new Error(`comando inesperado: ${cmd}`);
    });

    const repo = await BatchRepository.load('sandbox/batches.db');
    await expect(repo.getBatch('batch-1')).rejects.toThrow();
  });

  it('createBatch envia BEGIN, INSERT em batches, INSERT em items, COMMIT nessa ordem', async () => {
    const executedQueries: string[] = [];

    mockIPC((cmd, args) => {
      if (cmd === 'plugin:sql|load') return 'sqlite:sandbox/batches.db';
      if (cmd === 'plugin:sql|execute') {
        executedQueries.push((args as { query: string }).query);
        return [0, undefined];
      }
      if (cmd === 'plugin:sql|select') {
        const query = (args as { query: string }).query;
        if (query.includes('FROM batches WHERE id')) return [batchRow];
        if (query.includes('FROM items WHERE batch_id')) return [pendingItemRow];
      }
      throw new Error(`comando inesperado: ${cmd}`);
    });

    const repo = await BatchRepository.load('sandbox/batches.db');
    await repo.createBatch([{ filename: 'a.pdf', signer: { name: 'Ana' }, delivery: 'link' }]);

    expect(executedQueries).toHaveLength(4);
    expect(executedQueries[0]).toBe('BEGIN');
    expect(executedQueries[1]).toContain('INSERT INTO batches');
    expect(executedQueries[2]).toContain('INSERT INTO items');
    expect(executedQueries[3]).toBe('COMMIT');
  });
});
