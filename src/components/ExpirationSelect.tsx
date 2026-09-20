import { useState, useRef, useEffect, useMemo } from 'react';
import { Calendar, X, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';

interface ExpirationSelectProps {
  selectedDates: string[];
  onChange: (dates: string[]) => void;
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

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function ExpirationSelect({
  selectedDates,
  onChange,
  disabled,
}: ExpirationSelectProps) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const ref = useRef<HTMLDivElement>(null);
  const today = isoToday();
  const todayDate = new Date(today + 'T00:00:00');

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const sortedSelected = useMemo(() => {
    return [...selectedDates].sort((a, b) => a.localeCompare(b));
  }, [selectedDates]);

  const toggleDate = (date: string) => {
    if (selectedDates.includes(date)) {
      onChange(selectedDates.filter((d) => d !== date));
    } else {
      onChange([...selectedDates, date].sort((a, b) => a.localeCompare(b)));
    }
  };

  const removeDate = (date: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selectedDates.filter((d) => d !== date));
  };

  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  // Build calendar grid for the current view month
  const calendarDays = useMemo(() => {
    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const startDayOfWeek = firstOfMonth.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

    const days: (string | null)[] = [];
    // Leading blanks for alignment
    for (let i = 0; i < startDayOfWeek; i++) {
      days.push(null);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push(iso);
    }
    // Trailing blanks to fill the last week
    while (days.length % 7 !== 0) {
      days.push(null);
    }
    return days;
  }, [viewYear, viewMonth]);

  const isDateDisabled = (iso: string): boolean => {
    const d = new Date(iso + 'T00:00:00');
    return d < todayDate;
  };

  const isAnyExpiration = selectedDates.length === 0;

  return (
    <div className="w-full" ref={ref}>
      {/* Selected chips */}
      {sortedSelected.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {sortedSelected.map((d) => (
            <span
              key={d}
              className="inline-flex items-center gap-1 rounded bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-300"
            >
              <span>{formatReadable(d)}</span>
              <button
                onClick={(e) => removeDate(d, e)}
                className="text-slate-500 hover:text-red-400"
                disabled={disabled}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            onClick={clearAll}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded border border-slate-700 px-1.5 py-0.5 text-xs text-slate-400 hover:text-red-400 hover:border-red-800/40 transition-colors disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
            Clear Dates
          </button>
        </div>
      )}

      {/* Trigger button */}
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="w-full flex items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed hover:border-slate-600 transition-colors"
      >
        <span className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-slate-500" />
          {isAnyExpiration ? (
            <span className="text-slate-400">Select dates</span>
          ) : sortedSelected.length === 1 ? (
            <span className="text-slate-200">{formatReadable(sortedSelected[0])}</span>
          ) : (
            <span className="text-slate-200">{sortedSelected.length} dates selected</span>
          )}
        </span>
        <span className="text-xs text-slate-500">
          {isAnyExpiration ? 'Any Expiration' : ''}
        </span>
      </button>

      {/* Calendar panel */}
      {open && (
        <div className="absolute z-50 mt-1 w-full max-w-sm rounded-lg border border-slate-700 bg-slate-800 shadow-xl p-3">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-3">
            <button
              type="button"
              onClick={prevMonth}
              className="rounded p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium text-slate-200">
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              onClick={nextMonth}
              className="rounded p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {WEEKDAYS.map((wd) => (
              <div key={wd} className="text-center text-[10px] font-medium text-slate-500 py-1">
                {wd}
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="grid grid-cols-7 gap-1">
            {calendarDays.map((iso, i) => {
              if (iso === null) {
                return <div key={i} />;
              }
              const isSelected = selectedDates.includes(iso);
              const isDisabled = isDateDisabled(iso);
              const dayNum = parseInt(iso.slice(8), 10);
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => !isDisabled && toggleDate(iso)}
                  disabled={isDisabled}
                  className={`h-8 w-8 rounded text-xs transition-colors ${
                    isSelected
                      ? 'bg-sky-500 text-white font-semibold'
                      : isDisabled
                        ? 'text-slate-700 cursor-not-allowed'
                        : 'text-slate-300 hover:bg-slate-700/50'
                  }`}
                >
                  {dayNum}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="mt-3 flex items-center justify-between border-t border-slate-700 pt-2">
            <span className="text-xs text-slate-500">
              {isAnyExpiration
                ? 'Any Expiration — using Minimum DTE'
                : `${sortedSelected.length} date${sortedSelected.length > 1 ? 's' : ''} selected`}
            </span>
            {sortedSelected.length > 0 && (
              <button
                type="button"
                onClick={(e) => { clearAll(e); }}
                className="text-xs text-slate-400 hover:text-red-400 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
