import type { Pool } from 'pg';

export type RefreshFrequency = 'startup' | 'daily' | 'weekly' | 'monthly' | 'manual';

export interface FreshnessRecord {
  entity: string;
  lastLoadedAt: Date | null;
  refreshFrequency: RefreshFrequency;
  label: string;
  description: string | null;
}

const THRESHOLDS_MS: Record<string, number> = {
  daily:   24 * 60 * 60 * 1000,
  weekly:   7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export function isStale(record: Pick<FreshnessRecord, 'lastLoadedAt' | 'refreshFrequency'>): boolean {
  if (record.refreshFrequency === 'manual') return false;
  if (record.refreshFrequency === 'startup') return true;
  if (!record.lastLoadedAt) return true;
  const ageMs = Date.now() - record.lastLoadedAt.getTime();
  return ageMs > (THRESHOLDS_MS[record.refreshFrequency] ?? Infinity);
}

export async function getDataFreshness(pool: Pool): Promise<Map<string, FreshnessRecord>> {
  const { rows } = await pool.query<{
    entity: string;
    last_loaded_at: Date | null;
    refresh_frequency: string;
    label: string;
    description: string | null;
  }>(`SELECT entity, last_loaded_at, refresh_frequency, label, description FROM data_freshness ORDER BY entity`);

  const map = new Map<string, FreshnessRecord>();
  for (const row of rows) {
    map.set(row.entity, {
      entity: row.entity,
      lastLoadedAt: row.last_loaded_at,
      refreshFrequency: row.refresh_frequency as RefreshFrequency,
      label: row.label,
      description: row.description,
    });
  }
  return map;
}

export async function markLoaded(pool: Pool, entity: string): Promise<void> {
  await pool.query(
    `UPDATE data_freshness SET last_loaded_at = NOW() WHERE entity = $1`,
    [entity],
  );
}
