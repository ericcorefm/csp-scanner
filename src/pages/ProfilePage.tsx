import { useState } from 'react';
import { Mail, Lock, KeyRound, Loader2, Check, AlertCircle, LogOut, UserCircle, Calendar, Trash2, AlertTriangle } from 'lucide-react';
import type { AuthState } from '@/lib/useAuth';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ProfilePage({ auth }: { auth: AuthState }) {
  const userEmail = auth.user?.email ?? '';
  const createdAt = auth.user?.created_at;

  // Password change
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwdLoading, setPwdLoading] = useState(false);
  const [pwdSuccess, setPwdSuccess] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);

  // Email change
  const [newEmail, setNewEmail] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailSuccess, setEmailSuccess] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || newPassword !== confirmPassword) return;
    if (newPassword.length < 8) {
      setPwdError('Password must be at least 8 characters.');
      return;
    }
    setPwdLoading(true);
    setPwdError(null);
    setPwdSuccess(false);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      setPwdSuccess(true);
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => {
        setPwdSuccess(false);
        setShowChangePassword(false);
      }, 2500);
    } catch (err) {
      setPwdError(err instanceof Error ? err.message : 'Failed to change password.');
    } finally {
      setPwdLoading(false);
    }
  };

  const handleChangeEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed) return;
    if (!EMAIL_REGEX.test(trimmed)) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    if (trimmed === userEmail.toLowerCase()) {
      setEmailError('New email must be different from your current email.');
      return;
    }
    setEmailLoading(true);
    setEmailError(null);
    setEmailSuccess(false);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ email: trimmed });
      if (updateError) throw updateError;
      setEmailSuccess(true);
      setNewEmail('');
      // Refresh the session so the auth state stays current
      await supabase.auth.refreshSession();
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : 'Failed to update email.');
    } finally {
      setEmailLoading(false);
    }
  };

  // Delete account
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDeleteAccount = async () => {
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setDeleteError('No active session. Please sign in again.');
        return;
      }
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-account`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${resp.status})`);
      }
      await supabase.auth.signOut();
      auth.setAuthRoute('signin');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete account.');
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/10">
          <UserCircle className="h-6 w-6 text-sky-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Profile</h1>
          <p className="text-sm text-slate-500 mt-0.5">Your account information and security settings.</p>
        </div>
      </div>

      {/* Account info — current email + member since */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-slate-200 mb-4">Account Information</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Current Email</label>
            <div className="relative max-w-sm">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="email"
                value={userEmail}
                readOnly
                className="w-full rounded-lg border border-slate-700 bg-slate-800/60 pl-10 pr-3 py-2.5 text-sm text-slate-300 cursor-not-allowed"
              />
            </div>
          </div>
          {createdAt && (
            <div>
              <label className="block text-xs text-slate-500 mb-1">Member Since</label>
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <Calendar className="h-4 w-4 text-slate-500" />
                {new Date(createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Change email */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-slate-200 mb-1">Change Email</h3>
        <p className="text-xs text-slate-500 mb-4">
          Enter a new email address. A confirmation link will be sent to the new address to complete the change.
        </p>
        <form onSubmit={handleChangeEmail} className="space-y-3">
          <label className="block text-xs text-slate-500">New Email Address</label>
          <div className="relative max-w-sm">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input
              type="email"
              value={newEmail}
              onChange={(e) => { setNewEmail(e.target.value); setEmailError(null); setEmailSuccess(false); }}
              placeholder="new-email@example.com"
              required
              className="w-full rounded-lg border border-slate-700 bg-slate-800 pl-10 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/50"
            />
          </div>
          {emailError && (
            <p className="flex items-center gap-1.5 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5" /> {emailError}
            </p>
          )}
          {emailSuccess && (
            <p className="flex items-center gap-1.5 text-xs text-emerald-400">
              <Check className="h-3.5 w-3.5" /> Check your email to confirm the new email address.
            </p>
          )}
          <button
            type="submit"
            disabled={emailLoading || !newEmail.trim()}
            className="flex items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
          >
            {emailLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            {emailLoading ? 'Sending...' : 'Update Email'}
          </button>
        </form>
      </Card>

      {/* Security — change password */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-slate-200 mb-1">Security</h3>
        <p className="text-xs text-slate-500 mb-4">Change your account password.</p>

        {!showChangePassword ? (
          <button
            onClick={() => setShowChangePassword(true)}
            className="flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800 transition-colors"
          >
            <KeyRound className="h-4 w-4" />
            Change Password
          </button>
        ) : (
          <form onSubmit={handleChangePassword} className="space-y-3">
            <div className="relative max-w-sm">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setPwdError(null); setPwdSuccess(false); }}
                placeholder="New password"
                minLength={8}
                required
                autoFocus
                className="w-full rounded-lg border border-slate-700 bg-slate-800 pl-10 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/50"
              />
            </div>
            <div className="relative max-w-sm">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setPwdError(null); setPwdSuccess(false); }}
                placeholder="Confirm new password"
                minLength={8}
                required
                className="w-full rounded-lg border border-slate-700 bg-slate-800 pl-10 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/50"
              />
            </div>
            {newPassword && confirmPassword && newPassword !== confirmPassword && (
              <p className="flex items-center gap-1.5 text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5" /> Passwords do not match.
              </p>
            )}
            {pwdError && (
              <p className="flex items-center gap-1.5 text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5" /> {pwdError}
              </p>
            )}
            {pwdSuccess && (
              <p className="flex items-center gap-1.5 text-xs text-emerald-400">
                <Check className="h-3.5 w-3.5" /> Password changed successfully.
              </p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={pwdLoading || !newPassword || newPassword !== confirmPassword}
                className="flex items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
              >
                {pwdLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Change Password
              </button>
              <button
                type="button"
                onClick={() => { setShowChangePassword(false); setNewPassword(''); setConfirmPassword(''); setPwdError(null); }}
                className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-400 hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </Card>

      {/* Sign out */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-slate-200 mb-1">Sign Out</h3>
        <p className="text-xs text-slate-500 mb-4">Sign out of your account on this device.</p>
        <button
          onClick={() => void auth.signOut()}
          className="flex items-center justify-center gap-2 rounded-lg border border-red-900/50 px-4 py-2.5 text-sm font-medium text-red-400 hover:bg-red-900/20 transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </button>
      </Card>

      {/* Delete account — danger zone */}
      <Card className="p-5 border-red-900/40">
        <h3 className="text-sm font-semibold text-red-300 mb-1">Delete Account</h3>
        <p className="text-xs text-slate-500 mb-4">
          Permanently delete your account and all associated data. This action cannot be undone.
        </p>

        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="flex items-center justify-center gap-2 rounded-lg border border-red-900/50 px-4 py-2.5 text-sm font-medium text-red-400 hover:bg-red-900/20 transition-colors"
          >
            <Trash2 className="h-4 w-4" />
            Delete Account
          </button>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-2.5 rounded-lg border border-red-900/40 bg-red-900/10 p-3">
              <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">
                You are about to permanently delete your account. All your data will be removed and cannot be recovered.
              </p>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1.5">
                Type <span className="text-red-400 font-semibold">DELETE</span> to confirm
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => { setDeleteConfirmText(e.target.value); setDeleteError(null); }}
                placeholder="DELETE"
                autoFocus
                className="w-full max-w-sm rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500/50"
              />
            </div>
            {deleteError && (
              <p className="flex items-center gap-1.5 text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5" /> {deleteError}
              </p>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleDeleteAccount()}
                disabled={deleteLoading || deleteConfirmText !== 'DELETE'}
                className="flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
              >
                {deleteLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {deleteLoading ? 'Deleting...' : 'Permanently Delete'}
              </button>
              <button
                type="button"
                onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(''); setDeleteError(null); }}
                className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-400 hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
