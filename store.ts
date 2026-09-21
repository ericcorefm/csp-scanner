import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { scanCandidatesLive, analyzeTicker } from '@/lib/liveMarketData';
import { populateFromAnalyzeResponse, fetchTechnicalSnapshot, mergeCandidateWithTechnical, getCachedTechnical, getCachedStockPrice, populateStockPricesFromCandidates } from '@/lib/technicalCache';
import { calcNetProfit, calcCroiFromCollateral, calcPremiumCapture, calcDaysOpen, annualizedReturn } from '@/lib/calculations';
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

const DEFAULT_PROFILE: Omit<StrategyProfile, 'id' | 'created_at' | 'updated_at'> = {
  name: 'My CSP Default',
  is_default: true,
  max_strike: 25,
  max_strikes_per_ticker: 1,
  min_net_croi: 3.5,
  preferred_croi_max: 4.0,
  max_premium_capture: 25,
  max_recycle_days: 120,
  min_target_oi: 1000,
  preferred_daily_volume: 25,
  preferred_spread_pct: 5,
  max_spread_pct: 10,
  rsi_min: 40,
  rsi_max: 60,
  require_ma20_above_ma50: false,
  require_ma50_above_ma200: false,
  require_price_above_ma200: true,
  short_interest_warning: 10,
  short_interest_exclusion: 20,
  round_trip_commission: 1.34,
  btc_increment: 0.05,
  allow_penny_increments: true,
  exclude_existing_positions: true,
  exclude_downtrend_no_support: true,
  minimum_support_distance_pct: 15,
  maximum_support_distance_pct: 50,
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
  const [openPositions, setOpenPositions] = useState<OpenPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<ClosedPosition[]>([]);
  const [dailyResults, setDailyResults] = useState<DailyScanResult[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
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

  const loadProfiles = useCallback(async () => {
    const { data, error } = await supabase
      .from('strategy_profiles')
      .select('*')
      .order('created_at');
    if (error) throw error;
    if (!data || data.length === 0) {
      const { data: newProfile, error: insertError } = await supabase
        .from('strategy_profiles')
        .insert(DEFAULT_PROFILE)
        .select()
        .single();
      if (insertError) {
        throw new Error(`Unable to create default strategy profile: ${insertError.message}`);
      }
      if (!newProfile) {
        throw new Error('Unable to create default strategy profile: no row returned');
      }
      setProfiles([newProfile as StrategyProfile]);
      setActiveProfile(newProfile as StrategyProfile);
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
    if (error && error.code !== '23505') throw error;
    await loadScanUniverse();
  }, [loadScanUniverse]);

  const removeFromScanUniverse = useCallback(async (symbol: string) => {
    const sym = symbol.toUpperCase().trim();
    await supabase.from('scan_universe').delete().eq('symbol', sym);
    await loadScanUniverse();
  }, [loadScanUniverse]);

  const toggleScanUniverseEnabled = useCallback(async (symbol: string, enabled: boolean) => {
    const sym = symbol.toUpperCase().trim();
    await supabase.from('scan_universe').update({ enabled }).eq('symbol', sym);
    await loadScanUniverse();
  }, [loadScanUniverse]);

  const clearScanUniverse = useCallback(async () => {
    await supabase.from('scan_universe').delete().neq('id', '00000000-0000-0000-0000-000000000000');
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

      const result = await analyzeTicker(sym, activeProfile, knownStockPrice);
      populateFromAnalyzeResponse(result);
      setAnalyzeResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Analyze ticker failed';
      setAnalyzeError(msg);
      console.error('Analyze ticker failed:', err);
    } finally {
      setAnalyzing(false);
    }
  }, [activeProfile, analyzing, candidates]);

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
      if (universeSymbols.length === 0) {
        setScanError('No active tickers in Scan Universe. Go to Scan Universe to add or enable tickers, or switch to Market Discovery.');
        return;
      }
    }

    setScanning(true);
    setScanError(null);

    try {
      const openTickers = openPositions.map((p) => p.ticker.toUpperCase());
      let results: CandidateScan[];
      let scannedAt = new Date().toISOString();

      try {
        const live = await scanCandidatesLive(
          activeProfile,
          openTickers,
          scanMode,
          scanMode === 'universe' ? universeSymbols : undefined,
        );
        results = live.candidates;
        scannedAt = live.scanned_at || scannedAt;
        setScanCounts(live.scan_counts || null);
        setNoFilterMode(live.no_filter_mode || false);
        setRawSample(live.raw_sample || null);
      } catch (liveError) {
        const message = liveError instanceof Error
          ? `Massive API error: ${liveError.message}`
          : 'Massive API error: scan failed.';
        setScanError(message);
        setScanning(false);
        return;
      }

      setCandidates(results);
      setScanSource('live');
      setLastScanAt(scannedAt);
      populateStockPricesFromCandidates(results);

      const today = new Date().toISOString().split('T')[0];
      const { error: deleteError } = await supabase
        .from('candidate_scans')
        .delete()
        .eq('scan_date', today)
        .eq('strategy_profile_id', activeProfile.id);
      if (deleteError) throw deleteError;

      // IMPORTANT: map only database columns. CandidateScan also contains UI-only
      // strike-distance fields that are not columns in candidate_scans. Spreading
      // the whole object caused PostgREST inserts to fail during Rescan.
      const insertData = results.map((r) => ({
        scan_date: r.scan_date,
        ticker: r.ticker,
        company_name: r.company_name,
        stock_price: r.stock_price,
        strike: r.strike,
        expiration: r.expiration,
        dte: r.dte,
        bid: r.bid,
        ask: r.ask,
        mid: r.mid,
        spread_pct: r.spread_pct,
        iv: r.iv,
        delta: r.delta,
        volume: r.volume,
        open_interest: r.open_interest,
        volume_classification: r.volume_classification,
        trend_classification: r.trend_classification,
        primary_support: r.primary_support,
        secondary_support: r.secondary_support ?? null,
        resistance: r.resistance ?? null,
        suggested_sto: r.suggested_sto,
        suggested_btc: r.suggested_btc,
        net_profit: r.net_profit,
        net_croi: r.net_croi,
        premium_capture: r.premium_capture,
        breakeven: r.breakeven,
        qualified: r.qualified,
        rejection_reasons: r.rejection_reasons,
        strategy_profile_id: activeProfile.id,
        strike_distance_from_stock: r.strike_distance_from_stock ?? null,
        strike_distance_from_support: r.strike_distance_from_support ?? null,
        has_quotes: r.has_quotes,
        stock_source: r.stock_source ?? null,
        premium_source: r.premium_source ?? null,
      }));

      if (insertData.length > 0) {
        const { error: insertError } = await supabase.from('candidate_scans').insert(insertData);
        if (insertError) throw insertError;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rescan failed';
      setScanError(message);
      console.error('Rescan failed:', err);
    } finally {
      setScanning(false);
    }
  }, [activeProfile, openPositions, scanning, positionsLoaded, scanMode, scanUniverse.length]);

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

  useEffect(() => {
    if (activeProfile && positionsLoaded && candidates.length === 0 && !scanning) {
      void runScan();
    }
    // Wait for open positions so the first scan can correctly exclude existing contracts.
    // Market Discovery mode does not require scan_universe to be loaded.
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
    return updated;
  }, []);

  const duplicateProfile = useCallback(async (profile: StrategyProfile): Promise<StrategyProfile> => {
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
    const netProfit = calcNetProfit(pos.actual_sto, btcPrice, pos.contracts, 1.34);
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
      close_date: new Date().toISOString().split('T')[0],
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
  }, [deleteOpenPosition]);

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
    setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    return updated;
  }, [activeProfile]);

  const updateCandidateWithQuote = useCallback((rowKey: string, updates: Partial<CandidateScan>) => {
    setCandidates((prev) => prev.map((c) => {
      const key = `${c.ticker}-${c.strike}-${c.expiration}`;
      return key === rowKey ? { ...c, ...updates } : c;
    }));
  }, []);

  const refreshCandidateTechnical = useCallback(async (ticker: string): Promise<boolean> => {
    if (!activeProfile) return false;
    const sym = ticker.toUpperCase().trim();

    const cached = getCachedTechnical(sym);
    if (cached) {
      setCandidates((prev) => prev.map((c) =>
        c.ticker === sym ? mergeCandidateWithTechnical(c, cached) : c,
      ));
      return true;
    }

    const snap = await fetchTechnicalSnapshot(sym, activeProfile);
    if (!snap) return false;

    setCandidates((prev) => prev.map((c) =>
      c.ticker === sym ? mergeCandidateWithTechnical(c, snap) : c,
    ));
    return true;
  }, [activeProfile]);

  return {
    profiles,
    activeProfile,
    setActiveProfile,
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
    toggleScanUniverseEnabled,
    clearScanUniverse,
    restoreDefaultUniverse,
    reloadScanUniverse: loadScanUniverse,
    scanMode,
    setScanMode,
    scanCounts,
    noFilterMode,
    rawSample,
    analyzing,
    analyzeResult,
    analyzeError,
    runAnalyzeTicker,
    clearAnalyzeResult,
    refreshCandidateTechnical,
  };
}

export type AppState = ReturnType<typeof useAppState>;
