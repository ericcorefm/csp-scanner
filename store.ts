import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { scanCandidatesLive, analyzeTicker } from '@/lib/liveMarketData';
import { selectBestContractPerTicker } from '@/lib/bestContract';
import { isQualified, isPending, isRejected, PREMIUM_PENDING_REASON } from '@/lib/status';
import { populateFromAnalyzeResponse, fetchTechnicalSnapshot, mergeCandidateWithTechnical, getCachedTechnical, getCachedStockPrice, populateStockPricesFromCandidates, fetchCachedBars, type TechFetchError } from '@/lib/technicalCache';
import { calcNetProfit, calcCroiFromCollateral, calcPremiumCapture, calcDaysOpen, annualizedReturn, formatLocalDate } from '@/lib/calculations';
import type {
  StrategyProfile,
  CandidateScan,
  OpenPosition,
  ClosedPosition,
  DailyScanResult,
  Alert,
} from '@/types';
import type { AnalyzeTickerResponse, ScanCounts, ScanMode } from '@/lib/liveMarketData';
import type { ScanUniverseEntry } from '@/types';

function formatDataError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as {
      message?: string;
      details?: string;
      hint?: string;
      code?: string;
    };
    const parts = [
      e.message,
      e.details ? `details: ${e.details}` : null,
      e.hint ? `hint: ${e.hint}` : null,
      e.code ? `code: ${e.code}` : null,
    ].filter(Boolean);
    if (parts.length) return parts.join(' | ');
  }
  return String(err ?? 'Unknown database error');
}

const DEFAULT_PROFILE: Omit<StrategyProfile, 'id' | 'created_at' | 'updated_at'> = {
  name: 'My CSP Default',
  is_default: true,
  max_strike: null,
  max_strikes_per_ticker: 1,
  min_net_croi: 3.5,
  preferred_croi_max: null,
  max_premium_capture: 25,
  max_recycle_days: 120,
  min_target_oi: 1000,
  preferred_daily_volume: 25,
  preferred_spread_pct: 5,
  max_spread_pct: 10,
  rsi_min: null,
  rsi_max: null,
  require_ma20_above_ma50: false,
  require_ma50_above_ma200: false,
  require_price_above_ma200: false,
  short_interest_warning: 10,
  short_interest_exclusion: 20,
  round_trip_commission: 1.34,
  btc_increment: 0.05,
  allow_penny_increments: true,
  exclude_existing_positions: true,
  exclude_downtrend_no_support: false,
  minimum_support_distance_pct: null,
  maximum_support_distance_pct: null,
  support_distance_enabled: true,
  min_dte: 365,
  minimum_stock_price: null,
  maximum_stock_price: null,
  order_strike_enabled: true,
  expiration_enabled: true,
  croi_pc_enabled: true,
  filter_strikes_croi: true,
  cycle_liquidity_enabled: true,
  spread_enabled: true,
  short_interest_enabled: true,
  technical_rules_enabled: true,
};

