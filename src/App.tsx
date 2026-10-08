import { useState } from 'react';
import { Layout, type Page, type ScannerKind } from '@/components/Layout';
import { useAppState } from '@/lib/store';
import { useStockScanner } from '@/lib/stockStore';
import { useStockPortfolio } from '@/lib/stockPortfolio';
import { StockUniversePage } from '@/pages/StockUniversePage';
import { StockAnalyzePage } from '@/pages/StockAnalyzePage';
import { StockPositionsPage } from '@/pages/StockPositionsPage';
import { StockSummaryPage } from '@/pages/StockSummaryPage';
import { StockCandidatesPage } from '@/pages/StockCandidatesPage';
import { StockSettingsPage } from '@/pages/StockSettingsPage';
import { CandidatesPage } from '@/pages/CandidatesPage';
import { DetailPage } from '@/pages/DetailPage';
import { OpenPositionsPage } from '@/pages/OpenPositionsPage';
import { ClosedPositionsPage } from '@/pages/ClosedPositionsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { DailySummaryPage } from '@/pages/DailySummaryPage';
import { ScanUniversePage } from '@/pages/ScanUniversePage';
import { AnalyzeTickerPage } from '@/pages/AnalyzeTickerPage';

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('candidates');
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [selectedExpiration, setSelectedExpiration] = useState<string | null>(null);
  const [autoAnalyzeTicker, setAutoAnalyzeTicker] = useState<string | null>(null);
  const state = useAppState();
  const portfolio = useStockPortfolio();
  // "My Scan Universe" on the Stocks side uses the STOCK watchlist.
  const stock = useStockScanner(portfolio.enabledSymbols);
  // Options (CSP) vs Stocks. Remembered between visits.
  const [scanner, setScannerState] = useState<ScannerKind>(() => {
    try { return localStorage.getItem('scanner-kind') === 'stocks' ? 'stocks' : 'options'; } catch { return 'options'; }
  });
  const setScanner = (k: ScannerKind) => {
    setScannerState(k);
    try { localStorage.setItem('scanner-kind', k); } catch { /* storage unavailable */ }
    if (currentPage === 'detail') setCurrentPage('candidates');
  };
  const isStocks = scanner === 'stocks';

  const handleNavigate = (page: Page, ticker?: string, contract?: { strike: number; expiration: string }) => {
    if (ticker) setSelectedTicker(ticker);
    if (contract) {
      setSelectedStrike(contract.strike);
      setSelectedExpiration(contract.expiration);
    }
    setAutoAnalyzeTicker(page === 'analyze' && ticker ? ticker : null);
    setCurrentPage(page);
  };

  // Clicking a ticker on a Stocks page opens Analyze Stock and runs it.
  const analyzeStock = (ticker: string) => handleNavigate('analyze', ticker);

  if (state.loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-400">Loading CSP Scanner...</p>
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center max-w-md">
          <p className="text-red-400 text-sm mb-2">Failed to load</p>
          <p className="text-slate-500 text-xs">{state.error}</p>
        </div>
      </div>
    );
  }

  return (
    <Layout currentPage={currentPage} onNavigate={handleNavigate} state={state} scanner={scanner} onScannerChange={setScanner} stock={stock} stockOpenCount={portfolio.openPositions.length}>
      {isStocks && currentPage === 'candidates' && <StockCandidatesPage stock={stock} portfolio={portfolio} />}
      {isStocks && currentPage === 'settings' && <StockSettingsPage stock={stock} />}
      {isStocks && currentPage === 'analyze' && (
        <StockAnalyzePage stock={stock} portfolio={portfolio} autoTicker={autoAnalyzeTicker} onConsumeAutoTicker={() => setAutoAnalyzeTicker(null)} />
      )}
      {isStocks && currentPage === 'universe' && <StockUniversePage stock={stock} portfolio={portfolio} optionsUniverse={state.scanUniverse} onAnalyze={analyzeStock} />}
      {isStocks && currentPage === 'open' && <StockPositionsPage portfolio={portfolio} view="open" onAnalyze={analyzeStock} />}
      {isStocks && currentPage === 'closed' && <StockPositionsPage portfolio={portfolio} view="closed" onAnalyze={analyzeStock} />}
      {isStocks && currentPage === 'summary' && <StockSummaryPage stock={stock} portfolio={portfolio} onAnalyze={analyzeStock} />}
      {!isStocks && currentPage === 'candidates' && (
        <CandidatesPage state={state} onNavigate={handleNavigate} />
      )}
      {!isStocks && currentPage === 'analyze' && (
        <AnalyzeTickerPage state={state} autoAnalyzeTicker={autoAnalyzeTicker} onConsumeAutoAnalyze={() => setAutoAnalyzeTicker(null)} />
      )}
      {currentPage === 'detail' && selectedTicker && (
        <DetailPage
          ticker={selectedTicker}
          strike={selectedStrike}
          expiration={selectedExpiration}
          state={state}
          onNavigate={handleNavigate}
        />
      )}
      {currentPage === 'detail' && !selectedTicker && (
        <CandidatesPage state={state} onNavigate={handleNavigate} />
      )}
      {!isStocks && currentPage === 'open' && <OpenPositionsPage state={state} />}
      {!isStocks && currentPage === 'closed' && <ClosedPositionsPage state={state} />}
      {!isStocks && currentPage === 'settings' && <SettingsPage state={state} />}
      {!isStocks && currentPage === 'summary' && <DailySummaryPage state={state} />}
      {!isStocks && currentPage === 'universe' && <ScanUniversePage state={state} onNavigate={handleNavigate} />}
    </Layout>
  );
}

export default App;
