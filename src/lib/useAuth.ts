import { useState, useEffect, useCallback } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export type AuthRoute = 'signin' | 'signup' | 'forgot-password' | 'reset-password' | null;

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authRoute, setAuthRoute] = useState<AuthRoute>(null);

  useEffect(() => {
    // Determine initial auth route from URL path
    const path = window.location.pathname;
    const routeMap: Record<string, AuthRoute> = {
      '/signin': 'signin',
      '/signup': 'signup',
      '/forgot-password': 'forgot-password',
      '/reset-password': 'reset-password',
    };
    const initialRoute = routeMap[path] ?? null;
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const recoveryFromUrl =
      initialRoute === 'reset-password' ||
      hashParams.get('type') === 'recovery' ||
      new URLSearchParams(window.location.search).get('type') === 'recovery';
    let inPasswordRecovery = recoveryFromUrl;

    if (recoveryFromUrl) {
      setAuthRoute('reset-password');
      if (path !== '/reset-password') {
        window.history.replaceState(null, '', '/reset-password');
      }
    }

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      setAuthLoading(false);
      if (initialRoute && (!s || initialRoute === 'reset-password')) setAuthRoute(initialRoute);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, s) => {
      (async () => {
        setSession(s);
        setUser(s?.user ?? null);
        setAuthLoading(false);

        if (event === 'PASSWORD_RECOVERY') {
          inPasswordRecovery = true;
          setAuthRoute('reset-password');
        } else if (inPasswordRecovery) {
          // Stay on reset-password until the user submits a new password,
          // even if Supabase fires session events with a valid recovery session.
        } else if (event === 'SIGNED_OUT') {
          setAuthRoute('signin');
        } else if (s) {
          setAuthRoute(null);
        }
      })();
    });

    return () => {
      subscription.subscription.unsubscribe();
    };
  }, []);

  const navigateToAuthRoute = useCallback((route: AuthRoute) => {
    if (route) {
      const pathMap: Record<NonNullable<AuthRoute>, string> = {
        'signin': '/signin',
        'signup': '/signup',
        'forgot-password': '/forgot-password',
        'reset-password': '/reset-password',
      };
      window.history.replaceState(null, '', pathMap[route]);
    } else {
      window.history.replaceState(null, '', '/');
    }
    setAuthRoute(route);
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setAuthRoute('signin');
    window.history.replaceState(null, '', '/signin');
  }, []);

  return { user, session, authLoading, authRoute, setAuthRoute: navigateToAuthRoute, signOut };
}

export type AuthState = ReturnType<typeof useAuth>;