export function useAppState() {
  const [profiles, setProfiles] = useState<StrategyProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<StrategyProfile | null>(null);
  const [candidates, setCandidates] = useState<CandidateScan[]>([]);

  // Per-mode result caches so switching tabs restores the last results for that mode
  // without overwriting the other mode's results or triggering a rescan.
  const [discoveryCandidates, setDiscoveryCandidates] = useState<CandidateScan[]>([]);
  const [universeCandidates, setUniverseCandidates] = useState<CandidateScan[]>([]);
  const [discoveryScanCounts, setDiscoveryScanCounts] = useState<ScanCounts | null>(null);
  const [universeScanCounts, setUniverseScanCounts] = useState<ScanCounts | null>(null);
  const [discoveryLastScanAt, setDiscoveryLastScanAt] = useState<string | null>(null);
  const [universeLastScanAt, setUniverseLastScanAt] = useState<string | null>(null);
  const [openPositions, setOpenPositions] = useState<OpenPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<ClosedPosition[]>([]);
  const [dailyResults, setDailyResults] = useState<DailyScanResult[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // Informational (non-error) message after a scan, e.g. history still loading.
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [scanSource, setScanSource] = useState<'live' | null>(null);
  const [positionsLoaded, setPositionsLoaded] = useState(false);
  const [scanUniverse, setScanUniverse] = useState<string[]>([]);
  const [scanUniverseEntries, setScanUniverseEntries] = useState<ScanUniverseEntry[]>([]);
  const [scanUniverseLoaded, setScanUniverseLoaded] = useState(false);
  const [scanCounts, setScanCounts] = useState<ScanCounts | null>(null);
  const [noFilterMode, setNoFilterMode] = useState(false);
  const [rawSample, setRawSample] = useState<unknown>(null);
  const [scanMode, setScanMode] = useState<ScanMode>('discovery');
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeTickerResponse | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [settingsChanged, setSettingsChanged] = useState(false);
  const [savedCandidatesLoaded, setSavedCandidatesLoaded] = useState(false);
  const [hasUniverseScanned, setHasUniverseScanned] = useState(false);

  const loadProfiles = useCallback(async () => {
    const { data, error } = await supabase
      .from('strategy_profiles')
      .select('*')
      .order('created_at');
    if (error) throw error;
    if (!data || data.length === 0) {
      const { data: newProfile } = await supabase
        .from('strategy_profiles')
        .insert(DEFAULT_PROFILE)
        .select()
        .single();
      if (newProfile) {
        setProfiles([newProfile as StrategyProfile]);
        setActiveProfile(newProfile as StrategyProfile);
      }
    } else {
      setProfiles(data as StrategyProfile[]);
      const def = (data as StrategyProfile[]).find((p) => p.is_default) || data[0];
      setActiveProfile(def);
    }
  }, []);

  const loadOpenPositions = useCallback(async () => {
    setPositionsLoaded(false);
    try {
      const { data, error } = await supabase
        .from('open_positions')
        .select('*')
        .order('open_date', { ascending: false });
      if (error) throw error;
      setOpenPositions((data || []) as OpenPosition[]);
    } finally {
      setPositionsLoaded(true);
    }
  }, []);

  const loadClosedPositions = useCallback(async () => {
    const { data, error } = await supabase
      .from('closed_positions')
      .select('*')
      .order('close_date', { ascending: false });
    if (error) throw error;
    setClosedPositions((data || []) as ClosedPosition[]);
  }, []);

  const loadDailyResults = useCallback(async () => {
    const { data, error } = await supabase
      .from('daily_scan_results')
      .select('*')
      .order('scan_date', { ascending: false })
      .limit(30);
    if (error) throw error;
    setDailyResults((data || []) as DailyScanResult[]);
  }, []);

  const loadAlerts = useCallback(async () => {
    const { data, error } = await supabase
      .from('alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    setAlerts((data || []) as Alert[]);
  }, []);

  const loadScanUniverse = useCallback(async () => {
    setScanUniverseLoaded(false);
    try {
      const { data, error } = await supabase
        .from('scan_universe')
        .select('*')
        .order('symbol');
      if (error) throw error;
      const entries = (data || []) as ScanUniverseEntry[];
      setScanUniverseEntries(entries);
      setScanUniverse(entries.filter((e) => e.enabled).map((e) => e.symbol));
    } finally {
      setScanUniverseLoaded(true);
    }
  }, []);

  const addToScanUniverse = useCallback(async (symbol: string, options?: { company_name?: string | null; source?: string }) => {
    const sym = symbol.toUpperCase().trim();
    if (!sym) return;
    const { error } = await supabase
      .from('scan_universe')
      .upsert(
        {
          symbol: sym,
          enabled: true,
          source: options?.source ?? 'manual',
          ...(options?.company_name ? { company_name: options.company_name } : {}),
        },
        { onConflict: 'symbol' },
      );
    if (error) {
      console.error('[addToScanUniverse] Supabase error:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
      throw error;
    }
    await loadScanUniverse();
  }, [loadScanUniverse]);

  const removeFromScanUniverse = useCallback(async (symbol: string) => {
    const sym = symbol.toUpperCase().trim();
    const { error } = await supabase.from('scan_universe').delete().eq('symbol', sym);
    if (error) throw error;
    await loadScanUniverse();
  }, [loadScanUniverse]);

  const removeFromScanUniverseBulk = useCallback(async (symbols: string[]) => {
    const clean = symbols.map((s) => s.toUpperCase().trim()).filter(Boolean);
    if (clean.length === 0) return;
    const { error } = await supabase.from('scan_universe').delete().in('symbol', clean);
    if (error) {
      console.error('[removeFromScanUniverseBulk] Supabase error:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
      throw error;
    }
    setScanUniverse((prev) => prev.filter((s) => !clean.includes(s)));
    setScanUniverseEntries((prev) => prev.filter((e) => !clean.includes(e.symbol)));
    await loadScanUniverse();
  }, [loadScanUniverse]);

  const toggleScanUniverseEnabled = useCallback(async (symbol: string, enabled: boolean) => {
    const sym = symbol.toUpperCase().trim();
    await supabase.from('scan_universe').update({ enabled }).eq('symbol', sym);
    await loadScanUniverse();
  }, [loadScanUniverse]);

  const clearScanUniverse = useCallback(async () => {
    const { error } = await supabase
      .from('scan_universe')
      .delete()
      .not('id', 'is', null);
    if (error) {
      console.error('[clearScanUniverse] Supabase error:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
      throw error;
    }
    setScanUniverse([]);
    setScanUniverseEntries([]);
    await loadScanUniverse();
  }, [loadScanUniverse]);

  const restoreDefaultUniverse = useCallback(async () => {
    const defaults = ['SOFI','CIFR','WULF','RIOT','RGTI','QBTS','RIVN','IREN','APLD'];
    for (const sym of defaults) {
      await supabase
        .from('scan_universe')
        .upsert({ symbol: sym, source: 'default', enabled: true }, { onConflict: 'symbol' });
    }
    await loadScanUniverse();
  }, [loadScanUniverse]);

  const runAnalyzeTicker = useCallback(async (ticker: string) => {
    if (!activeProfile || analyzing) return;
    const sym = ticker.toUpperCase().trim();
    if (!sym) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeResult(null);
    try {
      const cachedPrice = getCachedStockPrice(sym)?.price ?? null;
      const candidatePrice =
        candidates.find((c) => c.ticker.toUpperCase() === sym && c.stock_price != null && c.stock_price > 0)?.stock_price ?? null;
      const knownStockPrice = cachedPrice ?? candidatePrice;

      const openTickers = openPositions.map((p) => p.ticker.toUpperCase());
      const result = await analyzeTicker(sym, activeProfile, knownStockPrice, openTickers);
      populateFromAnalyzeResponse(result);
      // Warm bars cache so Analyze Ticker's chart loads instantly
      void fetchCachedBars(sym);
      setAnalyzeResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Analyze ticker failed';
      setAnalyzeError(msg);
      console.error('Analyze ticker failed:', err);
    } finally {
      setAnalyzing(false);
    }
  }, [activeProfile, analyzing, candidates, openPositions]);

  const clearAnalyzeResult = useCallback(() => {
    setAnalyzeResult(null);
    setAnalyzeError(null);
  }, []);

  const runScan = useCallback(async () => {
    if (!activeProfile || scanning || !positionsLoaded) return;

    // Reload enabled Scan Universe tickers fresh from the database instead of
    // relying on potentially stale React state.
    let universeSymbols: string[] = scanUniverse;
    if (scanMode === 'universe') {
      try {
        const { data: freshData, error: freshError } = await supabase
          .from('scan_universe')
          .select('symbol,enabled')
          .order('symbol');
        if (!freshError && freshData) {
          universeSymbols = (freshData as ScanUniverseEntry[])
            .filter((e) => e.enabled)
            .map((e) => e.symbol.toUpperCase().trim())
            .filter(Boolean);
          setScanUniverse(universeSymbols);
          setScanUniverseEntries((freshData as ScanUniverseEntry[]));
        }
      } catch {
        // fall back to stale state
      }
      console.log(`[UNIVERSE RESCAN] symbols=${JSON.stringify(universeSymbols)}`);
      if (universeSymbols.length === 0) {
        setScanError('No active tickers in Scan Universe. Go to Scan Universe to add or enable tickers, or switch to Market Discovery.');
        return;
      }
    }

    setScanning(true);
    setScanError(null);
    setScanNotice(null);
    setSettingsChanged(false);

    try {
      const openTickers = openPositions.map((p) => p.ticker.toUpperCase());
      let results: CandidateScan[];
      let scannedAt = new Date().toISOString();
      let newCounts: ScanCounts | null = null;
      let newNoFilter = false;
      let newRawSample: unknown = null;

      try {
        const liveResponse = await scanCandidatesLive(
          activeProfile,
          openTickers,
          scanMode,
          scanMode === 'universe' ? universeSymbols : undefined,
        );
        results = liveResponse.candidates;
        scannedAt = liveResponse.scanned_at || scannedAt;
        newCounts = liveResponse.scan_counts || null;
        newNoFilter = liveResponse.no_filter_mode || false;
        newRawSample = liveResponse.raw_sample || null;
      } catch (liveError) {
        const message = liveError instanceof Error
          ? liveError.message
          : 'scan failed.';
        const modeLabel = scanMode === 'universe' ? 'universe results' : 'results';
        setScanError(`Rescan failed — showing previous ${modeLabel}. (${message})`);
        setScanning(false);
        return;
      }

      setCandidates(results);
      setScanCounts(newCounts);
      {
        const cache = newCounts?.technical_cache;
        const stillPending = cache?.still_pending_history ?? 0;
        if (stillPending > 0) {
          const why = cache?.history_rate_limited
            ? 'Massive rate limit reached'
            : cache?.warming_time_budget_hit ? 'scan time budget reached' : 'history unavailable';
          setScanNotice(
            `${stillPending} ticker(s) are Pending because price history is still loading (${why}). ` +
            'Each Rescan backfills more; once loaded, history stays current automatically.',
          );
        }
      }
      setNoFilterMode(newNoFilter);
      setRawSample(newRawSample);

      // ── Debug: trace scan pipeline ──
      {
        const raw = results.length;
        const fullyQualified = results.filter(isQualified);
        const pending = results.filter(isPending);
        const rejected = results.filter(isRejected);
        const uniqueQualifiedTickers = new Set(fullyQualified.map((r) => r.ticker.toUpperCase()));
        const uniquePendingTickers = new Set(pending.map((r) => r.ticker.toUpperCase()));
        const bestByTicker = selectBestContractPerTicker(results, activeProfile?.max_strikes_per_ticker ?? 1);
        const displayedQualified = bestByTicker.filter(isQualified);
        console.log(`[SCAN PIPELINE] mode=${scanMode} raw=${raw} fullyQualified=${fullyQualified.length} pending=${pending.length} rejected=${rejected.length} qualifiedTickers=${uniqueQualifiedTickers.size} pendingTickers=${uniquePendingTickers.size} bestByTicker=${bestByTicker.length} displayedQualified=${displayedQualified.length}`);
        if (fullyQualified.length === 0 && raw > 0) {
          const reasonCounts = new Map<string, number>();
          for (const r of rejected) {
            for (const reason of (r.rejection_reasons || [])) {
              reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
            }
          }
          console.log(`[SCAN PIPELINE] No fully-qualified contracts. Rejection reasons:`, Object.fromEntries(reasonCounts));
        }
      }
      // Cache results per mode so switching tabs restores them
      if (scanMode === 'discovery') {
        setDiscoveryCandidates(results);
        setDiscoveryScanCounts(newCounts);
        setDiscoveryLastScanAt(scannedAt);
      } else {
        setUniverseCandidates(results);
        setUniverseScanCounts(newCounts);
        setUniverseLastScanAt(scannedAt);
        setHasUniverseScanned(true);
      }
      setScanSource('live');
      setLastScanAt(scannedAt);
      populateStockPricesFromCandidates(results);

      const today = new Date().toISOString().split('T')[0];

      // Persisting scan history is secondary. A successful live market scan
      // must remain visible even if the local Supabase cache/schema is stale.
      try {
        const { error: deleteError } = await supabase
          .from('candidate_scans')
          .delete()
          .eq('scan_date', today)
          .eq('strategy_profile_id', activeProfile.id)
          .eq('scan_mode', scanMode);
        if (deleteError) throw deleteError;

        // Persist only the display-worthy best contract(s) per ticker. Persisting every
        // rejected option in a large discovery scan created thousands of stale rows and
        // the startup loader's row limit could omit the actual qualified ticker.
        const persistedResults = selectBestContractPerTicker(
          results,
          activeProfile.max_strikes_per_ticker ?? 1,
        );

        // Persist only database-backed columns and normalize undefined -> null.
        const insertData = persistedResults.map((r) => ({
          scan_date: r.scan_date || today,
          ticker: r.ticker,
          company_name: r.company_name ?? null,
          stock_price: r.stock_price ?? null,
          strike: r.strike,
          expiration: r.expiration,
          dte: r.dte,
          bid: r.bid ?? 0,
          ask: r.ask ?? 0,
          mid: r.mid ?? 0,
          spread_pct: r.spread_pct ?? 0,
          iv: r.iv ?? 0,
          delta: r.delta ?? null,
          volume: r.volume ?? 0,
          open_interest: r.open_interest ?? 0,
          volume_classification: r.volume_classification ?? null,
          trend_classification: r.trend_classification ?? null,
          primary_support: r.primary_support ?? null,
          secondary_support: r.secondary_support ?? null,
          resistance: r.resistance ?? null,
          suggested_sto: r.suggested_sto ?? null,
          suggested_btc: r.suggested_btc ?? null,
          net_profit: r.net_profit ?? null,
          net_croi: r.net_croi ?? null,
          premium_capture: r.premium_capture ?? null,
          breakeven: r.breakeven ?? null,
          qualified: Boolean(r.qualified),
          technical_pending: Boolean(r.technical_pending),
          rejection_reasons: Array.isArray(r.rejection_reasons) ? r.rejection_reasons : [],
          pending_reasons: Array.isArray(r.pending_reasons) ? r.pending_reasons : [],
          pass_fail: Array.isArray(r.pass_fail) ? r.pass_fail : [],
          strategy_profile_id: activeProfile.id,
          strike_distance_from_stock: r.strike_distance_from_stock ?? null,
          strike_distance_from_support: r.strike_distance_from_support ?? null,
          has_quotes: Boolean(r.has_quotes),
          stock_source: r.stock_source ?? null,
          premium_source: r.premium_source ?? null,
          scan_mode: scanMode,
        }));

        if (insertData.length > 0) {
          const { error: insertError } = await supabase
            .from('candidate_scans')
            .insert(insertData);
          if (insertError) throw insertError;
        }
      } catch (persistError) {
        const detail = formatDataError(persistError);
        console.error('Scan completed, but candidate_scans persistence failed:', persistError);
        setScanError(`Scan completed, but saving scan history failed: ${detail}`);
      }

      // NOTE: a scan never modifies the Scan Universe. It previously disabled
      // every ticker that did not qualify, so turning on stricter rules
      // permanently shrank the universe and results never came back after
      // relaxing the settings.
    } catch (err) {
      const message = formatDataError(err);
      const modeLabel = scanMode === 'universe' ? 'universe results' : 'results';
      setScanError(`Rescan failed — showing previous ${modeLabel}. (${message})`);
      console.error('Rescan failed:', err);
    } finally {
      setScanning(false);
    }
  }, [activeProfile, openPositions, scanning, positionsLoaded, scanMode, scanUniverse]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      await loadProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [loadProfiles]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (activeProfile) {
      loadOpenPositions();
      loadClosedPositions();
      loadDailyResults();
      loadAlerts();
      loadScanUniverse();
    }
  }, [activeProfile, loadOpenPositions, loadClosedPositions, loadDailyResults, loadAlerts, loadScanUniverse]);

  // On startup or profile change: load the most recent saved scan results from
  // Supabase. Do NOT automatically call market-scan — the user must click Rescan.
  const loadSavedCandidates = useCallback(async (profileId: string, mode: ScanMode = 'discovery') => {
    try {
      const { data, error } = await supabase
        .from('candidate_scans')
        .select('*')
        .eq('strategy_profile_id', profileId)
        .eq('scan_mode', mode)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      const rows = (data || []) as CandidateScan[];
      if (rows.length > 0) {
        // Only restore the most recent scan batch. Mixing older scan dates into
        // the current table caused stale candidates to reappear after reload.
        const latestScanDate = rows[0].scan_date;
        const latestRows = latestScanDate
          ? rows.filter((row) => row.scan_date === latestScanDate)
          : rows;

        // Deduplicate by ticker-strike-expiration, keeping the newest.
        const seen = new Set<string>();
        const deduped: CandidateScan[] = [];
        for (const row of latestRows) {
          const key = `${row.ticker}-${row.strike}-${row.expiration}`;
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(row);
          }
        }
        // Preserve the last saved scan exactly as it was evaluated.
        // Settings changes are applied only on the next manual Rescan; partially
        // re-evaluating persisted rows here caused stale rejection reasons and
        // inconsistent status after relaxing a rule.
        const filtered = deduped;
        if (mode === 'discovery') {
          setDiscoveryCandidates(filtered);
          setDiscoveryLastScanAt(latestRows[0].scan_date || latestRows[0].created_at || null);
        } else {
          setUniverseCandidates(filtered);
          setUniverseLastScanAt(latestRows[0].scan_date || latestRows[0].created_at || null);
          setHasUniverseScanned(true);
        }
        // Only set the visible candidates if this is the current mode
        if (scanMode === mode) {
          setCandidates(filtered);
          setLastScanAt(latestRows[0].scan_date || latestRows[0].created_at || null);
          setScanSource(null);
        }
        populateStockPricesFromCandidates(deduped);
      }
      setSavedCandidatesLoaded(true);
    } catch (err) {
      console.error('loadSavedCandidates failed:', err);
      setSavedCandidatesLoaded(true);
    }
  }, [scanMode]);

  useEffect(() => {
    if (activeProfile && positionsLoaded) {
      void loadSavedCandidates(activeProfile.id, 'discovery');
      void loadSavedCandidates(activeProfile.id, 'universe');
      setSettingsChanged(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile?.id, positionsLoaded]);

  const saveProfile = useCallback(async (profile: StrategyProfile) => {
    const { data, error } = await supabase
      .from('strategy_profiles')
      .upsert({ ...profile, updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw error;
    const updated = data as StrategyProfile;
    setProfiles((prev) => {
      const idx = prev.findIndex((p) => p.id === updated.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = updated;
        return next;
      }
      return [...prev, updated];
    });
    setActiveProfile(updated);
    setSettingsChanged(true);
    return updated;
  }, []);

  const duplicateProfile = useCallback(async (profile: StrategyProfile): Promise<StrategyProfile> => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, created_at, updated_at, ...rest } = profile;
    const { data, error } = await supabase
      .from('strategy_profiles')
      .insert({ ...rest, name: `${profile.name} (Copy)`, is_default: false })
      .select()
      .single();
    if (error) throw error;
    const newProfile = data as StrategyProfile;
    setProfiles((prev) => [...prev, newProfile]);
    return newProfile;
  }, []);

  const createProfile = useCallback(async (name: string): Promise<StrategyProfile> => {
    const { data, error } = await supabase
      .from('strategy_profiles')
      .insert({ ...DEFAULT_PROFILE, name, is_default: false })
      .select()
      .single();
    if (error) throw error;
    const newProfile = data as StrategyProfile;
    setProfiles((prev) => [...prev, newProfile]);
    return newProfile;
  }, []);

  const deleteProfile = useCallback(async (id: string) => {
    if (profiles.length <= 1) throw new Error('Cannot delete the last profile');
    await supabase.from('strategy_profiles').delete().eq('id', id);
    setProfiles((prev) => {
      const next = prev.filter((p) => p.id !== id);
      if (activeProfile?.id === id && next.length > 0) {
        setActiveProfile(next[0]);
      }
      return next;
    });
  }, [profiles, activeProfile]);

  const addOpenPosition = useCallback(async (pos: Partial<OpenPosition>) => {
    const { data, error } = await supabase
      .from('open_positions')
      .insert(pos)
      .select()
      .single();
    if (error) throw error;
    const newPos = data as OpenPosition;
    setOpenPositions((prev) => [newPos, ...prev]);
    return newPos;
  }, []);

  const updateOpenPosition = useCallback(async (id: string, updates: Partial<OpenPosition>) => {
    const { data, error } = await supabase
      .from('open_positions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    const updated = data as OpenPosition;
    setOpenPositions((prev) => prev.map((p) => (p.id === id ? updated : p)));
    return updated;
  }, []);

  const deleteOpenPosition = useCallback(async (id: string) => {
    await supabase.from('open_positions').delete().eq('id', id);
    setOpenPositions((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const closePosition = useCallback(async (pos: OpenPosition, btcPrice: number) => {
    const netProfit = calcNetProfit(pos.actual_sto, btcPrice, pos.contracts, activeProfile?.round_trip_commission ?? 1.34);
    const netCroi = calcCroiFromCollateral(netProfit, pos.strike, pos.contracts);
    const pc = calcPremiumCapture(pos.actual_sto, btcPrice);
    const daysInTrade = calcDaysOpen(pos.open_date);
    const annRet = annualizedReturn(netCroi, daysInTrade);

    const closedPos: Partial<ClosedPosition> = {
      ticker: pos.ticker,
      company_name: pos.company_name,
      strike: pos.strike,
      contracts: pos.contracts,
      sto_price: pos.actual_sto,
      btc_price: btcPrice,
      net_profit: parseFloat(netProfit.toFixed(2)),
      net_croi: parseFloat(netCroi.toFixed(2)),
      premium_capture: parseFloat(pc.toFixed(1)),
      days_in_trade: daysInTrade,
      annualized_return: parseFloat(annRet.toFixed(1)),
      open_date: pos.open_date,
      close_date: formatLocalDate(new Date()),
    };

    const { data, error } = await supabase
      .from('closed_positions')
      .insert(closedPos)
      .select()
      .single();
    if (error) throw error;

    await deleteOpenPosition(pos.id!);
    setClosedPositions((prev) => [data as ClosedPosition, ...prev]);
    return data as ClosedPosition;
  }, [deleteOpenPosition, activeProfile]);

  const resetProfile = useCallback(async (): Promise<StrategyProfile | null> => {
    if (!activeProfile) return null;
    const resetData = { ...activeProfile, ...DEFAULT_PROFILE, id: activeProfile.id, name: activeProfile.name, updated_at: new Date().toISOString() };
    const { data, error } = await supabase
      .from('strategy_profiles')
      .upsert(resetData)
      .select()
      .single();
    if (error) throw error;
    const updated = data as StrategyProfile;
    setActiveProfile(updated);
    setSettingsChanged(true);
    setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    return updated;
  }, [activeProfile]);

  const updateCandidateWithQuote = useCallback((rowKey: string, updates: Partial<CandidateScan>) => {
    const profile = activeProfile;
    // Re-evaluate ONLY the premium-dependent rules (CROI/PC, spread) with the
    // manual quote, using the same rules as the edge function. Every other
    // reason from the scan is kept as-is.
    const reevaluate = (c: CandidateScan): CandidateScan => {
      const next: CandidateScan = { ...c, ...updates };
      if (!profile) return next;
      const croiRuleOn = profile.croi_pc_enabled !== false && profile.filter_strikes_croi;
      const spreadRuleOn = profile.spread_enabled !== false;
      const rejections = (c.rejection_reasons || []).filter((r) => r !== 'CROI too low' && r !== 'Spread too wide');
      const pending = (c.pending_reasons || []).filter((r) => r !== PREMIUM_PENDING_REASON);
      if (croiRuleOn) {
        const croiOk = next.suggested_btc > 0 && next.net_croi >= profile.min_net_croi && next.premium_capture <= profile.max_premium_capture;
        if (!croiOk) rejections.push('CROI too low');
      }
      if (spreadRuleOn && next.bid > 0 && next.ask >= next.bid && next.spread_pct > profile.max_spread_pct) {
        rejections.push('Spread too wide');
      }
      const technicalPending = rejections.length === 0 && pending.length > 0;
      return {
        ...next,
        rejection_reasons: rejections,
        pending_reasons: pending,
        technical_pending: technicalPending,
        qualified: rejections.length === 0 && pending.length === 0,
      };
    };
    const apply = (list: CandidateScan[]) => list.map((c) =>
      `${c.ticker}-${c.strike}-${c.expiration}` === rowKey ? reevaluate(c) : c,
    );
    setCandidates(apply);
    if (scanMode === 'discovery') setDiscoveryCandidates(apply);
    else setUniverseCandidates(apply);
  }, [scanMode, activeProfile]);

  const refreshCandidateTechnical = useCallback(async (ticker: string): Promise<{ ok: boolean; error: TechFetchError | null }> => {
    if (!activeProfile) return { ok: false, error: 'error' };
    const sym = ticker.toUpperCase().trim();
    const t0 = Date.now();
    console.log(`[PERF] ${sym} candidate detail opened`);

    const cached = getCachedTechnical(sym);
    if (cached) {
      console.log(`[PERF] ${sym} cache hit (${Date.now() - t0}ms)`);
      const merge = (prev: CandidateScan[]) => prev.map((c) =>
        c.ticker === sym ? mergeCandidateWithTechnical(c, cached) : c,
      );
      setCandidates(merge);
      if (scanMode === 'discovery') setDiscoveryCandidates(merge); else setUniverseCandidates(merge);
      // Warm bars cache in background so chart loads instantly
      void fetchCachedBars(sym);
      return { ok: true, error: null };
    }

    console.log(`[PERF] ${sym} cache miss — history request started`);
    const snap = await fetchTechnicalSnapshot(sym, activeProfile);
    if (!snap) return { ok: false, error: 'error' };

    const merge = (prev: CandidateScan[]) => prev.map((c) =>
      c.ticker === sym ? mergeCandidateWithTechnical(c, snap) : c,
    );
    setCandidates(merge);
    if (scanMode === 'discovery') setDiscoveryCandidates(merge); else setUniverseCandidates(merge);
    console.log(`[PERF] ${sym} technical calculations done (${Date.now() - t0}ms)`);
    return { ok: true, error: null };
  }, [activeProfile, scanMode]);

  return {
    profiles,
    activeProfile,
    setActiveProfile: (p: StrategyProfile | null) => {
      setActiveProfile(p);
      setSettingsChanged(true);
    },
    candidates,
    updateCandidateWithQuote,
    openPositions,
    closedPositions,
    dailyResults,
    alerts,
    loading,
    error,
    scanning,
    scanError,
    scanNotice,
    lastScanAt,
    scanSource,
    runScan,
    saveProfile,
    duplicateProfile,
    createProfile,
    deleteProfile,
    addOpenPosition,
    updateOpenPosition,
    deleteOpenPosition,
    closePosition,
    resetProfile,
    scanUniverse,
    scanUniverseLoaded,
    scanUniverseEntries,
    addToScanUniverse,
    removeFromScanUniverse,
    removeFromScanUniverseBulk,
    toggleScanUniverseEnabled,
    clearScanUniverse,
    restoreDefaultUniverse,
    reloadScanUniverse: loadScanUniverse,
    scanMode,
    setScanMode: (m: ScanMode) => {
      // Before switching away, cache the current mode's results
      if (scanMode === 'discovery') {
        setDiscoveryCandidates(candidates);
        setDiscoveryScanCounts(scanCounts);
        setDiscoveryLastScanAt(lastScanAt);
      } else {
        setUniverseCandidates(candidates);
        setUniverseScanCounts(scanCounts);
        setUniverseLastScanAt(lastScanAt);
      }
      // Restore the incoming mode's cached results (may be empty on first switch)
      if (m === 'discovery') {
        setCandidates(discoveryCandidates);
        setScanCounts(discoveryScanCounts);
        setLastScanAt(discoveryLastScanAt);
      } else {
        setCandidates(universeCandidates);
        setScanCounts(universeScanCounts);
        setLastScanAt(universeLastScanAt);
      }
      setScanMode(m);
    },
    scanCounts,
    noFilterMode,
    rawSample,
    analyzing,
    analyzeResult,
    analyzeError,
    runAnalyzeTicker,
    clearAnalyzeResult,
    refreshCandidateTechnical,
    settingsChanged,
    savedCandidatesLoaded,
    hasUniverseScanned,
    universeCandidates,
  };
}

export type AppState = ReturnType<typeof useAppState>;
