import { useState } from 'react';
import { LineChart, Mail, Lock, Loader2, ArrowLeft, UserPlus, LogIn } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export function AuthPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !password) return;

    setLoading(true);
    setError(null);

    try {
      if (mode === 'signup') {
        const { error: signUpError } = await supabase.auth.signUp({
          email: trimmed,
          password,
        });
        if (signUpError) throw signUpError;
        // Email confirmation is OFF, so session is established immediately.
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: trimmed,
          password,
        });
        if (signInError) throw signInError;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Authentication failed.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center gap-2.5 mb-8 justify-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/10">
            <LineChart className="h-6 w-6 text-sky-400" />
          </div>
          <div className="text-center">
            <div className="font-semibold text-lg text-slate-100">CSP Scanner</div>
            <div className="text-xs text-slate-500">Cash-Secured Puts</div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
          <h2 className="text-sm font-semibold text-slate-200 mb-1">
            {mode === 'signin' ? 'Sign in to CSP Scanner' : 'Create your account'}
          </h2>
          <p className="text-xs text-slate-500 mb-5">
            {mode === 'signin'
              ? 'Enter your email and password to continue.'
              : 'Enter an email and password to create a new account.'}
          </p>

          <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
          <div className="relative mb-4">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              required
              autoFocus
              className="w-full rounded-lg border border-slate-700 bg-slate-800 pl-10 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/50"
            />
          </div>

          <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
          <div className="relative mb-4">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'Choose a password' : 'Your password'}
              required
              minLength={6}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 pl-10 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/50"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400 mb-3">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !email.trim() || !password}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : mode === 'signin' ? (
              <LogIn className="h-4 w-4" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            {loading
              ? 'Please wait...'
              : mode === 'signin'
                ? 'Sign In'
                : 'Create Account'}
          </button>

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setError(null);
              }}
              className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {mode === 'signin'
                ? "Don't have an account? Sign up"
                : 'Already have an account? Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
