import { useState } from 'react';
import { Mail, Lock, UserPlus, CheckCircle2, ArrowLeft } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { AuthState } from '@/lib/useAuth';
import { AuthShell, AuthInput, SubmitButton, SwitchLink } from '@/pages/auth/SignInPage';

export function SignUpPage({ auth }: { auth: AuthState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationRequired, setConfirmationRequired] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !password) return;
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: trimmed,
        password,
      });
      if (signUpError) throw signUpError;

      if (data.user && !data.session) {
        setConfirmationRequired(true);
      } else if (data.session) {
        auth.setAuthRoute(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed.');
    } finally {
      setLoading(false);
    }
  };

  if (confirmationRequired) {
    return (
      <AuthShell>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-400 mx-auto mb-3" />
          <h2 className="text-sm font-semibold text-slate-200 mb-1.5">Check your email</h2>
          <p className="text-sm text-slate-400 mb-4">
            Check your email to confirm your account before signing in.
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
        <h2 className="text-sm font-semibold text-slate-200 mb-1">Create your account</h2>
        <p className="text-xs text-slate-500 mb-5">Enter an email and password to create a new account.</p>

        <AuthInput icon={<Mail className="h-4 w-4 text-slate-500" />} label="Email Address" type="email" value={email} onChange={setEmail} placeholder="email@example.com" />
        <AuthInput icon={<Lock className="h-4 w-4 text-slate-500" />} label="Password" type="password" value={password} onChange={setPassword} placeholder="Choose a password" minLength={8} />
        <AuthInput icon={<Lock className="h-4 w-4 text-slate-500" />} label="Confirm Password" type="password" value={confirmPassword} onChange={setConfirmPassword} placeholder="Re-enter password" minLength={8} />

        {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

        <SubmitButton loading={loading} disabled={!email.trim() || !password || !confirmPassword} icon={<UserPlus className="h-4 w-4" />} label="Create Account" />

        <SwitchLink onClick={() => auth.setAuthRoute('signin')} text="Already have an account? Sign In" />
      </form>
    </AuthShell>
  );
}
