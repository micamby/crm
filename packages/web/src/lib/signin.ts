import { useQuery } from "@tanstack/react-query";
import { useApi } from "./api/context";
import type { Capabilities, SessionInfo } from "./api/types";

/**
 * Which ways of signing in can work for the signed-in member right now, from what the server offers
 * (GET /auth/capabilities), what the workspace allows and what the member has (the session info).
 * The "Confirm it's you" dialog, the sign-in page in its confirming mode and the first-run prompts
 * to set a password all decide from here, so none of them offers a method that can't work.
 */

export const capabilitiesKey = ["auth", "capabilities"] as const;

/** The server's sign-in methods. Says nothing about any account; cached for a minute. */
export function useCapabilities() {
  const api = useApi();
  return useQuery({
    queryKey: capabilitiesKey,
    queryFn: ({ signal }) => api.get<Capabilities>("/auth/capabilities", undefined, signal),
    staleTime: 60_000,
  });
}

type Who = Pick<SessionInfo, "member" | "workspace">;

/** Password sign-in is on for the server and allowed in the workspace (so a password can be set, and used). */
export const passwordAllowed = (caps: Capabilities | undefined, s: Who | null | undefined): boolean =>
  Boolean(caps?.enabled && caps.methods.password && s?.workspace.sign_in?.password !== false);

export interface ConfirmMethods { password: boolean; emailCode: boolean; sso: boolean }

/** The methods that can confirm it's this member: a password they have, email the server can send, single sign-on the workspace allows. */
export function confirmMethods(caps: Capabilities | undefined, s: Who | null | undefined): ConfirmMethods {
  if (!caps?.enabled || !s) return { password: false, emailCode: false, sso: false };
  return {
    password: passwordAllowed(caps, s) && s.member.has_password !== false,
    emailCode: caps.methods.email_code,
    sso: Boolean(caps.methods.sso) && s.workspace.sign_in?.sso !== false,
  };
}

export const anyMethod = (m: ConfirmMethods) => m.password || m.emailCode || m.sso;

/** The member could and should set a password: it's allowed and they have none (they came in by a one-time link). */
export const shouldSetPassword = (caps: Capabilities | undefined, s: Who | null | undefined): boolean =>
  passwordAllowed(caps, s) && s?.member.has_password === false;

/** A value as one shell word: as it is when plainly safe, else in single quotes (as the server's bootstrap output prints it). */
export function shellWord(v: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command that prints a one-time sign-in link for this member (the Docker Compose form the README
 * uses), coming back to `returnTo` once it is opened. A link like this is how someone with no password,
 * no email and no single sign-on confirms it's them; `sign-in-link --return-to` checks the path with
 * the same rule as every sign-in's return_to.
 */
export function signInLinkCommand(s: Who, returnTo: string): string {
  const back = returnTo && returnTo !== "/" ? ` --return-to ${shellWord(returnTo)}` : "";
  return `docker compose run --rm api sign-in-link --email ${shellWord(s.member.email)} --workspace ${s.workspace.id}${back}`;
}
