import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { StockUniverseEntry, StockPosition, StockQuote, NewStockPosition } from '@/lib/stockTypes';

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

/**
 * Stocks watchlist (stock_universe) and stock trades (stock_positions).
 * Completely separate from the CSP scan_universe / positions tables.
 */
export function useStockPortfolio() {
  const [universe, setUniverse] = useState<StockUniverseEntry[]>([]);
  const [positions, setPositions] = useState<StockPosition[]>([]);
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({});
  const [quotesLoading, setQuotesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUniverse = useCallback(async () => {
    const { data, error: e } = await supabase.from('stock_universe').select('*').order('symbol');
    if (e) { setError(`Stock universe: ${e.message}`); return; }
    setUniverse((data || []) as StockUniverseEntry[]);
  }, []);

  const loadPositions = useCallback(async () => {
    const { data, error: e } = await supabase.from('stock_positions').select('*').order('entry_date', { ascending: false });
    if (e) { setError(`Stock positions: ${e.message}`); return; }
    setPositions(((data || []) as StockPosition[]).map((p) => ({
      ...p,
      entry_price: Number(p.entry_price), shares: Number(p.shares),
      target_price: p.target_price == null ? null : Number(p.target_price),
      stop_price: p.stop_price == null ? null : Number(p.stop_price),
      exit_price: p.exit_price == null ? null : Number(p.exit_price),
    })));
  }, []);

  useEffect(() => { void loadUniverse(); void loadPositions(); }, [loadUniverse, loadPositions]);

  // ── Universe ──
  const addToUniverse = useCallback(async (raw: string, companyName?: string | null) => {
    const symbols = [...new Set(raw.toUpperCase().split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
    const valid = symbols.filter((s) => TICKER_RE.test(s));
    const invalid = symbols.filter((s) => !TICKER_RE.test(s));
    const existing = new Set(universe.map((u) => u.symbol));
    const fresh = valid.filter((s) => !existing.has(s));
    if (fresh.length) {
      const { error: e } = await supabase.from('stock_universe').insert(
        fresh.map((symbol) => ({ symbol, company_name: fresh.length === 1 ? companyName ?? null : null })),
      );
      if (e) return { added: 0, skipped: valid.length - fresh.length, invalid, error: e.message };
      await loadUniverse();
    }
    return { added: fresh.length, skipped: valid.length - fresh.length, invalid, error: null as string | null };
  }, [universe, loadUniverse]);

  const setUniverseEnabled = useCallback(async (ids: string[], enabled: boolean) => {
    if (!ids.length) return;
    setUniverse((prev) => prev.map((u) => (ids.includes(u.id) ? { ...u, enabled } : u)));
    const { error: e } = await supabase.from('stock_universe').update({ enabled }).in('id', ids);
    if (e) { setError(e.message); await loadUniverse(); }
  }, [loadUniverse]);

  const removeAllFromUniverse = useCallback(async () => {
    const ids = universe.map((u) => u.id);
    if (!ids.length) return;
    setUniverse([]);
    const { error: e } = await supabase.from('stock_universe').delete().in('id', ids);
    if (e) { setError(e.message); await loadUniverse(); }
  }, [universe, loadUniverse]);

  const removeFromUniverse = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    setUniverse((prev) => prev.filter((u) => !ids.includes(u.id)));
    const { error: e } = await supabase.from('stock_universe').delete().in('id', ids);
    if (e) { setError(e.message); await loadUniverse(); }
  }, [loadUniverse]);

  // ── Positions ──
  const addPosition = useCallback(async (p: NewStockPosition) => {
    const { error: e } = await supabase.from('stock_positions').insert({ ...p, ticker: p.ticker.toUpperCase(), status: 'open' });
    if (e) return { ok: false, error: e.message };
    await loadPositions();
    return { ok: true, error: null as string | null };
  }, [loadPositions]);

  const closePosition = useCallback(async (id: string, exitPrice: number, exitDate: string) => {
    const { error: e } = await supabase.from('stock_positions')
      .update({ status: 'closed', exit_price: exitPrice, exit_date: exitDate, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (e) return { ok: false, error: e.message };
    await loadPositions();
    return { ok: true, error: null as string | null };
  }, [loadPositions]);

  /** Edit any saved fields of a position. */
  const updatePosition = useCallback(async (id: string, patch: Partial<StockPosition>) => {
    const { id: _ignore, created_at: _c, ...rest } = patch as StockPosition; // eslint-disable-line @typescript-eslint/no-unused-vars
    const clean: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    if (typeof clean.ticker === 'string') clean.ticker = (clean.ticker as string).toUpperCase().trim();
    const { error: e } = await supabase.from('stock_positions').update(clean).eq('id', id);
    if (e) return { ok: false, error: e.message };
    await loadPositions();
    return { ok: true, error: null as string | null };
  }, [loadPositions]);

  /**
   * Import rows from Excel into the Open or Closed list.
   * Each row OVERWRITES the existing position it matches; rows with no match
   * are added as new. Positions not in the file are left untouched.
   * Matching, in order:
   *   1. ID column equals an existing position's ID
   *   2. Same ticker + same entry date (within the same Open/Closed list).
   *      If several positions match, the one with the same entry price
   *      (and, for closed trades, the same exit date) is used first.
   * Each existing position is matched at most once, so two lots of the same
   * ticker bought the same day stay separate.
   */
  const importPositions = useCallback(async (rows: Partial<StockPosition>[], view: 'open' | 'closed') => {
    const pool = positions.filter((p) => p.status === view);
    const byId = new Map(positions.map((p) => [p.id, p]));
    const used = new Set<string>();
    const near = (a: number | null | undefined, b: number | null | undefined) =>
      a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;

    const findMatch = (r: Partial<StockPosition>): StockPosition | null => {
      if (r.id && byId.has(r.id) && !used.has(r.id)) return byId.get(r.id)!;
      const ticker = (r.ticker ?? '').toUpperCase();
      const candidates = pool.filter((p) => !used.has(p.id) && p.ticker.toUpperCase() === ticker && p.entry_date === r.entry_date);
      if (!candidates.length) return null;
      const score = (p: StockPosition) =>
        (near(p.entry_price, r.entry_price) ? 2 : 0) + (view === 'closed' && p.exit_date === r.exit_date ? 1 : 0);
      return [...candidates].sort((a, b) => score(b) - score(a))[0];
    };

    const updates: { id: string; row: Partial<StockPosition> }[] = [];
    const inserts: Partial<StockPosition>[] = [];
    for (const r of rows) {
      const { id: _ignore, ...data } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
      const match = findMatch(r);
      if (match) { used.add(match.id); updates.push({ id: match.id, row: data }); }
      else inserts.push(data);
    }

    let updated = 0, added = 0;
    const errors: string[] = [];
    for (const u of updates) {
      const { error: e } = await supabase.from('stock_positions').update({ ...u.row, updated_at: new Date().toISOString() }).eq('id', u.id);
      if (e) errors.push(`${u.row.ticker}: ${e.message}`); else updated++;
    }
    if (inserts.length) {
      const { error: e } = await supabase.from('stock_positions').insert(inserts);
      if (e) errors.push(e.message); else added = inserts.length;
    }
    await loadPositions();
    return { added, updated, errors };
  }, [positions, loadPositions]);

  const reopenPosition = useCallback(async (id: string) => {
    const { error: e } = await supabase.from('stock_positions')
      .update({ status: 'open', exit_price: null, exit_date: null, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (!e) await loadPositions();
    return { ok: !e, error: e?.message ?? null };
  }, [loadPositions]);

  const deletePosition = useCallback(async (id: string) => {
    const { error: e } = await supabase.from('stock_positions').delete().eq('id', id);
    if (!e) setPositions((prev) => prev.filter((p) => p.id !== id));
    return { ok: !e, error: e?.message ?? null };
  }, []);

  // ── Quotes for open positions (saved prices; no Massive calls) ──
  const openTickers = positions.filter((p) => p.status === 'open').map((p) => p.ticker);
  const openKey = [...new Set(openTickers)].sort().join(',');
  const refreshQuotes = useCallback(async () => {
    const tickers = openKey ? openKey.split(',') : [];
    if (!tickers.length) { setQuotes({}); return; }
    setQuotesLoading(true);
    try {
      const { data, error: e } = await supabase.functions.invoke('market-scan', { body: { mode: 'stock-quotes', tickers } });
      if (e) throw e;
      const map: Record<string, StockQuote> = {};
      for (const q of (data?.quotes || []) as StockQuote[]) map[q.ticker] = q;
      setQuotes(map);
    } catch (err) {
      setError(`Could not load prices: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setQuotesLoading(false);
    }
  }, [openKey]);

  useEffect(() => { void refreshQuotes(); }, [refreshQuotes]);

  return {
    universe,
    enabledSymbols: universe.filter((u) => u.enabled).map((u) => u.symbol),
    addToUniverse, setUniverseEnabled, removeFromUniverse, removeAllFromUniverse,
    positions,
    openPositions: positions.filter((p) => p.status === 'open'),
    closedPositions: positions.filter((p) => p.status === 'closed'),
    addPosition, closePosition, reopenPosition, deletePosition, updatePosition, importPositions,
    quotes, quotesLoading, refreshQuotes,
    error,
  };
}

export type StockPortfolioState = ReturnType<typeof useStockPortfolio>;
