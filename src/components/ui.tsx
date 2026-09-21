import type { ReactNode } from 'react';

type Variant = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const colors: Record<Variant, string> = {
  success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  warning: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  error: 'bg-red-500/10 text-red-400 border-red-500/30',
  info: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  neutral: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
};

const dotColors: Record<Variant, string> = {
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
  info: 'bg-sky-400',
  neutral: 'bg-slate-400',
};

export function Badge({ variant = 'neutral', children, dot = false }: { variant?: Variant; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${colors[variant]}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dotColors[variant]}`} />}
      {children}
    </span>
  );
}

export function StatusDot({ variant = 'neutral' }: { variant?: Variant }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${dotColors[variant]}`} />;
}

export function MetricIndicator({ status }: { status: 'pass' | 'warn' | 'fail' }) {
  const map = {
    pass: { color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    warn: { color: 'text-amber-400', bg: 'bg-amber-500/10' },
    fail: { color: 'text-red-400', bg: 'bg-red-500/10' },
  };
  const m = map[status];
  return (
    <span className={`inline-flex h-5 w-5 items-center justify-center rounded ${m.bg} ${m.color} text-xs font-bold`}>
      {status === 'pass' ? '\u2713' : status === 'warn' ? '!' : '\u2717'}
    </span>
  );
}

export function Card({ children, className = '', title, action }: { children: ReactNode; className?: string; title?: string; action?: ReactNode }) {
  return (
    <div className={`rounded-xl border border-slate-800 bg-slate-900/50 ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          {title && <h3 className="text-sm font-semibold text-slate-200">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function StatRow({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-slate-400">{label}</span>
      <span className={`text-sm font-medium tabular-nums ${highlight ? 'text-emerald-400' : 'text-slate-200'}`}>{value}</span>
    </div>
  );
}

export function formatCurrency(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '--';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  return `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPct(v: number | null | undefined, decimals = 1): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '--';
  return `${v.toFixed(decimals)}%`;
}

export function formatNum(v: number | null | undefined, decimals = 2): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '--';
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatMoney(v: number | null | undefined, decimals = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(decimals)}` : '--';
}

export function formatNumber(v: number | null | undefined, decimals = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(decimals) : '--';
}

export function formatPercent(v: number | null | undefined, decimals = 1): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(decimals)}%` : '--';
}

export function toNumOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
