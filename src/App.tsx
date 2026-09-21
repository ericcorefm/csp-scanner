import { useState } from 'react';
import { Layout, type Page } from '@/components/Layout';
import { useAppState } from '@/lib/store';
import { useAuth } from '@/lib/useAuth';
import { SignInPage } from '@/pages/auth/SignInPage';
import { SignUpPage } from '@/pages/auth/SignUpPage';
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/pages/auth/ResetPasswordPage';
import { ProfilePage } from '@/pages/ProfilePage';
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
  const auth = useAuth();
  const state = useAppState(auth.user?.id);

  const handleNavigate = (page: Page, ticker?: string, contract?: { strike: number; expiration: string }) => {
    if (ticker) setSelectedTicker(ticker);
    if (contract) {
      setSelectedStrike(contract.strike);
      setSelectedExpiration(contract.expiration);
    }
    setAutoAnalyzeTicker(page === 'analyze' && ticker ? ticker : null);
    setCurrentPage(page);
  };

  // Auth gate: show loading spinner while auth state is being determined
  if (auth.authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <div className="h-8 w-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-400">Loading CSP Scanner...</p>
        </div>
      </div>
    );
  }

  // Auth routes: allow only when not authenticated (or reset-password during recovery)
  if (auth.authRoute) {
    // If user is authenticated but authRoute is still set (e.g. recovery), 
    // only allow reset-password; otherwise clear the route and proceed to app
    if (auth.user && auth.authRoute !== 'reset-password') {
      auth.setAuthRoute(null);
    } else {
      switch (auth.authRoute) {
        case 'signin':
          return <SignInPage auth={auth} />;
        case 'signup':
          return <SignUpPage auth={auth} />;
        case 'forgot-password':
          return <ForgotPasswordPage auth={auth} />;
        case 'reset-password':
          return <ResetPasswordPage auth={auth} />;
      }
    }
  }

  // Not signed in — default to sign in page
  if (!auth.user) {
    return <SignInPage auth={auth} />;
  }

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
    <Layout currentPage={currentPage} onNavigate={handleNavigate} state={state} auth={auth}>
      {currentPage === 'candidates' && (
        <CandidatesPage state={state} onNavigate={handleNavigate} />
      )}
      {currentPage === 'analyze' && (
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
      {currentPage === 'open' && <OpenPositionsPage state={state} />}
      {currentPage === 'closed' && <ClosedPositionsPage state={state} />}
      {currentPage === 'settings' && <SettingsPage state={state} />}
      {currentPage === 'profile' && <ProfilePage auth={auth} />}
      {currentPage === 'summary' && <DailySummaryPage state={state} />}
      {currentPage === 'universe' && <ScanUniversePage state={state} />}
    </Layout>
  );
}

export default App;
