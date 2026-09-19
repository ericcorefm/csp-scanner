import { useState, useEffect } from 'react';
import { Save, RotateCcw, Copy, Plus, Trash2, Check, AlertCircle } from 'lucide-react';
import type { AppState } from '@/lib/types';
import type { StrategyProfile } from '@/types';
import { Card } from '@/components/ui';

interface FieldDef {
  key: keyof StrategyProfile;
  label: string;
  type: 'number' | 'text' | 'boolean' | 'integer' | 'date_array' | 'number_array';
  unit?: string;
  step?: string;
  min?: number;
  help?: string;
  placeholder?: string;
}

interface SectionDef {
  title: string;
  enabledKey: keyof StrategyProfile;
  fields: FieldDef[];
}

const sections: SectionDef[] = [
  {
    title: 'Order & Strike',
    enabledKey: 'order_strike_enabled',
    fields: [
      { key: 'max_strike', label: 'Maximum Put Strike', type: 'number', unit: '$', step: '0.5' },
      { key: 'min_strike', label: 'Minimum Put Strike', type: 'number', unit: '$', step: '0.5', help: 'Leave blank for no minimum.' },
    ],
  },
  {
    title: 'Expiration',
    enabledKey: 'expiration_enabled',
    fields: [
      { key: 'min_dte', label: 'Minimum DTE', type: 'integer', unit: 'days', help: 'Minimum days to expiration.' },
      { key: 'max_dte', label: 'Maximum DTE', type: 'integer', unit: 'days', help: 'Maximum days to expiration.' },
      { key: 'preferred_expirations', label: 'Preferred Expiration Dates', type: 'date_array', help: 'Specific dates (YYYY-MM-DD). If empty, use DTE range.', placeholder: '2028-01-21' },
    ],
  },
  {
    title: 'CROI & Premium Capture',
    enabledKey: 'croi_pc_enabled',
    fields: [
      { key: 'min_net_croi', label: 'Minimum Net CROI', type: 'number', unit: '%', step: '0.1' },
      { key: 'preferred_croi_max', label: 'Preferred CROI Maximum', type: 'number', unit: '%', step: '0.1' },
      { key: 'max_premium_capture', label: 'Maximum Premium Capture', type: 'number', unit: '%', step: '1' },
    ],
  },
  {
    title: 'Cycle & Liquidity',
    enabledKey: 'cycle_liquidity_enabled',
    fields: [
      { key: 'max_recycle_days', label: 'Maximum Cycle Days', type: 'integer', unit: 'days' },
      { key: 'min_target_oi', label: 'Minimum Target OI', type: 'integer' },
      { key: 'preferred_daily_volume', label: 'Preferred Daily Volume', type: 'integer' },
    ],
  },
  {
    title: 'Bid/Ask Spread',
    enabledKey: 'spread_enabled',
    fields: [
      { key: 'preferred_spread_pct', label: 'Preferred Spread', type: 'number', unit: '%', step: '0.5' },
      { key: 'max_spread_pct', label: 'Maximum Spread', type: 'number', unit: '%', step: '0.5' },
    ],
  },
  {
    title: 'Short Interest',
    enabledKey: 'short_interest_enabled',
    fields: [
      { key: 'short_interest_warning', label: 'Short Interest Warning', type: 'number', unit: '%', step: '0.5' },
      { key: 'short_interest_exclusion', label: 'Short Interest Exclusion', type: 'number', unit: '%', step: '0.5' },
    ],
  },
  {
    title: 'Technical Rules',
    enabledKey: 'technical_rules_enabled',
    fields: [
      { key: 'rsi_min', label: 'RSI Minimum', type: 'integer' },
      { key: 'rsi_max', label: 'RSI Maximum', type: 'integer' },
      { key: 'require_ma20_above_ma50', label: 'Require MA20 > MA50', type: 'boolean' },
      { key: 'require_ma50_above_ma200', label: 'Require MA50 > MA200', type: 'boolean' },
      { key: 'require_price_above_ma200', label: 'Require Price > MA200', type: 'boolean' },
      { key: 'exclude_downtrend_no_support', label: 'Exclude Downtrend Without Support', type: 'boolean' },
    ],
  },
];

const nonToggleSections: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Commission & BTC',
    fields: [
      { key: 'round_trip_commission', label: 'Round-Trip Commission', type: 'number', unit: '$', step: '0.01' },
      { key: 'btc_increment', label: 'BTC Increment', type: 'number', unit: '$', step: '0.01' },
      { key: 'allow_penny_increments', label: 'Allow Penny Increments', type: 'boolean' },
    ],
  },
];

