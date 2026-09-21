import { useMemo } from 'react';
import {
  CheckCircle2, PlusCircle, MinusCircle, Target, Clock,
  AlertTriangle, TrendingDown,
} from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Card, Badge, formatMoney, formatPercent, formatNum } from '@/components/ui';
import { calcPositionStatus, calcDaysOpen, calcDaysToReview } from '@/lib/calculations';

export function DailySummaryPage({ state }: { state: AppState }) {
  const summary = useMemo(() => {
    const qualified = state.candidates.filter((c) => c.qualified);
    const openTickers = state.openPositions.map((p) => p.ticker);
    const nearBtc = state.openPositions.filter((p) => {
      const status = calcPositionStatus(
        p.current_mid, p.btc_target,
        calcDaysOpen(p.open_date),
        state.activeProfile?.max_recycle_days || 120,
        p.trend_classification, p.stock_price, p.primary_support,
      );
      return status === 'BTC Ready' || status === 'Near BTC Target';
    });
    const near120 = state.openPositions.filter((p) => {
      const days = calcDaysToReview(p.open_date, state.activeProfile?.max_recycle_days || 120);
      return days <= 10;
    });
    const supportBreaks = state.openPositions.filter((p) => p.stock_price < p.primary_support * 0.98);
    const trendChanges = state.openPositions.filter((p) => p.trend_classification === 'Downtrend');

    return {
      qualifiedCount: qualified.length,
      newCount: qualified.length,
      nearBtc,
      near120,
      supportBreaks,
      trendChanges,
      openTickers,
      qualified,
    };
  }, [state.candidates, state.openPositions, state.activeProfile]);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const cards = [
    {
      label: 'Qualified Candidates',
      value: summary.qualifiedCount,
      icon: CheckCircle2,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10',
    },
    {
      label: 'New Candidates',
      value: summary.newCount,
      icon: PlusCircle,
      color: 'text-sky-400',
      bg: 'bg-sky-500/10',
    },
    {
      label: 'Near BTC Target',
      value: summary.nearBtc.length,
      icon: Target,
      color: 'text-violet-400',
      bg: 'bg-violet-500/10',
    },
    {
      label: 'Near 120-Day Review',
      value: summary.near120.length,
      icon: Clock,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
    },
    {
      label: 'Support Breaks',
      value: summary.supportBreaks.length,
      icon: AlertTriangle,
      color: 'text-red-400',
      bg: 'bg-red-500/10',
    },
    {
      label: 'Trend Changes',
      value: summary.trendChanges.length,
      icon: TrendingDown,
      color: 'text-orange-400',
      bg: 'bg-orange-500/10',
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Daily Summary</h1>
        <p className="text-sm text-slate-500 mt-0.5">{today}</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.label} className="p-5">
              <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${card.bg} mb-3`}>
                <Icon className={`h-5 w-5 ${card.color}`} />
              </div>
              <div className={`text-2xl font-bold tabular-nums ${card.color}`}>{card.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{card.label}</div>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Near BTC target */}
        <Card title="Positions Near BTC Target">
          <div className="p-5">
            {summary.nearBtc.length === 0 ? (
              <p className="text-sm text-slate-500">No positions are near their BTC target.</p>
            ) : (
              <div className="space-y-2">
                {summary.nearBtc.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg bg-slate-800/40 p-3">
                    <div>
                      <span className="font-semibold text-slate-200">{p.ticker}</span>
                      <span className="text-xs text-slate-500 ml-2">${p.strike} strike</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <span className="text-slate-400">Mid: {formatMoney(p.current_mid)}</span>
                      <span className="text-emerald-400">Target: {formatMoney(p.btc_target)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Near 120-day review */}
        <Card title="Positions Near 120-Day Review">
          <div className="p-5">
            {summary.near120.length === 0 ? (
              <p className="text-sm text-slate-500">No positions are approaching 120-day review.</p>
            ) : (
              <div className="space-y-2">
                {summary.near120.map((p) => {
                  const days = calcDaysToReview(p.open_date, state.activeProfile?.max_recycle_days || 120);
                  return (
                    <div key={p.id} className="flex items-center justify-between rounded-lg bg-slate-800/40 p-3">
                      <div>
                        <span className="font-semibold text-slate-200">{p.ticker}</span>
                        <span className="text-xs text-slate-500 ml-2">Opened {p.open_date}</span>
                      </div>
                      <Badge variant={days <= 5 ? 'error' : 'warning'} dot>
                        {days} days left
                      </Badge>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        {/* Support breaks */}
        <Card title="Support Breaks">
          <div className="p-5">
            {summary.supportBreaks.length === 0 ? (
              <p className="text-sm text-slate-500">No support breaks detected.</p>
            ) : (
              <div className="space-y-2">
                {summary.supportBreaks.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg bg-red-900/20 p-3">
                    <div>
                      <span className="font-semibold text-slate-200">{p.ticker}</span>
                      <span className="text-xs text-slate-500 ml-2">{formatMoney(p.stock_price)} vs support {formatMoney(p.primary_support)}</span>
                    </div>
                    <Badge variant="error" dot>Below Support</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* Trend changes */}
        <Card title="Trend Changes">
          <div className="p-5">
            {summary.trendChanges.length === 0 ? (
              <p className="text-sm text-slate-500">No negative trend changes detected.</p>
            ) : (
              <div className="space-y-2">
                {summary.trendChanges.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg bg-orange-900/20 p-3">
                    <div>
                      <span className="font-semibold text-slate-200">{p.ticker}</span>
                      <span className="text-xs text-slate-500 ml-2">Was {p.trend_classification}</span>
                    </div>
                    <Badge variant="warning" dot>Downtrend</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Qualified candidates list */}
      <Card title="Qualified Candidates Today">
        <div className="p-5">
          {summary.qualified.length === 0 ? (
            <p className="text-sm text-slate-500">No qualified candidates today.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {summary.qualified.map((c) => (
                <div key={`${c.ticker}-${c.strike}-${c.expiration}`} className="rounded-lg border border-slate-800 bg-slate-800/30 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-slate-100">{c.ticker}</span>
                    <Badge variant={c.trend_classification === 'Downtrend' ? 'error' : 'success'} dot>
                      {c.trend_classification}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-slate-500">Strike:</span> <span className="text-slate-300">${c.strike}</span></div>
                    <div><span className="text-slate-500">DTE:</span> <span className="text-slate-300">{c.dte}</span></div>
                    <div><span className="text-slate-500">CROI:</span> <span className="text-emerald-400">{formatPercent(c.net_croi)}</span></div>
                    <div><span className="text-slate-500">PC:</span> <span className="text-slate-300">{formatPercent(c.premium_capture)}</span></div>
                    <div><span className="text-slate-500">STO:</span> <span className="text-sky-400">{formatMoney(c.suggested_sto)}</span></div>
                    <div><span className="text-slate-500">BTC:</span> <span className="text-sky-300">{formatMoney(c.suggested_btc)}</span></div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
