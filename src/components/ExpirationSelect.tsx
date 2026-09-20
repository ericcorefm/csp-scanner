import { useState, useRef, useEffect, useMemo } from 'react';
import { Calendar, Check, X, AlertCircle, ChevronDown, RefreshCw } from 'lucide-react';

interface ExpirationSelectProps {
  availableDates: string[];
  selectedDates: string[];
  loading: boolean;
  error: string | null;
  onChange: (dates: string[]) => void;
  onRefresh: () => void;
  disabled?: boolean;
}

function formatReadable(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ExpirationSelect({
  availableDates,
  selectedDates,
  loading,
  error,
  onChange,
  onRefresh,
  disabled,
}: ExpirationSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const today = isoToday();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Sorted available dates (nearest to farthest), filtered to future only
  const sortedAvailable = useMemo(() => {
    return [...new Set(availableDates)]
      .filter((d) => d >= today)
      .sort((a, b) => a.localeCompare(b));
  }, [availableDates, today]);

  // Selected dates that are no longer available
  const unavailableSelected = useMemo(() => {
    return selectedDates.filter((d) => !sortedAvailable.includes(d));
  }, [selectedDates, sortedAvailable]);

  // "Any Expiration" = no specific dates selected
  const isAnyExpiration = selectedDates.length === 0;

  const toggleDate = (date: string) => {
    if (selectedDates.includes(date)) {
      onChange(selectedDates.filter((d) => d !== date));
    } else {
      onChange([...selectedDates, date].sort((a, b) => a.localeCompare(b)));
    }
  };

  const selectAny = () => {
    onChange([]);
  };

  const removeDate = (date: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selectedDates.filter((d) => d !== date));
  };

  return (
    <div className="w-full" ref={ref}>
      {/* Selected chips */}
      {selectedDates.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {selectedDates.map((d) => {
            const isUnavailable = !sortedAvailable.includes(d);
            return (
              <span
                key={d}
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
                  isUnavailable
                    ? 'bg-red-900/30 border border-red-700/40 text-red-300'
                    : 'bg-slate-700/50 text-slate-300'
                }`}
              >
                {isUnavailable && <AlertCircle className="h-3 w-3 shrink-0" />}
                <span className={isUnavailable ? 'italic' : ''}>{formatReadable(d)}</span>
                {isUnavailable && <span className="text-red-400/70 text-[10px]">(unavailable)</span>}
                <button
                  onClick={(e) => removeDate(d, e)}
                  className="text-slate-500 hover:text-red-400"
                  disabled={disabled}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Dropdown trigger + refresh button */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => !disabled && !loading && setOpen(!open)}
          disabled={disabled || loading}
          className="flex-1 flex items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed hover:border-slate-600 transition-colors"
        >
          <span className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-slate-500" />
            {loading ? (
              <span className="text-slate-500">Loading expiration dates...</span>
            ) : isAnyExpiration ? (
              <span className="text-slate-300">Any Expiration</span>
            ) : selectedDates.length === 1 ? (
              <span className="text-slate-200">{formatReadable(selectedDates[0])}</span>
            ) : (
              <span className="text-slate-200">{selectedDates.length} dates selected</span>
            )}
          </span>
          <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={disabled || loading}
          title="Refresh expiration dates"
          className="shrink-0 rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Error state with retry */}
      {error && !loading && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-red-900/40 bg-red-900/10 px-3 py-2">
          <span className="text-xs text-red-300">Expiration dates could not be loaded.</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={disabled}
            className="shrink-0 rounded border border-red-700/40 px-2 py-1 text-xs text-red-300 hover:bg-red-900/20 transition-colors disabled:opacity-40"
          >
            Retry
          </button>
        </div>
      )}

      {/* Dropdown panel */}
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-slate-700 bg-slate-800 shadow-xl">
          {/* Any Expiration option */}
          <button
            type="button"
            onClick={selectAny}
            className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-slate-700/50 ${
              isAnyExpiration ? 'text-sky-400 bg-sky-500/10' : 'text-slate-300'
            }`}
          >
            <span>Any Expiration</span>
            {isAnyExpiration && <Check className="h-4 w-4" />}
          </button>

          {sortedAvailable.length > 0 && (
            <div className="border-t border-slate-700">
              <div className="px-3 py-1.5 text-xs text-slate-500 font-medium">Available Expiration Dates</div>
            </div>
          )}

          {sortedAvailable.map((date) => {
            const isSelected = selectedDates.includes(date);
            return (
              <button
                key={date}
                type="button"
                onClick={() => toggleDate(date)}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-slate-700/50 ${
                  isSelected ? 'text-sky-400 bg-sky-500/10' : 'text-slate-300'
                }`}
              >
                <span>{formatReadable(date)}</span>
                {isSelected && <Check className="h-4 w-4" />}
              </button>
            );
          })}

          {/* Unavailable selected dates */}
          {unavailableSelected.length > 0 && (
            <div className="border-t border-slate-700">
              <div className="px-3 py-1.5 text-xs text-red-400/70 font-medium">No Longer Available</div>
              {unavailableSelected.map((date) => (
                <button
                  key={date}
                  type="button"
                  onClick={() => toggleDate(date)}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm text-red-300 hover:bg-slate-700/50 transition-colors"
                >
                  <span className="italic flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {formatReadable(date)}
                  </span>
                  <Check className="h-4 w-4" />
                </button>
              ))}
            </div>
          )}

          {sortedAvailable.length === 0 && unavailableSelected.length === 0 && !loading && (
            <div className="px-3 py-3 text-sm text-slate-500 text-center">
              No expiration dates available. Run a scan first to populate.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
