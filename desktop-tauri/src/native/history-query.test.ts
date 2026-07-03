import { describe, expect, it } from 'vitest';
import { buildBatchIdsQuery } from './history-query.ts';

describe('buildBatchIdsQuery', () => {
  it('sem filtro nenhum, só paginação', () => {
    const { sql, params } = buildBatchIdsQuery({}, 20, 0);
    expect(sql).toContain('ORDER BY b.created_at DESC');
    expect(sql).toContain('LIMIT ? OFFSET ?');
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([20, 0]);
  });

  it('busca por texto usa LIKE em signer_name e filename', () => {
    const { sql, params } = buildBatchIdsQuery({ search: 'ana' }, 20, 0);
    expect(sql).toContain('i.signer_name LIKE ?');
    expect(sql).toContain('i.filename LIKE ?');
    expect(params).toEqual(['%ana%', '%ana%', 20, 0]);
  });

  it("status 'failed' filtra por items.status", () => {
    const { sql, params } = buildBatchIdsQuery({ status: 'failed' }, 20, 0);
    expect(sql).toContain('i.status = ?');
    expect(params).toEqual(['failed', 20, 0]);
  });

  it("status 'pending' casa clicksign_status='pending' OU nulo (nunca checado)", () => {
    const { sql, params } = buildBatchIdsQuery({ status: 'pending' }, 20, 0);
    expect(sql).toContain('(i.clicksign_status = ? OR i.clicksign_status IS NULL)');
    expect(params).toEqual(['pending', 20, 0]);
  });

  it("status 'signed' filtra clicksign_status diretamente", () => {
    const { sql, params } = buildBatchIdsQuery({ status: 'signed' }, 20, 0);
    expect(sql).toContain('i.clicksign_status = ?');
    expect(params).toEqual(['signed', 20, 0]);
  });

  it("status 'canceled' filtra clicksign_status diretamente", () => {
    const { sql, params } = buildBatchIdsQuery({ status: 'canceled' }, 20, 0);
    expect(sql).toContain('i.clicksign_status = ?');
    expect(params).toEqual(['canceled', 20, 0]);
  });

  it('intervalo de datas filtra created_at do lote', () => {
    const { sql, params } = buildBatchIdsQuery({ dateFrom: '2026-01-01', dateTo: '2026-01-31' }, 20, 0);
    expect(sql).toContain('b.created_at >= ?');
    expect(sql).toContain('b.created_at <= ?');
    expect(params).toEqual(['2026-01-01', '2026-01-31', 20, 0]);
  });

  it('combina busca + status + datas juntos, na mesma ordem', () => {
    const { params } = buildBatchIdsQuery(
      { search: 'joão', status: 'signed', dateFrom: '2026-01-01', dateTo: '2026-01-31' },
      10,
      5,
    );
    expect(params).toEqual(['%joão%', '%joão%', 'signed', '2026-01-01', '2026-01-31', 10, 5]);
  });

  it('lotes/offset vão sempre por último, depois de todos os filtros', () => {
    const { params } = buildBatchIdsQuery({ search: 'x' }, 7, 3);
    expect(params[params.length - 2]).toBe(7);
    expect(params[params.length - 1]).toBe(3);
  });
});
