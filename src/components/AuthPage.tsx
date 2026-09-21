import { useState } from 'react';
import { LineChart, Mail, Loader2, CheckCircle2, ArrowLeft } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export function AuthPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;

    setLoading(true);
    setError(null);

    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          emailRedirectTo: window.location.origin,
        },
      });

      if (otpError) throw otpError;
      setSent(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not send sign-in link.';
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

        {sent ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-400 mx-auto mb-3" />
            <h2 className="text-sm font-semibold text-slate-200 mb-1.5">Check your email</h2>
            <p className="text-sm text-slate-400 mb-4">
              We sent a secure sign-in link to <span className="text-slate-300 font-medium">{email}</span>.
              Click the link in the email to sign in.
            </p>
            <button
              onClick={() => { setSent(false); setEmail(''); }}
              className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleSendLink} className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
            <h2 className="text-sm font-semibold text-slate-200 mb-1">Sign in to CSP Scanner</h2>
            <p className="text-xs text-slate-500 mb-5">
              We'll email you a secure sign-in link. No password needed.
            </p>

            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Email
            </label>
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

            {error && (
              <p className="text-sm text-red-400 mb-3">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mail className="h-4 w-4" />
              )}
              {loading ? 'Sending...' : 'Send Sign-In Link'}
            </button>

            <p className="text-xs text-slate-600 text-center mt-4">
              New here? Just enter your email — an account will be created automatically.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
