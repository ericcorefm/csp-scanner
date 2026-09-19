import { useState } from 'react';
import { Layout, type Page } from '@/components/Layout';
import { useAppState } from '@/lib/store';
import { CandidatesPage } from '@/pages/CandidatesPage';
import { DetailPage } from '@/pages/DetailPage';
import { OpenPositionsPage } from '@/pages/OpenPositionsPage';
import { ClosedPositionsPage } from '@/pages/ClosedPositionsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { DailySummaryPage } from '@/pages/DailySummaryPage';
import { ScanUniversePage } from '@/pages/ScanUniversePage';

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('candidates');
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const state = useAppState();

  const handleNavigate = (page: Page, ticker?: string) => {
    if (ticker) setSelectedTicker(ticker);
    setCurrentPage(page);
  };

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
    <Layout currentPage={currentPage} onNavigate={handleNavigate} state={state}>
      {currentPage === 'candidates' && (
        <CandidatesPage state={state} onNavigate={handleNavigate} />
      )}
      {currentPage === 'detail' && selectedTicker && (
        <DetailPage ticker={selectedTicker} state={state} onNavigate={handleNavigate} />
      )}
      {currentPage === 'detail' && !selectedTicker && (
        <CandidatesPage state={state} onNavigate={handleNavigate} />
      )}
      {currentPage === 'open' && <OpenPositionsPage state={state} />}
      {currentPage === 'closed' && <ClosedPositionsPage state={state} />}
      {currentPage === 'settings' && <SettingsPage state={state} />}
      {currentPage === 'summary' && <DailySummaryPage state={state} />}
      {currentPage === 'universe' && <ScanUniversePage state={state} />}
    </Layout>
  );
}

export default App;
