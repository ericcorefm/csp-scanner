import { useState } from 'react';
import { Mail, KeyRound, CheckCircle2, ArrowLeft } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { AuthState } from '@/lib/useAuth';
import { AuthShell, AuthInput, SubmitButton } from '@/pages/auth/SignInPage';

export function ForgotPasswordPage({ auth }: { auth: AuthState }) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;

    setLoading(true);
    setError(null);

    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(trimmed, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (resetError) throw resetError;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send reset email.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <AuthShell>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-400 mx-auto mb-3" />
          <h2 className="text-sm font-semibold text-slate-200 mb-1.5">Reset link sent</h2>
          <p className="text-sm text-slate-400 mb-4">
            Password reset link sent. Check your email.
          </p>
          <button
            onClick={() => auth.setAuthRoute('signin')}
            className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to sign in
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
        <h2 className="text-sm font-semibold text-slate-200 mb-1">Reset Password</h2>
        <p className="text-xs text-slate-500 mb-5">Enter the email address associated with your account.</p>

        <AuthInput icon={<Mail className="h-4 w-4 text-slate-500" />} label="Email Address" type="email" value={email} onChange={setEmail} placeholder="email@example.com" />

        {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

        <SubmitButton loading={loading} disabled={!email.trim()} icon={<KeyRound className="h-4 w-4" />} label="Send Reset Link" />

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => auth.setAuthRoute('signin')}
            className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to sign in
          </button>
        </div>
      </form>
    </AuthShell>
  );
}
