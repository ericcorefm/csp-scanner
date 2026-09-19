import { useState } from 'react';
import { Save, RotateCcw, Copy, Plus, Trash2, Check } from 'lucide-react';
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

const sections: { title: string; icon: string; fields: FieldDef[] }[] = [
  {
    title: 'Order & Strike',
    icon: 'order',
    fields: [
      { key: 'order_type', label: 'Order Type', type: 'text', help: 'Limit orders recommended for options.' },
      { key: 'max_strike', label: 'Maximum Put Strike', type: 'number', unit: '$', step: '0.5' },
      { key: 'min_strike', label: 'Minimum Put Strike', type: 'number', unit: '$', step: '0.5', help: 'Leave blank for no minimum.' },
      { key: 'preferred_strikes', label: 'Preferred Strike Prices', type: 'number_array', help: 'Comma-separated (e.g. 10,12,13,15,20,25). If empty, scan all within min/max range.', placeholder: '10,12,13,15,20,25' },
    ],
  },
  {
    title: 'Expiration',
    icon: 'expiration',
    fields: [
      { key: 'min_dte', label: 'Minimum DTE', type: 'integer', unit: 'days', help: 'Minimum days to expiration.' },
      { key: 'max_dte', label: 'Maximum DTE', type: 'integer', unit: 'days', help: 'Maximum days to expiration.' },
      { key: 'preferred_expirations', label: 'Preferred Expiration Dates', type: 'date_array', help: 'Specific dates (YYYY-MM-DD). If empty, use DTE range.', placeholder: '2028-01-21' },
    ],
  },
  {
    title: 'CROI & Premium Capture',
    icon: 'croi',
    fields: [
      { key: 'min_net_croi', label: 'Minimum Net CROI', type: 'number', unit: '%', step: '0.1' },
      { key: 'preferred_croi_max', label: 'Preferred CROI Maximum', type: 'number', unit: '%', step: '0.1' },
      { key: 'max_premium_capture', label: 'Maximum Premium Capture', type: 'number', unit: '%', step: '1' },
    ],
  },
  {
    title: 'Cycle & Liquidity',
    icon: 'cycle',
    fields: [
      { key: 'max_recycle_days', label: 'Maximum Cycle Days', type: 'integer', unit: 'days' },
      { key: 'min_target_oi', label: 'Minimum Target OI', type: 'integer' },
      { key: 'preferred_daily_volume', label: 'Preferred Daily Volume', type: 'integer' },
    ],
  },
  {
    title: 'Bid/Ask Spread',
    icon: 'spread',
    fields: [
      { key: 'preferred_spread_pct', label: 'Preferred Spread', type: 'number', unit: '%', step: '0.5' },
      { key: 'max_spread_pct', label: 'Maximum Spread', type: 'number', unit: '%', step: '0.5' },
    ],
  },
  {
    title: 'Technical Rules',
    icon: 'tech',
    fields: [
      { key: 'rsi_min', label: 'RSI Minimum', type: 'integer' },
      { key: 'rsi_max', label: 'RSI Maximum', type: 'integer' },
      { key: 'require_ma20_above_ma50', label: 'Require MA20 > MA50', type: 'boolean' },
      { key: 'require_ma50_above_ma200', label: 'Require MA50 > MA200', type: 'boolean' },
      { key: 'require_price_above_ma200', label: 'Require Price > MA200', type: 'boolean' },
    ],
  },
  {
    title: 'Short Interest',
    icon: 'si',
    fields: [
      { key: 'short_interest_warning', label: 'Short Interest Warning', type: 'number', unit: '%', step: '0.5' },
      { key: 'short_interest_exclusion', label: 'Short Interest Exclusion', type: 'number', unit: '%', step: '0.5' },
    ],
  },
  {
    title: 'Commission & BTC',
    icon: 'btc',
    fields: [
      { key: 'round_trip_commission', label: 'Round-Trip Commission', type: 'number', unit: '$', step: '0.01' },
      { key: 'btc_increment', label: 'BTC Increment', type: 'number', unit: '$', step: '0.01' },
      { key: 'allow_penny_increments', label: 'Allow Penny Increments', type: 'boolean' },
    ],
  },
  {
    title: 'Filtering',
    icon: 'filter',
    fields: [
      { key: 'exclude_existing_positions', label: 'Exclude Existing Positions', type: 'boolean' },
      { key: 'exclude_downtrend_no_support', label: 'Exclude Downtrend Without Support', type: 'boolean' },
    ],
  },
];

