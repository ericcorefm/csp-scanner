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
   * Import rows from Excel. Rows whose ID matches an existing position are
   * updated; all others are added. Returns counts for the confirmation message.
   */
  const importPositions = useCallback(async (rows: Partial<StockPosition>[]) => {
    const existing = new Set(positions.map((p) => p.id));
    const updates = rows.filter((r) => r.id && existing.has(r.id));
    const inserts = rows.filter((r) => !r.id || !existing.has(r.id)).map((r) => {
      const { id: _i, ...rest } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
      return rest;
    });
    let updated = 0, added = 0;
    const errors: string[] = [];
    for (const r of updates) {
      const { id, ...patch } = r;
      const { error: e } = await supabase.from('stock_positions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id!);
      if (e) errors.push(`${r.ticker}: ${e.message}`); else updated++;
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
