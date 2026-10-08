import { Search } from 'lucide-react';

/** Ticker symbol that opens Analyze Stock for that ticker when clicked. */
export function TickerLink({ ticker, onAnalyze, className = '' }: { ticker: string; onAnalyze?: (ticker: string) => void; className?: string }) {
  if (!onAnalyze) return <span className={className}>{ticker}</span>;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onAnalyze(ticker); }}
      title={`Analyze ${ticker}`}
      className={`group inline-flex items-center gap-1 text-left hover:text-sky-400 hover:underline underline-offset-2 ${className}`}
    >
      {ticker}
      <Search className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-70" />
    </button>
  );
}
