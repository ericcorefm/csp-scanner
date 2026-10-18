import { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';

/**
 * Click-to-sort for tables. `getValue` maps a row + column key to a sortable
 * value. Empty values always sort last. Clicking the same header flips direction.
 */
export function useSort<T, K extends string>(
  rows: T[],
  getValue: (row: T, key: K) => string | number | null | undefined,
  initial: { key: K | null; dir?: SortDir } = { key: null },
) {
  const [sortKey, setSortKey] = useState<K | null>(initial.key);
  const [sortDir, setSortDir] = useState<SortDir>(initial.dir ?? 'asc');

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) => {
      const av = getValue(a, sortKey);
      const bv = getValue(b, sortKey);
      const aMissing = av == null || av === '';
      const bMissing = bv == null || bv === '';
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (aMissing) return 0;
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir, getValue]);

  const toggle = (key: K) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  return { sorted, sortKey, sortDir, toggle };
}
