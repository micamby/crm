import { publicOrigin } from "../config.js";

/**
 * The two cookies people sign-in uses (ADR 0009, docs/sign-in.md):
 *   session  the session token, for as long as the session can last
 *   signin   the pre-session token that binds a sign-in in progress to this browser
 * Both HttpOnly, SameSite=Lax (so a link in an email and the identity provider's redirect, both
 * top-level navigations, carry them), Path=/ and no Domain. With an https PUBLIC_URL they are Secure
 * and named with the __Host- prefix, which browsers only accept from a secure origin for exactly
 * this host. Plain http is allowed only for localhost (config.ts), where neither can apply.
 */
export function cookieNames(): { session: string; signin: string; secure: boolean } {
  const local = publicOrigin()?.local ?? false;
  return local ? { session: "hlcrm_session", signin: "hlcrm_signin", secure: false }
    : { session: "__Host-hlcrm_session", signin: "__Host-hlcrm_signin", secure: true };
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${cookieNames().secure ? "; Secure" : ""}`;
}

export const clearCookie = (name: string): string => setCookie(name, "", 0);

/** A cookie's value from a Cookie header. When the same name appears twice, the first wins (browsers send the most specific first). */
export function readCookie(header: string | undefined | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
