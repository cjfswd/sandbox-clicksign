/**
 * Montagem pura da query SQL do histórico de lotes — sem nenhum import de
 * @tauri-apps/plugin-sql, testável sem banco de verdade. Quem executa é
 * BatchRepository.listBatches.
 */

export interface HistoryFilter {
  /** Busca livre por nome do signatário OU nome do arquivo. */
  search?: string;
  status?: 'pending' | 'signed' | 'canceled' | 'failed';
  /** Data ISO — filtra batches.created_at >= dateFrom. */
  dateFrom?: string;
  /** Data ISO — filtra batches.created_at <= dateTo. */
  dateTo?: string;
}

/**
 * Acha os `batch_id` que têm ao menos um item batendo com o filtro,
 * paginado por LOTE (não por item) — mostra o lote inteiro quando qualquer
 * item dele casa com o filtro.
 */
export function buildBatchIdsQuery(
  filter: HistoryFilter,
  limit: number,
  offset: number,
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.search) {
    conditions.push('(i.signer_name LIKE ? OR i.filename LIKE ?)');
    params.push(`%${filter.search}%`, `%${filter.search}%`);
  }
  if (filter.status === 'failed') {
    conditions.push('i.status = ?');
    params.push('failed');
  } else if (filter.status === 'pending') {
    conditions.push('(i.clicksign_status = ? OR i.clicksign_status IS NULL)');
    params.push('pending');
  } else if (filter.status === 'signed' || filter.status === 'canceled') {
    conditions.push('i.clicksign_status = ?');
    params.push(filter.status);
  }
  if (filter.dateFrom) {
    conditions.push('b.created_at >= ?');
    params.push(filter.dateFrom);
  }
  if (filter.dateTo) {
    conditions.push('b.created_at <= ?');
    params.push(filter.dateTo);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = [
    'SELECT DISTINCT b.id, b.created_at',
    'FROM batches b',
    'JOIN items i ON i.batch_id = b.id',
    where,
    'ORDER BY b.created_at DESC',
    'LIMIT ? OFFSET ?',
  ]
    .filter(Boolean)
    .join('\n');
  params.push(limit, offset);

  return { sql, params };
}
