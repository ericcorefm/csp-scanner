import { useState } from 'react';
import { LineChart, Mail, Lock, Loader2, LogIn, ArrowLeft } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { AuthState } from '@/lib/useAuth';

export function SignInPage({ auth }: { auth: AuthState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !password) return;

    setLoading(true);
    setError(null);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: trimmed,
        password,
      });
      if (signInError) throw signInError;
      auth.setAuthRoute(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
        <h2 className="text-sm font-semibold text-slate-200 mb-1">Sign in to CSP Scanner</h2>
        <p className="text-xs text-slate-500 mb-5">Enter your email and password to continue.</p>

        <AuthInput icon={<Mail className="h-4 w-4 text-slate-500" />} label="Email Address" type="email" value={email} onChange={setEmail} placeholder="email@example.com" />

        <AuthInput icon={<Lock className="h-4 w-4 text-slate-500" />} label="Password" type="password" value={password} onChange={setPassword} placeholder="Your password" />

        {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

        <SubmitButton loading={loading} disabled={!email.trim() || !password} icon={<LogIn className="h-4 w-4" />} label="Sign In" />

        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={() => auth.setAuthRoute('forgot-password')}
            className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            Forgot password?
          </button>
        </div>

        <SwitchLink onClick={() => auth.setAuthRoute('signup')} text="Don't have an account? Create Account" />
      </form>
    </AuthShell>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-8 justify-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/10">
            <LineChart className="h-6 w-6 text-sky-400" />
          </div>
          <div className="text-center">
            <div className="font-semibold text-lg text-slate-100">CSP Scanner</div>
            <div className="text-xs text-slate-500">Cash-Secured Puts</div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function AuthInput({
  icon, label, type, value, onChange, placeholder, minLength,
}: {
  icon: React.ReactNode;
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minLength?: number;
}) {
  return (
    <>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>
      <div className="relative mb-4">
        <div className="absolute left-3 top-1/2 -translate-y-1/2">{icon}</div>
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required
          minLength={minLength}
          autoFocus={type === 'email'}
          className="w-full rounded-lg border border-slate-700 bg-slate-800 pl-10 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/50"
        />
      </div>
    </>
  );
}

export function SubmitButton({
  loading, disabled, icon, label,
}: {
  loading: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="w-full flex items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {loading ? 'Please wait...' : label}
    </button>
  );
}

export function SwitchLink({ onClick, text }: { onClick: () => void; text: string }) {
  return (
    <div className="mt-4 text-center">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {text}
      </button>
    </div>
  );
}
