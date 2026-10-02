import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import {
  DEFAULT_STOCK_RULES,
  type StockProfile, type StockRules, type StockResult, type StockScanCounts, type StockScanMode,
} from '@/lib/stockTypes';

const DEFAULT_PROFILE_NAME = 'My Stock Default';
const KEEP_SCANS_DAYS = 7;
// "Keep loading history": wait between automatic Rescans so Massive's
// Stocks Basic limit (5 calls/min) has reset.
const AUTO_LOAD_INTERVAL_MS = 70_000;
const AUTO_LOAD_MAX_ERRORS = 3;

function withDefaults(rules: Partial<StockRules> | null | undefined): StockRules {
  return { ...DEFAULT_STOCK_RULES, ...(rules || {}) };
}

/**
 * State for the Stocks side of the app. Fully separate from the CSP store:
 * its own profile table (stock_profiles), its own results (stock_scans).
 */
export function useStockScanner(universeSymbols: string[]) {
  const [profile, setProfile] = useState<StockProfile | null>(null);
  const [scanMode, setScanMode] = useState<StockScanMode>('discovery');
  const [results, setResults] = useState<Record<StockScanMode, StockResult[]>>({ discovery: [], universe: [] });
  const [counts, setCounts] = useState<Record<StockScanMode, StockScanCounts | null>>({ discovery: null, universe: null });
  const [lastScanAt, setLastScanAt] = useState<Record<StockScanMode, string | null>>({ discovery: null, universe: null });
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [autoLoad, setAutoLoadState] = useState(false);
  const [nextAutoScanAt, setNextAutoScanAt] = useState<number | null>(null);
  const [secondsToNextScan, setSecondsToNextScan] = useState<number | null>(null);
  const autoLoadRef = useRef(false);
  const autoErrorsRef = useRef(0);

  // Load (or create) the default stock profile, then the latest saved scans.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error: e } = await supabase.from('stock_profiles').select('*').order('created_at');
        if (e) throw e;
        let rows = (data || []) as StockProfile[];
        if (rows.length === 0) {
          const { data: created, error: ce } = await supabase
            .from('stock_profiles')
            .insert({ name: DEFAULT_PROFILE_NAME, is_default: true, rules: DEFAULT_STOCK_RULES })
            .select()
            .single();
          if (ce) throw ce;
          rows = [created as StockProfile];
        }
        const active = rows.find((r) => r.is_default) || rows[0];
        if (!cancelled) setProfile({ ...active, rules: withDefaults(active.rules) });

        for (const mode of ['discovery', 'universe'] as StockScanMode[]) {
          const { data: scans } = await supabase
            .from('stock_scans')
            .select('results, counts, scanned_at')
            .eq('scan_mode', mode)
            .order('scanned_at', { ascending: false })
            .limit(1);
          const latest = scans?.[0];
          if (latest && !cancelled) {
            setResults((prev) => ({ ...prev, [mode]: (latest.results || []) as StockResult[] }));
            setCounts((prev) => ({ ...prev, [mode]: latest.counts as StockScanCounts }));
            setLastScanAt((prev) => ({ ...prev, [mode]: latest.scanned_at as string }));
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load stock scanner data. Has the stock scanner migration been applied?');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const saveProfile = useCallback(async (rules: StockRules, name?: string) => {
    if (!profile) return { ok: false, error: 'No stock profile loaded' };
    const payload = { rules, name: name ?? profile.name, updated_at: new Date().toISOString() };
    const { data, error: e } = await supabase.from('stock_profiles').update(payload).eq('id', profile.id).select().single();
    if (e) return { ok: false, error: e.message };
    setProfile({ ...(data as StockProfile), rules: withDefaults((data as StockProfile).rules) });
    return { ok: true, error: null };
  }, [profile]);

  const runScan = useCallback(async () => {
    if (!profile || scanning) return;
    const mode = scanMode;
    if (mode === 'universe' && universeSymbols.length === 0) {
      setError('Your Scan Universe has no enabled tickers. Add some on the Scan Universe page.');
      return;
    }
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: e } = await supabase.functions.invoke('market-scan', {
        body: {
          mode: 'stock-scan',
          scanMode: mode,
          rules: profile.rules, // always the SAVED rules
          symbols: mode === 'universe' ? universeSymbols : undefined,
        },
      });
      if (e) throw e;
      if (!data?.success) throw new Error(data?.error || 'Stock scan failed');
      const newResults = (data.results || []) as StockResult[];
      const newCounts = data.counts as StockScanCounts;
      const scannedAt = (data.scanned_at as string) || new Date().toISOString();
      setResults((prev) => ({ ...prev, [mode]: newResults }));
      setCounts((prev) => ({ ...prev, [mode]: newCounts }));
      setLastScanAt((prev) => ({ ...prev, [mode]: scannedAt }));

      const notes: string[] = [];
      if (newCounts?.daily_prices_refreshed === false) {
        notes.push(newCounts.daily_prices_http_status === 429
          ? "Today's prices couldn't be refreshed (Massive rate limit) — using the last saved prices. Wait 1–2 minutes between Rescans."
          : "Today's prices couldn't be refreshed — using the last saved prices.");
      }
      if (newCounts?.still_pending_history > 0) {
        const why = newCounts.history_rate_limited
          ? 'Massive stock rate limit reached (Stocks Basic: 5 calls/min)'
          : newCounts.warming_time_budget_hit ? 'scan time budget reached' : 'history unavailable';
        notes.push(`${newCounts.still_pending_history} stock(s) are Pending because price history is still loading (${why}). Rescan in 1–2 minutes to load more; once loaded, history stays current automatically.`);
      }
      if (notes.length) setNotice(notes.join(' '));

      if (autoLoadRef.current) {
        autoErrorsRef.current = 0;
        if ((newCounts?.still_pending_history ?? 0) > 0) {
          setNextAutoScanAt(Date.now() + AUTO_LOAD_INTERVAL_MS);
        } else {
          autoLoadRef.current = false;
          setAutoLoadState(false);
          setNextAutoScanAt(null);
          setNotice('All price history is loaded. Daily Rescans now stay fast and current automatically.');
        }
      }

      // Persist; keep only the last week of scans.
      await supabase.from('stock_scans').insert({
        scan_mode: mode, profile_id: profile.id, scanned_at: scannedAt, results: newResults, counts: newCounts,
      });
      const cutoff = new Date(Date.now() - KEEP_SCANS_DAYS * 86400000).toISOString();
      await supabase.from('stock_scans').delete().eq('scan_mode', mode).lt('scanned_at', cutoff);
    } catch (err) {
      setError(`Stock scan failed — showing previous results. (${err instanceof Error ? err.message : String(err)})`);
      if (autoLoadRef.current) {
        autoErrorsRef.current += 1;
        if (autoErrorsRef.current >= AUTO_LOAD_MAX_ERRORS) {
          autoLoadRef.current = false;
          setAutoLoadState(false);
          setNextAutoScanAt(null);
        } else {
          setNextAutoScanAt(Date.now() + AUTO_LOAD_INTERVAL_MS);
        }
      }
    } finally {
      setScanning(false);
    }
  }, [profile, scanning, scanMode, universeSymbols]);

  // Always call the latest runScan from the timer.
  const runScanRef = useRef(runScan);
  useEffect(() => { runScanRef.current = runScan; }, [runScan]);

  // Countdown → automatic Rescan.
  useEffect(() => {
    if (nextAutoScanAt == null) { setSecondsToNextScan(null); return; }
    const tick = () => {
      const remaining = Math.ceil((nextAutoScanAt - Date.now()) / 1000);
      if (remaining <= 0) {
        setNextAutoScanAt(null);
        setSecondsToNextScan(null);
        if (autoLoadRef.current) void runScanRef.current();
      } else {
        setSecondsToNextScan(remaining);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [nextAutoScanAt]);

  const setAutoLoad = useCallback((on: boolean) => {
    autoLoadRef.current = on;
    autoErrorsRef.current = 0;
    setAutoLoadState(on);
    setNextAutoScanAt(null);
    if (on && !scanning) void runScanRef.current();
  }, [scanning]);

  // Switching Discovery / Universe stops auto-loading.
  const changeScanMode = useCallback((mode: StockScanMode) => {
    autoLoadRef.current = false;
    setAutoLoadState(false);
    setNextAutoScanAt(null);
    setScanMode(mode);
  }, []);

  return {
    loaded,
    autoLoad,
    setAutoLoad,
    secondsToNextScan,
    profile,
    saveProfile,
    scanMode,
    setScanMode: changeScanMode,
    results: results[scanMode],
    counts: counts[scanMode],
    lastScanAt: lastScanAt[scanMode],
    scanning,
    error,
    notice,
    runScan,
  };
}

export type StockScannerState = ReturnType<typeof useStockScanner>;
