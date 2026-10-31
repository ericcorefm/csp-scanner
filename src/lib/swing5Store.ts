import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { StockScannerState } from '@/lib/stockStore';
import {
  DEFAULT_SWING5_RULES,
  type StockScanMode, type Swing5Rules, type Swing5Result, type Swing5Counts,
} from '@/lib/stockTypes';

const KEEP_SCANS_DAYS = 7;
// Saved in stock_scans next to the 30-Day results, under their own modes.
const dbMode = (m: StockScanMode) => `swing5-${m}`;

export function swing5RulesOf(stock: StockScannerState): Swing5Rules {
  return { ...DEFAULT_SWING5_RULES, ...(stock.profile?.rules.swing5 || {}) };
}

/**
 * 1% / 5-Day Swing scanner state. Settings live inside the stock profile
 * (rules.swing5); Discovery / Universe follow the 30-Day tab's switch.
 */
export function useSwing5Scanner(stock: StockScannerState, universeSymbols: string[]) {
  const [results, setResults] = useState<Record<StockScanMode, Swing5Result[]>>({ discovery: [], universe: [] });
  const [counts, setCounts] = useState<Record<StockScanMode, Swing5Counts | null>>({ discovery: null, universe: null });
  const [lastScanAt, setLastScanAt] = useState<Record<StockScanMode, string | null>>({ discovery: null, universe: null });
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rules = swing5RulesOf(stock);
  const mode = stock.scanMode;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const m of ['discovery', 'universe'] as StockScanMode[]) {
        const { data } = await supabase
          .from('stock_scans')
          .select('results, counts, scanned_at')
          .eq('scan_mode', dbMode(m))
          .order('scanned_at', { ascending: false })
          .limit(1);
        const latest = data?.[0];
        if (latest && !cancelled) {
          setResults((p) => ({ ...p, [m]: (latest.results || []) as Swing5Result[] }));
          setCounts((p) => ({ ...p, [m]: latest.counts as Swing5Counts }));
          setLastScanAt((p) => ({ ...p, [m]: latest.scanned_at as string }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const saveRules = useCallback(async (next: Swing5Rules) => {
    if (!stock.profile) return { ok: false, error: 'Stock settings not loaded yet' };
    return stock.saveProfile({ ...stock.profile.rules, swing5: next }, undefined, true);
  }, [stock]);

  const runScan = useCallback(async () => {
    if (!stock.profile || scanning) return;
    const m = mode;
    if (m === 'universe' && universeSymbols.length === 0) {
      setError('Your Stock Universe has no enabled tickers. Add some on the Stock Universe page.');
      return;
    }
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: e } = await supabase.functions.invoke('market-scan', {
        body: { mode: 'swing5-scan', scanMode: m, rules, symbols: m === 'universe' ? universeSymbols : undefined },
      });
      if (e) throw e;
      if (!data?.success) throw new Error(data?.error || '5-Day Swing scan failed');
      const newResults = (data.results || []) as Swing5Result[];
      const newCounts = data.counts as Swing5Counts;
      const scannedAt = (data.scanned_at as string) || new Date().toISOString();
      setResults((p) => ({ ...p, [m]: newResults }));
      setCounts((p) => ({ ...p, [m]: newCounts }));
      setLastScanAt((p) => ({ ...p, [m]: scannedAt }));
      const notes: string[] = [];
      if (newCounts?.daily_prices_refreshed === false) notes.push("Today's prices couldn't be refreshed — using the last saved prices.");
      if ((newCounts?.still_pending_history ?? 0) > 0) {
        notes.push(`${newCounts.still_pending_history} stock(s) are Pending because price history is still loading${newCounts.history_rate_limited ? ' (Massive limit: 5 calls/min)' : ''}. Scan again in 1–2 minutes.`);
      }
      if (notes.length) setNotice(notes.join(' '));
      await supabase.from('stock_scans').insert({
        scan_mode: dbMode(m), profile_id: stock.profile.id, scanned_at: scannedAt, results: newResults, counts: newCounts,
      });
      const cutoff = new Date(Date.now() - KEEP_SCANS_DAYS * 86400000).toISOString();
      await supabase.from('stock_scans').delete().eq('scan_mode', dbMode(m)).lt('scanned_at', cutoff);
    } catch (err) {
      setError(`5-Day Swing scan failed — showing previous results. (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      setScanning(false);
    }
  }, [stock.profile, scanning, mode, universeSymbols, rules]);

  // Check one ticker (not saved). Loads ~2 years of history for the backtest.
  const [analyzing, setAnalyzing] = useState(false);
  const analyze = useCallback(async (ticker: string): Promise<{ result: Swing5Result | null; error: string | null }> => {
    setAnalyzing(true);
    try {
      const { data, error: e } = await supabase.functions.invoke('market-scan', {
        body: { mode: 'swing5-scan', ticker: ticker.toUpperCase().trim(), rules },
      });
      if (e) throw e;
      if (!data?.success) throw new Error(data?.error || 'Check failed');
      return { result: (data.results?.[0] as Swing5Result) ?? null, error: null };
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : String(err) };
    } finally {
      setAnalyzing(false);
    }
  }, [rules]);

  return {
    rules, saveRules, mode,
    results: results[mode], counts: counts[mode], lastScanAt: lastScanAt[mode],
    scanning, error, notice, runScan, analyze, analyzing,
  };
}

export type Swing5State = ReturnType<typeof useSwing5Scanner>;
