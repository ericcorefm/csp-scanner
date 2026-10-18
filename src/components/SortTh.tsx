import { ChevronUp, ChevronDown } from 'lucide-react';
import type { SortDir } from '@/lib/useSort';

/** Clickable table header with a sort arrow. */
export function SortTh<K extends string>({
  label, k, sortKey, sortDir, onSort, align = 'right', title,
}: {
  label: string; k: K; sortKey: K | null; sortDir: SortDir; onSort: (k: K) => void;
  align?: 'left' | 'right'; title?: string;
}) {
  const active = sortKey === k;
  return (
    <th
      title={title ?? `Sort by ${label}`}
      onClick={() => onSort(k)}
      className={`cursor-pointer select-none whitespace-nowrap px-3 py-2.5 font-medium hover:text-slate-200 ${align === 'left' ? 'text-left' : 'text-right'} ${active ? 'text-sky-300' : ''}`}
    >
      <span className={`inline-flex items-center gap-0.5 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {label}
        {active ? (sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />) : <span className="w-3" />}
      </span>
    </th>
  );
}
