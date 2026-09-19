import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { scanCandidatesLive, analyzeTicker } from '@/lib/liveMarketData';
import { calcNetProfit, calcCroiFromCollateral, calcPremiumCapture, calcDaysOpen, annualizedReturn } from '@/lib/calculations';
import type {
  StrategyProfile,
  CandidateScan,
  OpenPosition,
  ClosedPosition,
  DailyScanResult,
  Alert,
} from '@/types';
import type { AnalyzeTickerResponse } from '@/lib/liveMarketData';

const DEFAULT_PROFILE: Omit<StrategyProfile, 'id' | 'created_at' | 'updated_at'> = {
  name: 'My CSP Default',
  is_default: true,
  order_type: 'LIMIT',
  max_strike: 25,
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
  min_dte: 365,
  max_dte: 550,
  preferred_expirations: [],
  min_strike: null,
  preferred_strikes: [],
  order_strike_enabled: true,
  expiration_enabled: true,
  croi_pc_enabled: true,
  cycle_liquidity_enabled: true,
  spread_enabled: true,
  short_interest_enabled: true,
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
    const { data, error } = await supabase
      .from('scan_universe')
      .select('symbol')
      .order('symbol');
    if (error) throw error;
    setScanUniverse((data || []).map((r: any) => r.symbol as string));
  }, []);

  const addToScanUniverse = useCallback(async (symbol: string) => {
    const sym = symbol.toUpperCase().trim();
    if (!sym) return;
    const { error } = await supabase
      .from('scan_universe')
      .insert({ symbol: sym });
    if (error && error.code !== '23505') throw error;
    setScanUniverse((prev) => prev.includes(sym) ? prev : [...prev, sym].sort());
  }, []);

  const removeFromScanUniverse = useCallback(async (symbol: string) => {
    const sym = symbol.toUpperCase().trim();
    await supabase.from('scan_universe').delete().eq('symbol', sym);
    setScanUniverse((prev) => prev.filter((s) => s !== sym));
  }, []);

  const runAnalyzeTicker = useCallback(async (ticker: string) => {
    if (!activeProfile || analyzing) return;
    const sym = ticker.toUpperCase().trim();
    if (!sym) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeResult(null);
    try {
      const result = await analyzeTicker(sym, activeProfile);
      setAnalyzeResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Analyze ticker failed';
      setAnalyzeError(msg);
      console.error('Analyze ticker failed:', err);
    } finally {
      setAnalyzing(false);
    }
  }, [activeProfile, analyzing]);

  const runScan = useCallback(async () => {
    if (!activeProfile || scanning) return;

    setScanning(true);
    setScanError(null);

    try {
      const openTickers = openPositions.map((p) => p.ticker.toUpperCase());
      let results: CandidateScan[];
      let scannedAt = new Date().toISOString();

      try {
        const live = await scanCandidatesLive(activeProfile, openTickers);
        results = live.candidates;
        scannedAt = live.scanned_at || scannedAt;
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
        suggested_sto: r.suggested_sto,
        suggested_btc: r.suggested_btc,
        net_profit: r.net_profit,
        net_croi: r.net_croi,
        premium_capture: r.premium_capture,
        breakeven: r.breakeven,
        qualified: r.qualified,
        rejection_reasons: r.rejection_reasons,
        strategy_profile_id: activeProfile.id,
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
  }, [activeProfile, openPositions, scanning]);

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

  const resetProfile = useCallback(() => {
    if (activeProfile) {
      setActiveProfile({ ...activeProfile, ...DEFAULT_PROFILE, id: activeProfile.id, name: activeProfile.name });
    }
  }, [activeProfile]);

  return {
    profiles,
    activeProfile,
    setActiveProfile,
    candidates,
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
    addToScanUniverse,
    removeFromScanUniverse,
    analyzing,
    analyzeResult,
    analyzeError,
    runAnalyzeTicker,
  };
}

export type AppState = ReturnType<typeof useAppState>;