export function SettingsPage({ state }: { state: AppState }) {
  const [profile, setProfile] = useState<StrategyProfile | null>(state.activeProfile);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [newProfileName, setNewProfileName] = useState('');
  const [showNewInput, setShowNewInput] = useState(false);

  // Sync local profile state when the store's activeProfile changes
  // (e.g. after save, after profile switch, after reset)
  useEffect(() => {
    setProfile(state.activeProfile);
  }, [state.activeProfile]);

  if (!profile) return <div className="text-slate-400">Loading...</div>;

  const updateField = (key: keyof StrategyProfile, value: string | number | boolean | string[] | number[]) => {
    setProfile({ ...profile, [key]: value });
    setSaved(false);
    setSaveError(null);
  };

  const handleSave = async () => {
    setSaveError(null);
    try {
      const saved = await state.saveProfile(profile);
      // Sync local state from the database-returned row
      setProfile(saved);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save profile';
      setSaveError(msg);
    }
  };

  const handleReset = async () => {
    setSaveError(null);
    try {
      const saved = await state.resetProfile();
      if (saved) setProfile(saved);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to reset profile';
      setSaveError(msg);
    }
  };

  const handleDuplicate = async () => {
    const newProfile = await state.duplicateProfile(profile);
    setProfile(newProfile);
  };

  const handleCreateNew = async () => {
    if (!newProfileName.trim()) return;
    const newProfile = await state.createProfile(newProfileName.trim());
    setProfile(newProfile);
    setNewProfileName('');
    setShowNewInput(false);
  };

  const handleSelectProfile = (id: string) => {
    const p = state.profiles.find((p) => p.id === id);
    if (p) {
      setProfile(p);
      state.setActiveProfile(p);
    }
  };

  const renderField = (field: FieldDef, disabled: boolean) => {
    if (field.type === 'date_array') {
      const arr = profile[field.key] as string[];
      return (
        <div className="flex flex-col items-end gap-1">
          <input
            type="text"
            value={arr.join(', ')}
            onChange={(e) => {
              const vals = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
              updateField(field.key, vals);
            }}
            placeholder={field.placeholder || 'YYYY-MM-DD, ...'}
            disabled={disabled}
            className="w-48 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
          />
          {arr.length > 0 && (
            <div className="flex flex-wrap gap-1 justify-end max-w-48">
              {arr.map((d) => (
                <span key={d} className="inline-flex items-center gap-1 rounded bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-300">
                  {d}
                  <button onClick={() => updateField(field.key, arr.filter((x) => x !== d))} className="text-slate-500 hover:text-red-400" disabled={disabled}>&times;</button>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (field.type === 'number_array') {
      const arr = profile[field.key] as number[];
      return (
        <div className="flex flex-col items-end gap-1">
          <input
            type="text"
            value={arr.join(', ')}
            onChange={(e) => {
              const vals = e.target.value.split(',').map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v));
              updateField(field.key, vals);
            }}
            placeholder={field.placeholder || 'e.g. 10,12,15,25'}
            disabled={disabled}
            className="w-48 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
          />
          {arr.length > 0 && (
            <div className="flex flex-wrap gap-1 justify-end max-w-48">
              {arr.map((s, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-300">
                  <span>{'$' + s}</span>
                  <button onClick={() => updateField(field.key, arr.filter((_, idx) => idx !== i))} className="text-slate-500 hover:text-red-400" disabled={disabled}>&times;</button>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (field.type === 'boolean') {
      return (
        <button
          onClick={() => updateField(field.key, !profile[field.key])}
          disabled={disabled}
          className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            profile[field.key] ? 'bg-sky-500' : 'bg-slate-700'
          }`}
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            profile[field.key] ? 'left-4' : 'left-0.5'
          }`} />
        </button>
      );
    }

    if (field.key === 'min_strike') {
      return (
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500">$</span>
          <input
            type="number"
            step={field.step}
            min={field.min}
            value={profile[field.key] === null ? '' : String(profile[field.key])}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              updateField(field.key, isNaN(val) ? null : val);
            }}
            placeholder="—"
            disabled={disabled}
            className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-right text-slate-100 tabular-nums placeholder:text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed"
          />
        </div>
      );
    }

    return (
      <div className="flex items-center gap-1">
        {field.unit && field.unit !== '$' && (
          <span className="text-xs text-slate-500">{field.unit}</span>
        )}
        <input
          type="number"
          step={field.step}
          min={field.min}
          value={String(profile[field.key])}
          onChange={(e) => {
            const val = field.type === 'integer' ? parseInt(e.target.value) : parseFloat(e.target.value);
            updateField(field.key, isNaN(val) ? 0 : val);
          }}
          disabled={disabled}
          className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-right text-slate-100 tabular-nums disabled:opacity-40 disabled:cursor-not-allowed"
        />
        {field.unit === '$' && <span className="text-xs text-slate-500">$</span>}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Settings</h1>
          <p className="text-sm text-slate-500 mt-0.5">All strategy rules are editable. Changes apply to the active profile.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={profile.id}
            onChange={(e) => handleSelectProfile(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
          >
            {state.profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' (Default)' : ''}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Profile name */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-48">
            <label className="block text-xs text-slate-500 mb-1">Profile Name</label>
            <input
              type="text"
              value={profile.name}
              onChange={(e) => updateField('name', e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
            />
          </div>
          <div className="flex items-center gap-2 pt-6">
            {saveError && (
              <span className="flex items-center gap-1.5 text-xs text-red-400 mr-2">
                <AlertCircle className="h-3.5 w-3.5" />
                {saveError}
              </span>
            )}
            <button
              onClick={handleSave}
              className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 transition-colors"
            >
              {saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
              {saved ? 'Saved' : 'Save'}
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 transition-colors"
            >
              <RotateCcw className="h-4 w-4" />
              Reset to Default
            </button>
            <button
              onClick={handleDuplicate}
              className="flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 transition-colors"
            >
              <Copy className="h-4 w-4" />
              Duplicate
            </button>
            {showNewInput ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  placeholder="New profile name"
                  className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 w-44"
                  autoFocus
                />
                <button onClick={handleCreateNew} className="rounded-lg bg-emerald-500 px-3 py-2 text-sm text-white hover:bg-emerald-600">
                  Create
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowNewInput(true)}
                className="flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 transition-colors"
              >
                <Plus className="h-4 w-4" />
                New Profile
              </button>
            )}
            {state.profiles.length > 1 && !profile.is_default && (
              <button
                onClick={() => state.deleteProfile(profile.id)}
                className="flex items-center gap-2 rounded-lg border border-red-900/50 px-3 py-2 text-sm text-red-400 hover:bg-red-900/20 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </Card>

      {/* Exclude Existing Positions — standalone, independent of section toggles */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label className="text-sm text-slate-300">Exclude Existing Positions</label>
            <p className="text-xs text-slate-500 mt-0.5">
              When ON, tickers you already hold open positions in are excluded from scan results. This setting is independent of the section toggles below and remains active even when all sections are OFF.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`text-xs font-medium ${profile.exclude_existing_positions ? 'text-sky-400' : 'text-slate-500'}`}>
              {profile.exclude_existing_positions ? 'ON' : 'OFF'}
            </span>
            {renderField({ key: 'exclude_existing_positions', label: '', type: 'boolean' }, false)}
          </div>
        </div>
      </Card>

      {/* Toggleable strategy rule sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {sections.map((section) => {
          const enabled = profile[section.enabledKey] as boolean;
          return (
            <div
              key={section.title}
              className={`rounded-xl border transition-opacity ${
                enabled
                  ? 'border-slate-800 bg-slate-900/50'
                  : 'border-slate-800/60 bg-slate-900/30 opacity-60'
              }`}
            >
              <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
                <h3 className="text-sm font-semibold text-slate-200">{section.title}</h3>
                <div className="flex items-center gap-2">
                  {!enabled && (
                    <span className="text-xs text-slate-500">Requirements disabled</span>
                  )}
                  <span className={`text-xs font-medium ${enabled ? 'text-sky-400' : 'text-slate-500'}`}>
                    {enabled ? 'ON' : 'OFF'}
                  </span>
                  <button
                    onClick={() => updateField(section.enabledKey, !enabled)}
                    className={`relative h-5 w-9 rounded-full transition-colors ${
                      enabled ? 'bg-sky-500' : 'bg-slate-700'
                    }`}
                  >
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                      enabled ? 'left-4' : 'left-0.5'
                    }`} />
                  </button>
                </div>
              </div>

              <div className="p-5 space-y-4">
                {section.fields.map((field) => (
                  <div key={field.key} className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <label className={`text-sm ${enabled ? 'text-slate-300' : 'text-slate-500'}`}>{field.label}</label>
                      {field.help && <p className="text-xs text-slate-500 mt-0.5">{field.help}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {renderField(field, !enabled)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {nonToggleSections.map((section) => (
          <Card key={section.title} title={section.title}>
            <div className="p-5 space-y-4">
              {section.fields.map((field) => (
                <div key={field.key} className="flex items-center justify-between gap-4">
                  <div>
                    <label className="text-sm text-slate-300">{field.label}</label>
                    {field.help && <p className="text-xs text-slate-500 mt-0.5">{field.help}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {renderField(field, false)}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">Order Type:</span>
          <span className="font-medium text-slate-200">LIMIT</span>
          <span className="text-xs text-slate-500">— Limit orders are a fixed system rule. Market orders are not supported.</span>
        </div>
      </div>

      <Card title="Volume Classifications (Reference)">
        <div className="p-5">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { label: 'Very Thin', range: '0-9', color: 'text-red-400' },
              { label: 'Thin', range: '10-24', color: 'text-amber-400' },
              { label: 'Meaningful', range: '25-49', color: 'text-slate-300' },
              { label: 'Good', range: '50-99', color: 'text-emerald-400' },
              { label: 'Very Good', range: '100-249', color: 'text-emerald-400' },
              { label: 'Excellent', range: '250+', color: 'text-emerald-400' },
            ].map((v) => (
              <div key={v.label} className="rounded-lg bg-slate-800/50 p-3 text-center">
                <div className={`text-sm font-medium ${v.color}`}>{v.label}</div>
                <div className="text-xs text-slate-500 mt-0.5">{v.range}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
