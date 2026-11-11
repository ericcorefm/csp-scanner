import { useState, useEffect } from 'react';
import { User as UserIcon, Mail, Lock, Loader2, AlertCircle, CheckCircle2, KeyRound } from 'lucide-react';
import { Card } from '@/components/ui';
import { supabase } from '@/lib/supabase';

interface AccountSettingsPageProps {
  userEmail: string;
  onUpdateEmail: (email: string) => Promise<void>;
  onUpdateDisplayName: (name: string) => Promise<void>;
  onUpdatePassword: (password: string) => Promise<void>;
}

export function AccountSettingsPage({ userEmail, onUpdateEmail, onUpdateDisplayName, onUpdatePassword }: AccountSettingsPageProps) {
  const [displayName, setDisplayName] = useState('');
  const [originalDisplayName, setOriginalDisplayName] = useState('');
  const [nameLoading, setNameLoading] = useState(true);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [newEmail, setNewEmail] = useState(userEmail);
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user: u } } = await supabase.auth.getUser();
      if (!u || cancelled) return;
      const { data, error } = await supabase
        .from('user_profiles')
        .select('display_name')
        .eq('user_id', u.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setNameLoading(false);
        return;
      }
      const name = data?.display_name ?? '';
      setDisplayName(name);
      setOriginalDisplayName(name);
      setNameLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setNameMsg(null);
    setNameSaving(true);
    try {
      await onUpdateDisplayName(displayName.trim());
      setOriginalDisplayName(displayName.trim());
      setNameMsg({ type: 'success', text: 'Name saved.' });
    } catch {
      setNameMsg({ type: 'error', text: 'Could not save name. Please try again.' });
    } finally {
      setNameSaving(false);
    }
  };

  const handleSaveEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailMsg(null);
    setEmailSaving(true);
    try {
      await onUpdateEmail(newEmail.trim());
      setEmailMsg({ type: 'success', text: 'Email updated. If email confirmation is required, you\'ll get a verification link at the new address.' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('already') && msg.includes('registered')) {
        setEmailMsg({ type: 'error', text: 'That email is already in use by another account.' });
      } else if (msg.includes('rate limit') || msg.includes('Rate limit')) {
        setEmailMsg({ type: 'error', text: 'Too many attempts. Please wait a minute and try again.' });
      } else {
        setEmailMsg({ type: 'error', text: 'Could not update email. Please try again.' });
      }
    } finally {
      setEmailSaving(false);
    }
  };

  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (newPassword.length < 6) {
      setPwMsg({ type: 'error', text: 'Password must be at least 6 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwMsg({ type: 'error', text: 'Passwords do not match.' });
      return;
    }
    setPwSaving(true);
    try {
      await onUpdatePassword(newPassword);
      setPwMsg({ type: 'success', text: 'Password updated.' });
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('rate limit') || msg.includes('Rate limit')) {
        setPwMsg({ type: 'error', text: 'Too many attempts. Please wait a minute and try again.' });
      } else {
        setPwMsg({ type: 'error', text: 'Could not update password. Please try again.' });
      }
    } finally {
      setPwSaving(false);
    }
  };

  const nameChanged = displayName.trim() !== originalDisplayName.trim();
  const emailChanged = newEmail.trim() !== userEmail.trim();

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">Account Settings</h2>
        <p className="text-sm text-slate-500 mt-0.5">Manage your name, email, and password.</p>
      </div>

      {/* Display Name */}
      <Card>
        <div className="flex items-center gap-2 border-b border-slate-800 px-5 py-3">
          <UserIcon className="h-4 w-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-200">Display Name</h3>
        </div>
        <form onSubmit={handleSaveName} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={nameLoading}
              placeholder={nameLoading ? 'Loading...' : 'Your name'}
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition-colors disabled:opacity-50"
            />
          </div>
          {nameMsg && <MsgBanner type={nameMsg.type} text={nameMsg.text} />}
          <button
            type="submit"
            disabled={nameSaving || !nameChanged || nameLoading}
            className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {nameSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserIcon className="h-4 w-4" />}
            <span>Save Name</span>
          </button>
        </form>
      </Card>

      {/* Email */}
      <Card>
        <div className="flex items-center gap-2 border-b border-slate-800 px-5 py-3">
          <Mail className="h-4 w-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-200">Email Address</h3>
        </div>
        <form onSubmit={handleSaveEmail} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
            <input
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>
          {emailMsg && <MsgBanner type={emailMsg.type} text={emailMsg.text} />}
          <button
            type="submit"
            disabled={emailSaving || !emailChanged}
            className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {emailSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            <span>Update Email</span>
          </button>
        </form>
      </Card>

      {/* Password */}
      <Card>
        <div className="flex items-center gap-2 border-b border-slate-800 px-5 py-3">
          <KeyRound className="h-4 w-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-200">Change Password</h3>
        </div>
        <form onSubmit={handleSavePassword} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">New password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full rounded-lg border border-slate-800 bg-slate-950 pl-10 pr-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition-colors"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Confirm new password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                type="password"
                required
                minLength={6}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter new password"
                className="w-full rounded-lg border border-slate-800 bg-slate-950 pl-10 pr-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 transition-colors"
              />
            </div>
          </div>
          {pwMsg && <MsgBanner type={pwMsg.type} text={pwMsg.text} />}
          <button
            type="submit"
            disabled={pwSaving || !newPassword || !confirmPassword}
            className="flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pwSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            <span>Update Password</span>
          </button>
        </form>
      </Card>
    </div>
  );
}

function MsgBanner({ type, text }: { type: 'success' | 'error'; text: string }) {
  const Icon = type === 'success' ? CheckCircle2 : AlertCircle;
  const colors = type === 'success'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
    : 'border-red-500/30 bg-red-500/10 text-red-400';
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 ${colors}`}>
      <Icon className="h-4 w-4 mt-0.5 shrink-0" />
      <span className="text-sm">{text}</span>
    </div>
  );
}
