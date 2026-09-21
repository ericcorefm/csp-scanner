import { useState, useEffect, useCallback, useRef } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export type AuthRoute = 'signin' | 'signup' | 'forgot-password' | 'reset-password' | null;

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authRoute, setAuthRouteState] = useState<AuthRoute>(null);
  const inPasswordRecovery = useRef(false);

  useEffect(() => {
    // Detect recovery token from URL (path, hash, or query string)
    const path = window.location.pathname;
    const routeMap: Record<string, AuthRoute> = {
      '/signin': 'signin',
      '/signup': 'signup',
      '/forgot-password': 'forgot-password',
      '/reset-password': 'reset-password',
    };
    const initialRoute = routeMap[path] ?? null;
    const hashStr = window.location.hash.replace(/^#/, '');
    const hashParams = new URLSearchParams(hashStr);
    const searchParams = new URLSearchParams(window.location.search);
    const isRecovery =
      initialRoute === 'reset-password' ||
      hashParams.get('type') === 'recovery' ||
      hashParams.get('token_type') === 'recovery' ||
      searchParams.get('type') === 'recovery' ||
      searchParams.get('token_type') === 'recovery';

    if (isRecovery) {
      inPasswordRecovery.current = true;
      setAuthRouteState('reset-password');
      if (path !== '/reset-password') {
        window.history.replaceState(null, '', '/reset-password');
      }
    } else if (initialRoute) {
      setAuthRouteState(initialRoute);
    }

    // Register onAuthStateChange BEFORE getSession() so we don't miss any events
    const { data: subscription } = supabase.auth.onAuthStateChange((event, s) => {
      (async () => {
        setSession(s);
        setUser(s?.user ?? null);
        setAuthLoading(false);

        if (event === 'PASSWORD_RECOVERY') {
          inPasswordRecovery.current = true;
          setAuthRouteState('reset-password');
        } else if (inPasswordRecovery.current) {
          // Stay on reset-password — ignore session events during recovery
        } else if (event === 'SIGNED_OUT') {
          setAuthRouteState('signin');
        } else if (event === 'INITIAL_SESSION' && !s && initialRoute) {
          // No session and we have an initial route — keep it
          setAuthRouteState(initialRoute);
        } else if (s) {
          setAuthRouteState(null);
        }
      })();
    });

    // Now call getSession()
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      setAuthLoading(false);

      if (inPasswordRecovery.current) {
        setAuthRouteState('reset-password');
      } else if (initialRoute && !s) {
        setAuthRouteState(initialRoute);
      } else if (s && !initialRoute) {
        setAuthRouteState(null);
      }
    });

    return () => {
      subscription.subscription.unsubscribe();
    };
  }, []);

  const navigateToAuthRoute = useCallback((route: AuthRoute) => {
    if (route === 'reset-password') {
      inPasswordRecovery.current = true;
    } else if (route !== null) {
      inPasswordRecovery.current = false;
    }
    if (route) {
      const pathMap: Record<NonNullable<AuthRoute>, string> = {
        'signin': '/signin',
        'signup': '/signup',
        'forgot-password': '/forgot-password',
        'reset-password': '/reset-password',
      };
      window.history.replaceState(null, '', pathMap[route]);
    } else {
      inPasswordRecovery.current = false;
      window.history.replaceState(null, '', '/');
    }
    setAuthRouteState(route);
  }, []);

  const signOut = useCallback(async () => {
    inPasswordRecovery.current = false;
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setAuthRouteState('signin');
    window.history.replaceState(null, '', '/signin');
  }, []);

  return { user, session, authLoading, authRoute, setAuthRoute: navigateToAuthRoute, signOut };
}

export type AuthState = ReturnType<typeof useAuth>;
