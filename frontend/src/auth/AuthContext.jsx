import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getAuthConfig, importCloudRecipes } from "../api/client.js";
import { USER_ID } from "../constants.js";
import { clearLikedRecipes, getLikedRecipes } from "../utils/likedRecipes.js";

const guestValue = {
  accessToken: "",
  accountAvailable: false,
  authReady: true,
  session: null,
  supabase: null,
  user: null,
  migrationStatus: "idle",
  refreshSession: async () => null,
};

const AuthContext = createContext(guestValue);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ ...guestValue, authReady: false });
  const migrationInFlightRef = useRef("");

  useEffect(() => {
    let active = true;
    let subscription;

    async function initialize() {
      try {
        const config = await getAuthConfig();
        if (!active) return;
        if (!config?.enabled || !config.url || !config.publishableKey) {
          setState({ ...guestValue, accountAvailable: false });
          return;
        }

        const { createClient } = await import("@supabase/supabase-js");
        if (!active) return;
        const supabase = createClient(config.url, config.publishableKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        const { data } = await supabase.auth.getSession();
        if (!active) return;
        setState(fromSession(supabase, data.session));
        const authListener = supabase.auth.onAuthStateChange((_event, nextSession) => {
          if (active) setState(fromSession(supabase, nextSession));
        });
        subscription = authListener.data.subscription;
      } catch {
        if (active) setState({ ...guestValue, accountAvailable: false });
      }
    }

    void initialize();
    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const userId = state.user?.id;
    if (!userId || !state.accessToken || migrationInFlightRef.current === userId) return;
    const migrationKey = `dishly:guest-imported:v1:${userId}`;
    if (window.localStorage.getItem(migrationKey) === "yes") return;
    migrationInFlightRef.current = userId;
    // The effect mirrors an external migration into visible account status.
    // oxlint-disable-next-line react/set-state-in-effect
    setState((current) => ({ ...current, migrationStatus: "importing" }));
    const recipes = getLikedRecipes(USER_ID);
    importCloudRecipes(state.accessToken, recipes)
      .then(() => {
        window.localStorage.setItem(migrationKey, "yes");
        clearLikedRecipes(USER_ID);
        setState((current) => ({ ...current, migrationStatus: "complete" }));
      })
      .catch(() => {
        migrationInFlightRef.current = "";
        setState((current) => ({ ...current, migrationStatus: "failed" }));
      });
  }, [state.accessToken, state.user?.id]);

  const refreshSession = useCallback(async () => {
    if (!state.supabase) return null;
    const { data } = await state.supabase.auth.refreshSession();
    return data.session;
  }, [state.supabase]);

  const value = useMemo(() => ({ ...state, refreshSession }), [refreshSession, state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function fromSession(supabase, session) {
  return {
    accountAvailable: true,
    authReady: true,
    supabase,
    session: session || null,
    user: session?.user || null,
    accessToken: session?.access_token || "",
    migrationStatus: "idle",
  };
}

// oxlint-disable-next-line react/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}

// oxlint-disable-next-line react/only-export-components
export { AuthContext, guestValue };
