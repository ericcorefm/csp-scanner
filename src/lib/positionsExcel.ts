import type { StockPosition, StockQuote } from '@/lib/stockTypes';

/**
 * Excel import/export for stock positions. ExcelJS is loaded only when used,
 * so it does not slow down the rest of the app.
 *
 * The ID column lets a re-imported file UPDATE the same positions instead of
 * creating duplicates. Leave ID blank for new rows.
 */
const COLUMNS = [
  { header: 'ID', key: 'id', width: 38 },
  { header: 'Ticker', key: 'ticker', width: 10 },
  { header: 'Company', key: 'company_name', width: 24 },
  { header: 'Entry Date', key: 'entry_date', width: 12 },
  { header: 'Entry Price', key: 'entry_price', width: 12 },
  { header: 'Shares', key: 'shares', width: 12 },
  { header: 'Amount ($)', key: 'amount', width: 12 },
  { header: 'Target', key: 'target_price', width: 10 },
  { header: 'Stop', key: 'stop_price', width: 10 },
  { header: 'Max Cycle Days', key: 'max_cycle_days', width: 14 },
  { header: 'Exit Date', key: 'exit_date', width: 12 },
  { header: 'Exit Price', key: 'exit_price', width: 12 },
  { header: 'Notes', key: 'notes', width: 30 },
] as const;

export async function exportPositionsToExcel(positions: StockPosition[], view: 'open' | 'closed', quotes: Record<string, StockQuote> = {}) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(view === 'open' ? 'Open Positions' : 'Closed Positions');
  const extra = view === 'open'
    ? [{ header: 'Current Price', key: 'current', width: 13 }, { header: 'P/L ($)', key: 'pl', width: 11 }]
    : [{ header: 'P/L ($)', key: 'pl', width: 11 }];
  ws.columns = [...COLUMNS, ...extra].map((c) => ({ ...c }));
  for (const p of positions) {
    const current = quotes[p.ticker]?.price ?? null;
    const exitOrNow = view === 'open' ? current : p.exit_price;
    ws.addRow({
      ...p,
      amount: Number((p.entry_price * p.shares).toFixed(2)),
      current,
      pl: exitOrNow != null ? Number(((exitOrNow - p.entry_price) * p.shares).toFixed(2)) : null,
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `stock-positions-${view}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((r) => r.text).join('');
    if (o.result != null) return cellText(o.result);
    if (o.text != null) return String(o.text);
  }
  return String(v).trim();
}
const num = (v: unknown) => {
  const t = cellText(v).replace(/[$,%\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const date = (v: unknown) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = cellText(v);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export type ImportResult = { rows: Partial<StockPosition>[]; skipped: string[] };

/**
 * Read an .xlsx file. Matches columns by header name (case-insensitive), so
 * column order does not matter. Shares can be given directly or as Amount ($).
 * On the Closed page, rows need an exit price.
 */
export async function readPositionsFromExcel(file: File, view: 'open' | 'closed'): Promise<ImportResult> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], skipped: ['The file has no worksheet'] };

  const headerIdx = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => headerIdx.set(cellText(cell.value).toLowerCase().replace(/\s+/g, ' '), col));
  const col = (...names: string[]) => names.map((n) => headerIdx.get(n)).find((i) => i != null);
  const c = {
    id: col('id'), ticker: col('ticker', 'symbol'), company: col('company', 'company name'),
    entryDate: col('entry date', 'open date'), entryPrice: col('entry price', 'entry'),
    shares: col('shares', 'quantity', 'qty'), amount: col('amount ($)', 'amount', 'cost', 'invested'),
    target: col('target', 'target price'), stop: col('stop', 'stop price'),
    cycle: col('max cycle days', 'cycle days'), exitDate: col('exit date', 'close date'),
    exitPrice: col('exit price', 'exit'), notes: col('notes'),
  };
  if (!c.ticker || !c.entryPrice) return { rows: [], skipped: ['Missing required columns: Ticker and Entry Price'] };

  const rows: Partial<StockPosition>[] = [];
  const skipped: string[] = [];
  ws.eachRow((row, r) => {
    if (r === 1) return;
    const get = (i?: number) => (i ? row.getCell(i).value : null);
    const ticker = cellText(get(c.ticker)).toUpperCase();
    if (!ticker) return;
    const entryPrice = num(get(c.entryPrice));
    let shares = num(get(c.shares));
    const amount = num(get(c.amount));
    if ((shares == null || shares <= 0) && amount && entryPrice) shares = amount / entryPrice;
    if (!entryPrice || entryPrice <= 0 || !shares || shares <= 0) { skipped.push(`Row ${r} (${ticker}): needs Entry Price and Shares or Amount`); return; }
    const exitPrice = num(get(c.exitPrice));
    const exitDate = date(get(c.exitDate));
    if (view === 'closed' && (exitPrice == null || exitPrice <= 0)) { skipped.push(`Row ${r} (${ticker}): closed trades need an Exit Price`); return; }
    const id = cellText(get(c.id));
    rows.push({
      ...(id ? { id } : {}),
      ticker,
      company_name: cellText(get(c.company)) || null,
      entry_date: date(get(c.entryDate)) ?? new Date().toISOString().slice(0, 10),
      entry_price: entryPrice,
      shares: Number(shares.toFixed(6)),
      target_price: num(get(c.target)),
      stop_price: num(get(c.stop)),
      max_cycle_days: Math.round(num(get(c.cycle)) ?? 30),
      notes: cellText(get(c.notes)) || null,
      status: view,
      exit_price: view === 'closed' ? exitPrice : null,
      exit_date: view === 'closed' ? exitDate ?? new Date().toISOString().slice(0, 10) : null,
    });
  });
  return { rows, skipped };
}
