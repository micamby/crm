import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";
import { useApi } from "./api/context";
import type { SessionInfo } from "./api/types";
import { qk } from "./keys";

/** The signed-in session (who, which workspace, role, permissions). Also keeps the client's CSRF token current. */
export function useSessionQuery() {
  const api = useApi();
  return useQuery({
    queryKey: qk.session,
    queryFn: async ({ signal }) => {
      const s = await api.get<SessionInfo>("/v1/auth/session", undefined, signal);
      api.setCsrfToken(s.csrf_token);
      return s;
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export interface SessionValue extends SessionInfo {
  can: (permission: string) => boolean;
  isOwner: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);
export const SessionProvider = SessionContext.Provider;

/** The current session, inside the signed-in part of the app. */
export function useSession(): SessionValue {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside a signed-in page");
  return s;
}

export function useSessionValue(s: SessionInfo | undefined): SessionValue | null {
  return useMemo(() => {
    if (!s) return null;
    const perms = new Set(s.permissions);
    return { ...s, can: (p: string) => perms.has(p), isOwner: s.role === "owner" };
  }, [s]);
}

/** A same-origin path to come back to after signing in (the current page), never another origin. */
export function currentReturnTo(): string {
  const { pathname, search, hash } = window.location;
  const path = `${pathname}${search}${hash}`;
  return path.startsWith("/") && !path.startsWith("//") && !pathname.startsWith("/sign-in") ? path : "/";
}

/** The app's sign-in page, coming back here afterwards. */
export const signInHref = (returnTo = currentReturnTo()) => `/sign-in?return_to=${encodeURIComponent(returnTo)}`;

/**
 * The sign-in page in re-authentication mode: it shows the sign-in methods even though a session is
 * live (pre-filled with the member's email), and comes back here once the person signed in again. For
 * actions that need a recent sign-in, and to start a fresh session before this one runs out.
 */
export const reauthHref = (returnTo = currentReturnTo()) => `/sign-in?reauth=1&return_to=${encodeURIComponent(returnTo)}`;
