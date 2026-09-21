import { useState, useEffect, useCallback } from 'react';
import { Shield, Trash2, Loader2, AlertCircle, ArrowLeft, Search, ShieldCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Card } from '@/components/ui';
import { BackButton } from '@/components/Layout';
import type { Page } from '@/components/Layout';

type AdminUser = {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  is_admin: boolean;
};

export function AdminUsersPage({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError('No active session.');
        return;
      }
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-users`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${resp.status})`);
      }
      const data = await resp.json();
      if (!data || !Array.isArray(data.users)) {
        throw new Error('Unexpected response format.');
      }
      setUsers(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const handleDelete = async (userId: string) => {
    setDeletingId(userId);
    setDeleteError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setDeleteError('No active session.');
        return;
      }
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-users`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ userId }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${resp.status})`);
      }
      setUsers((prev) => prev.filter((u) => u.id !== userId));
      setConfirmId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete user.');
    } finally {
      setDeletingId(null);
    }
  };

  const filtered = users.filter((u) =>
    u.email.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="space-y-5 max-w-4xl">
      <BackButton onClick={() => onNavigate('profile')} />
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/10">
          <Shield className="h-6 w-6 text-sky-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Admin · User Management</h1>
          <p className="text-sm text-slate-500 mt-0.5">View and manage user accounts for this project.</p>
        </div>
      </div>

      {error && (
        <Card className="p-4 border-red-900/40">
          <div className="flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        </Card>
      )}

      {/* Search bar */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by email..."
          className="w-full rounded-lg border border-slate-700 bg-slate-800 pl-10 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500/50"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-sky-400" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-6 text-center text-sm text-slate-500">
          No users found.
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          {/* Table header */}
          <div className="hidden md:grid grid-cols-[1fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-slate-800 text-xs font-medium text-slate-500 uppercase tracking-wide">
            <span>Email</span>
            <span>Joined</span>
            <span>Last Sign In</span>
            <span>Actions</span>
          </div>

          {filtered.map((u) => (
            <div
              key={u.id}
              className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-2 md:gap-4 px-5 py-4 border-b border-slate-800/50 last:border-0 items-center"
            >
              <div className="flex items-center gap-2">
                {u.is_admin && <ShieldCheck className="h-4 w-4 text-sky-400 shrink-0" />}
                <span className="text-sm text-slate-200 truncate">{u.email}</span>
                {u.is_admin && (
                  <span className="text-[10px] font-semibold uppercase bg-sky-500/10 text-sky-400 px-1.5 py-0.5 rounded">Admin</span>
                )}
              </div>
              <div className="text-xs text-slate-400">
                {u.created_at ? new Date(u.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
              </div>
              <div className="text-xs text-slate-400">
                {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Never'}
              </div>
              <div className="flex items-center justify-end gap-2">
                {confirmId === u.id ? (
                  <div className="flex items-center gap-2">
                    {deletingId === u.id ? (
                      <Loader2 className="h-4 w-4 animate-spin text-red-400" />
                    ) : (
                      <>
                        <span className="text-xs text-red-300 hidden sm:inline">Confirm?</span>
                        <button
                          onClick={() => void handleDelete(u.id)}
                          className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => { setConfirmId(null); setDeleteError(null); }}
                          className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400 hover:bg-slate-800 transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                ) : u.is_admin ? (
                  <span className="text-xs text-slate-600">Protected</span>
                ) : (
                  <button
                    onClick={() => { setConfirmId(u.id); setDeleteError(null); }}
                    className="flex items-center gap-1.5 rounded-md border border-red-900/50 px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-900/20 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      {deleteError && (
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4" />
          {deleteError}
        </div>
      )}

      <p className="text-xs text-slate-500">
        Admin accounts are protected and cannot be deleted from this page. Deleting a user permanently removes their account and all associated data.
      </p>
    </div>
  );
}
