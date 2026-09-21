import { useState } from 'react';
import { Lock, KeyRound, CheckCircle2, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { AuthState } from '@/lib/useAuth';
import { AuthShell, AuthInput, SubmitButton } from '@/pages/auth/SignInPage';

export function ResetPasswordPage({ auth }: { auth: AuthState }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword) return;
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      await supabase.auth.signOut();
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update password.');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <AuthShell>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-400 mx-auto mb-3" />
          <h2 className="text-sm font-semibold text-slate-200 mb-1.5">Password updated successfully</h2>
          <p className="text-sm text-slate-400 mb-4">Your password has been changed. You can now sign in.</p>
          <button
            onClick={() => auth.setAuthRoute('signin')}
            className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:text-sky-300 transition-colors"
          >
            Go to sign in
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
        <h2 className="text-sm font-semibold text-slate-200 mb-1">Set New Password</h2>
        <p className="text-xs text-slate-500 mb-5">Enter a new password for your account.</p>

        <AuthInput icon={<Lock className="h-4 w-4 text-slate-500" />} label="New Password" type="password" value={newPassword} onChange={setNewPassword} placeholder="New password" minLength={8} />
        <AuthInput icon={<Lock className="h-4 w-4 text-slate-500" />} label="Confirm Password" type="password" value={confirmPassword} onChange={setConfirmPassword} placeholder="Confirm new password" minLength={8} />

        {newPassword && confirmPassword && newPassword !== confirmPassword && (
          <p className="flex items-center gap-1.5 text-xs text-red-400 mb-3">
            <AlertCircle className="h-3.5 w-3.5" /> Passwords do not match.
          </p>
        )}
        {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

        <SubmitButton loading={loading} disabled={!newPassword || !confirmPassword} icon={<KeyRound className="h-4 w-4" />} label="Update Password" />
      </form>
    </AuthShell>
  );
}