export function SettingsPage({ state }: { state: AppState }) {
  const [profile, setProfile] = useState<StrategyProfile | null>(state.activeProfile);
  const [saved, setSaved] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [showNewInput, setShowNewInput] = useState(false);

  if (!profile) return <div className="text-slate-400">Loading...</div>;

  const updateField = (key: keyof StrategyProfile, value: string | number | boolean | string[] | number[]) => {
    setProfile({ ...profile, [key]: value });
    setSaved(false);
  };

  const handleSave = async () => {
    await state.saveProfile(profile);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    state.resetProfile();
    if (state.activeProfile) {
      setProfile({ ...state.activeProfile });
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

      {/* Strategy rule sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {sections.map((section) => (
          <Card key={section.title} title={section.title}>
            <div className="p-5 space-y-4">
              {section.fields.map((field) => (
                <div key={field.key} className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <label className="text-sm text-slate-300">{field.label}</label>
                    {field.help && <p className="text-xs text-slate-500 mt-0.5">{field.help}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {field.key === 'order_type' ? (
                      <select
                        value={String(profile[field.key]) || 'LIMIT'}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        className="w-28 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100"
                      >
                        <option value="LIMIT">LIMIT</option>
                      </select>
                    ) : field.type === 'date_array' ? (
                      <div className="flex flex-col items-end gap-1">
                        <input
                          type="text"
                          value={(profile[field.key] as string[]).join(', ')}
                          onChange={(e) => {
                            const vals = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
                            updateField(field.key, vals);
                          }}
                          placeholder={field.placeholder || 'YYYY-MM-DD, ...'}
                          className="w-48 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600"
                        />
                        {(profile[field.key] as string[]).length > 0 && (
                          <div className="flex flex-wrap gap-1 justify-end max-w-48">
                            {(profile[field.key] as string[]).map((d) => (
                              <span key={d} className="inline-flex items-center gap-1 rounded bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-300">
                                {d}
                                <button onClick={() => updateField(field.key, (profile[field.key] as string[]).filter((x) => x !== d))} className="text-slate-500 hover:text-red-400">&times;</button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : field.type === 'number_array' ? (
                      <div className="flex flex-col items-end gap-1">
                        <input
                          type="text"
                          value={(profile[field.key] as number[]).join(', ')}
                          onChange={(e) => {
                            const vals = e.target.value.split(',').map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v));
                            updateField(field.key, vals);
                          }}
                          placeholder={field.placeholder || 'e.g. 10,12,15,25'}
                          className="w-48 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-600"
                        />
                        {(profile[field.key] as number[]).length > 0 && (
                          <div className="flex flex-wrap gap-1 justify-end max-w-48">
                            {(profile[field.key] as number[]).map((s, i) => (
                              <span key={i} className="inline-flex items-center gap-1 rounded bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-300">
                                ${s}
                                <button onClick={() => updateField(field.key, (profile[field.key] as number[]).filter((_, idx) => idx !== i))} className="text-slate-500 hover:text-red-400">&times;</button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : field.type === 'boolean' ? (
                      <button
                        onClick={() => updateField(field.key, !profile[field.key])}
                        className={`relative h-5 w-9 rounded-full transition-colors ${
                          profile[field.key] ? 'bg-sky-500' : 'bg-slate-700'
                        }`}
                      >
                        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                          profile[field.key] ? 'left-4' : 'left-0.5'
                        }`} />
                      </button>
                    ) : field.key === 'min_strike' ? (
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
                          className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-right text-slate-100 tabular-nums placeholder:text-slate-600"
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        {field.unit && field.unit !== '$' && (
                          <span className="text-xs text-slate-500">{field.unit}</span>
                        )}
                        <input
                          type={field.type === 'integer' ? 'number' : 'number'}
                          step={field.step}
                          min={field.min}
                          value={String(profile[field.key])}
                          onChange={(e) => {
                            const val = field.type === 'integer' ? parseInt(e.target.value) : parseFloat(e.target.value);
                            updateField(field.key, isNaN(val) ? 0 : val);
                          }}
                          className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-right text-slate-100 tabular-nums"
                        />
                        {field.unit === '$' && <span className="text-xs text-slate-500">$</span>}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>

      {/* Volume classification reference */}
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
