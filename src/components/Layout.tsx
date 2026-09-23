import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  FolderOpen,
  CheckCircle2,
  Settings,
  CalendarDays,
  LineChart,
  ScanLine,
  AlertTriangle,
  ChevronLeft,
  Menu,
  X,
  Search,
  Globe,
} from 'lucide-react';
import type { AppState } from '@/lib/store';
import { Badge } from '@/components/ui';
import { selectBestContractPerTicker } from '@/lib/bestContract';

export type Page = 'candidates' | 'analyze' | 'detail' | 'open' | 'closed' | 'settings' | 'summary' | 'universe';

interface LayoutProps {
  children: React.ReactNode;
  currentPage: Page;
  onNavigate: (page: Page, ticker?: string, contract?: { strike: number; expiration: string }) => void;
  state: AppState;
}

const navItems: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: 'candidates', label: "Today's Candidates", icon: ScanLine },
  { id: 'analyze', label: 'Analyze Ticker', icon: Search },
  { id: 'universe', label: 'Scan Universe', icon: Globe },
  { id: 'open', label: 'Open Positions', icon: FolderOpen },
  { id: 'closed', label: 'Closed Positions', icon: CheckCircle2 },
  { id: 'summary', label: 'Daily Summary', icon: CalendarDays },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Layout({ children, currentPage, onNavigate, state }: LayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const bestPerTicker = selectBestContractPerTicker(state.candidates);
  const isUniverseMode = state.scanMode === 'universe';
  const qualifiedTickers = bestPerTicker.filter((c) =>
    isUniverseMode ? (c.qualified && !c.technical_pending) : c.qualified
  );
  const qualifiedCount = new Set(qualifiedTickers.map((c) => c.ticker)).size;
  const rejectedCount = new Set(bestPerTicker.filter((c) => !c.qualified).map((c) => c.ticker)).size;
  const unreadAlerts = state.alerts.filter((a) => !a.read).length;

  const handleNav = (page: Page) => {
    onNavigate(page);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-3 md:hidden">
        <div className="flex items-center gap-2">
          <LineChart className="h-5 w-5 text-sky-400" />
          <span className="font-semibold text-sm">CSP Scanner</span>
        </div>
        <button onClick={() => setMobileOpen(!mobileOpen)} className="p-1.5 rounded-md hover:bg-slate-800">
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      <div className="flex">
        {/* Sidebar */}
        <aside
          className={`${
            mobileOpen ? 'block' : 'hidden'
          } fixed inset-y-0 left-0 z-50 w-64 border-r border-slate-800 bg-slate-900 md:sticky md:top-0 md:block md:h-screen`}
        >
          <div className="flex h-16 items-center gap-2.5 border-b border-slate-800 px-5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10">
              <LineChart className="h-5 w-5 text-sky-400" />
            </div>
            <div>
              <div className="font-semibold text-sm text-slate-100">CSP Scanner</div>
              <div className="text-[11px] text-slate-500">Cash-Secured Puts</div>
            </div>
          </div>

          <nav className="p-3 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = currentPage === item.id;
              const badge =
                item.id === 'candidates' ? qualifiedCount :
                item.id === 'open' ? state.openPositions.length :
                item.id === 'closed' ? state.closedPositions.length :
                undefined;
              return (
                <button
                  key={item.id}
                  onClick={() => handleNav(item.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? 'bg-sky-500/10 text-sky-400'
                      : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 text-left">{item.label}</span>
                  {badge !== undefined && badge > 0 && (
                    <span className={`rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
                      active ? 'bg-sky-500/20 text-sky-300' : 'bg-slate-800 text-slate-400'
                    }`}>{badge}</span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="absolute bottom-0 left-0 right-0 border-t border-slate-800 p-4">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>Decision-support tool. Not autonomous trading.</span>
            </div>
          </div>
        </aside>

        {mobileOpen && (
          <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} />
        )}

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {/* Top header */}
          <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-800 bg-slate-900/80 px-5 backdrop-blur-md">
            <div className="flex items-center gap-4">
              <div className="hidden md:flex items-center gap-3">
                <span className="text-sm font-medium text-slate-300">
                  {navItems.find((n) => n.id === currentPage)?.label}
                </span>
              </div>
              {state.activeProfile && (
                <Badge variant="info">
                  {state.activeProfile.name}
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-4">
              <div className="hidden sm:flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="text-slate-400">{qualifiedCount} qualified</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-slate-500" />
                  <span className="text-slate-400">{rejectedCount} rejected</span>
                </div>
                {unreadAlerts > 0 && (
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                    <span className="text-amber-400">{unreadAlerts} alerts</span>
                  </div>
                )}
              </div>
              <div className="hidden lg:flex flex-col items-end leading-tight">
                {state.lastScanAt && (
                  <span className="text-[11px] text-slate-500">
                    Last scan {new Date(state.lastScanAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    {state.scanSource === 'live' ? ' · LIVE' : state.scanSource === 'demo' ? ' · DEMO' : ''}
                  </span>
                )}
                {state.scanError && <span className="max-w-[360px] truncate text-[10px] text-amber-400" title={state.scanError}>{state.scanError}</span>}
              </div>
              <button
                onClick={() => void state.runScan()}
                disabled={state.scanning}
                className="flex items-center gap-2 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
              >
                <ScanLine className={`h-4 w-4 ${state.scanning ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{state.scanning ? 'Scanning...' : 'Rescan'}</span>
              </button>
            </div>
          </header>

          <main className="p-4 md:p-6 max-w-[1600px] mx-auto">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors mb-4"
    >
      <ChevronLeft className="h-4 w-4" />
      Back
    </button>
  );
}
