import { useEffect, useState } from 'react';
import { Save, RotateCcw, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { StockScannerState } from '@/lib/stockStore';
import { DEFAULT_STOCK_RULES, type StockRules } from '@/lib/stockTypes';

type NumField = { kind: 'num'; key: keyof StockRules; label: string; hint?: string; unit?: string; required?: boolean; step?: number };
type BoolField = { kind: 'bool'; key: keyof StockRules; label: string; hint?: string };
type Field = NumField | BoolField;
type Section = { title: string; toggle?: keyof StockRules; description: string; fields: Field[] };

const SECTIONS: Section[] = [
  {
    title: 'Trade & Probability', toggle: 'trade_enabled',
    description: 'Your 30-day recycling plan. No commission; fractional shares. The target, cycle and stop always drive the metrics; the minimums below are the qualification rules.',
    fields: [
      { kind: 'num', key: 'target_return_pct', label: 'Target return', unit: '%', required: true, step: 0.5, hint: 'Profit goal per trade (e.g. 3–5%).' },
      { kind: 'num', key: 'max_cycle_days', label: 'Max cycle days', unit: 'days', required: true, step: 1, hint: 'Capital must be recycled within this window.' },
      { kind: 'num', key: 'stop_buffer_pct', label: 'Stop buffer below support', unit: '%', required: true, step: 0.5 },
      { kind: 'num', key: 'position_size', label: 'Position size', unit: '$', required: true, step: 100, hint: 'Used to show shares and $ profit at target.' },
      { kind: 'num', key: 'min_reward_risk', label: 'Min reward : risk', step: 0.1, hint: 'Leave blank for no minimum.' },
      { kind: 'num', key: 'min_hist_hit_rate', label: 'Min hist. hit rate', unit: '%', step: 5, hint: 'Real history: how often this plan hit the target before the stop on this stock.' },
      { kind: 'num', key: 'min_exp_annualized', label: 'Min exp. annualized', unit: '%', step: 5, hint: 'Real history: wins and losses compounded. Above 0% = the plan made money on this stock.' },
      { kind: 'num', key: 'min_prob_target', label: 'Min probability of target (model)', unit: '%', step: 5, hint: 'Model estimate, no upward drift — keep this modest.' },
      { kind: 'num', key: 'min_pop', label: 'Min POP (model)', unit: '%', step: 5, hint: 'Model estimate. Leave blank unless you know you want it.' },
    ],
  },
  {
    title: 'Pullback & Rebound', toggle: 'pullback_enabled',
    description: 'Buy the bounce, not the fall: the stock has retraced from its recent high, is turning back up, and is sitting on a support level that has been tested and is holding.',
    fields: [
      { kind: 'num', key: 'min_pullback_pct', label: 'Min pullback from 20-day high', unit: '%', step: 1, hint: 'Has actually retraced (not buying at the top).' },
      { kind: 'num', key: 'max_pullback_pct', label: 'Max pullback from 20-day high', unit: '%', step: 1, hint: 'Not a breakdown.' },
      { kind: 'num', key: 'min_rebound_pct', label: 'Min rebound off 5-day low', unit: '%', step: 0.5, hint: 'Bounce has started.' },
      { kind: 'bool', key: 'require_rsi_rising', label: 'Require RSI turning up (vs 3 days ago)' },
      { kind: 'num', key: 'min_support_touches', label: 'Min support tests (120 days)', unit: 'times', step: 1, hint: 'Support proven by repeated bounces.' },
      { kind: 'num', key: 'support_held_days', label: 'Support held for', unit: 'days', step: 1, hint: 'No close below support in this many days.' },
    ],
  },
  {
    title: 'Long-term Trend', toggle: 'trend_enabled',
    description: 'Only stocks in a long-term uptrend that is still trending higher.',
    fields: [
      { kind: 'bool', key: 'require_price_above_ma200', label: 'Require Price > MA200' },
      { kind: 'bool', key: 'require_ma200_rising', label: 'Require MA200 rising' },
      { kind: 'num', key: 'ma200_slope_lookback', label: 'MA200 rising vs N days ago', unit: 'days', required: true, step: 1 },
      { kind: 'bool', key: 'require_ma50_above_ma200', label: 'Require MA50 > MA200' },
    ],
  },
  {
    title: 'Momentum (RSI 14)', toggle: 'momentum_enabled',
    description: 'A pullback in an uptrend: not broken, not overbought. Wilder RSI, same as TradingView.',
    fields: [
      { kind: 'num', key: 'rsi_min', label: 'RSI minimum', step: 1 },
      { kind: 'num', key: 'rsi_max', label: 'RSI maximum', step: 1 },
    ],
  },
  {
    title: 'Support', toggle: 'support_enabled',
    description: '% the price sits above primary support. Close to support keeps the stop (and risk) tight.',
    fields: [
      { kind: 'num', key: 'support_dist_min', label: 'Min % above support', unit: '%', step: 0.5 },
      { kind: 'num', key: 'support_dist_max', label: 'Max % above support', unit: '%', step: 0.5 },
    ],
  },
  {
    title: "Don't Chase", toggle: 'extension_enabled',
    description: 'Skip stocks that already ran too far above their averages.',
    fields: [
      { kind: 'num', key: 'max_above_ma50', label: 'Max % above MA50', unit: '%', step: 1 },
      { kind: 'num', key: 'max_above_ma200', label: 'Max % above MA200', unit: '%', step: 1 },
    ],
  },
  {
    title: 'Relative Strength', toggle: 'strength_enabled',
    description: 'Leaders trade near their highs and beat the market.',
    fields: [
      { kind: 'num', key: 'max_from_52w_high', label: 'Within % of 52-week high', unit: '%', step: 1 },
      { kind: 'bool', key: 'require_outperform_spy', label: 'Require beating SPY (3-month return)' },
      { kind: 'num', key: 'min_rs_vs_spy_pct', label: 'Beat SPY by more than', unit: '%', step: 1, hint: '0 = any outperformance; 5 = clear leader.' },
    ],
  },
  {
    title: 'Volatility', toggle: 'volatility_enabled',
    description: '60-day historical volatility. Too low rarely moves your target in a cycle; too high is erratic.',
    fields: [
      { kind: 'num', key: 'hv_min', label: 'Min HV', unit: '%', step: 5 },
      { kind: 'num', key: 'hv_max', label: 'Max HV', unit: '%', step: 5 },
    ],
  },
  {
    title: 'Liquidity', toggle: 'liquidity_enabled',
    description: 'Easy to enter and exit.',
    fields: [
      { kind: 'num', key: 'min_price', label: 'Min price', unit: '$', step: 1 },
      { kind: 'num', key: 'max_price', label: 'Max price', unit: '$', step: 1 },
      { kind: 'num', key: 'min_avg_volume', label: 'Min avg daily volume (20d)', unit: 'shares', step: 100000 },
      { kind: 'num', key: 'min_dollar_volume_m', label: 'Min avg dollar volume', unit: '$M', step: 5 },
    ],
  },
];

function Switch({ on, onChange, disabled = false }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-sky-500' : 'bg-slate-700'}`}
      aria-pressed={on}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${on ? 'left-4' : 'left-0.5'}`} />
    </button>
  );
}

export function StockSettingsPage({ stock }: { stock: StockScannerState }) {
  const saved = stock.profile?.rules ?? DEFAULT_STOCK_RULES;
  const [rules, setRules] = useState<StockRules>(saved);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { setRules(saved); }, [stock.profile]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = JSON.stringify(rules) !== JSON.stringify(saved);
  const set = <K extends keyof StockRules>(key: K, value: StockRules[K]) => setRules((r) => ({ ...r, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    const res = await stock.saveProfile(rules);
    setSaving(false);
    setMessage(res.ok ? { ok: true, text: 'Saved. Rescan to apply.' } : { ok: false, text: res.error || 'Save failed' });
    setTimeout(() => setMessage(null), 4000);
  };

  if (!stock.profile) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
        {stock.error ?? 'Loading stock settings…'}
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-20">
      {isDirty && (
        <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border border-amber-500/60 bg-slate-900 px-4 py-2.5 text-sm text-amber-300 shadow-2xl">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Unsaved changes — Rescan uses the last saved stock settings.
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 font-medium text-white hover:bg-sky-600 disabled:opacity-60">
            <Save className="h-4 w-4" /> Save now
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Stock Settings</h1>
          <p className="text-sm text-slate-500">Rules for the Stocks scanner only — your CSP settings are separate and unaffected.</p>
        </div>
        <div className="flex items-center gap-2">
          {message && (
            <span className={`flex items-center gap-1.5 text-sm ${message.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {message.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />} {message.text}
            </span>
          )}
          <button
            onClick={() => setRules(DEFAULT_STOCK_RULES)}
            className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            <RotateCcw className="h-4 w-4" /> Reset to Default
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
          >
            <Save className="h-4 w-4" /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {SECTIONS.map((section) => {
          const on = section.toggle ? Boolean(rules[section.toggle]) : true;
          return (
            <div key={section.title} className="rounded-xl border border-slate-800 bg-slate-900/50">
              <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
                <span className={`font-semibold ${on ? 'text-slate-100' : 'text-slate-500'}`}>{section.title}</span>
                {section.toggle && (
                  <span className="flex items-center gap-2 text-xs text-slate-500">
                    {on ? <span className="text-sky-400">ON</span> : 'Requirements disabled · OFF'}
                    <Switch on={on} onChange={(v) => set(section.toggle!, v as never)} />
                  </span>
                )}
              </div>
              <div className="space-y-3 px-5 py-4">
                <p className="text-xs text-slate-500">{section.description}</p>
                {section.fields.map((f) => {
                  // Trade plan inputs (target, cycle, stop, size) always apply — they define the metrics.
                  const alwaysOn = section.toggle === 'trade_enabled' && f.kind === 'num' && f.required;
                  const disabled = !on && !alwaysOn;
                  return (
                    <div key={f.key} className={`flex items-center justify-between gap-4 ${disabled ? 'opacity-40' : ''}`}>
                      <div>
                        <div className="text-sm text-slate-300">{f.label}</div>
                        {f.hint && <div className="text-xs text-slate-500">{f.hint}</div>}
                      </div>
                      {f.kind === 'bool' ? (
                        <Switch on={Boolean(rules[f.key])} disabled={disabled} onChange={(v) => set(f.key, v as never)} />
                      ) : (
                        <div className="flex items-center gap-1.5">
                          {f.unit === '$' && <span className="text-xs text-slate-500">$</span>}
                          <input
                            type="number"
                            step={f.step ?? 1}
                            disabled={disabled}
                            value={rules[f.key] == null ? '' : String(rules[f.key])}
                            placeholder={f.required ? '' : 'None'}
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === '') { set(f.key, (f.required ? (DEFAULT_STOCK_RULES[f.key] as number) : null) as never); return; }
                              const n = Number(raw);
                              if (Number.isFinite(n)) set(f.key, n as never);
                            }}
                            className="w-28 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-right text-sm tabular-nums text-slate-100 disabled:cursor-not-allowed"
                          />
                          {f.unit && f.unit !== '$' && <span className="w-10 text-xs text-slate-500">{f.unit}</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
