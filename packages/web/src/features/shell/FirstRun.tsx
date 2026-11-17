import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Terminal, X } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { CopyButton, ProblemAlert } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { SessionInfo } from "@/lib/api/types";
import { qk } from "@/lib/keys";
import { usePrefs, useSetPrefs } from "@/lib/prefs";
import { useSession } from "@/lib/session";
import { shouldSetPassword, signInLinkCommand, useCapabilities } from "@/lib/signin";
import { useToast } from "@/components/ui/toast";

/**
 * First-run pieces shared by the welcome step, the Home card, Settings → Account and "Confirm it's
 * you": a form to set a first password, and plain instructions for getting back in with a fresh
 * one-time link when no other way can work (no password yet, no email, no single sign-on).
 */

/**
 * Sets a first password (no current one needed while the sign-in is recent; later the request asks the
 * person to confirm it's them first, through the usual dialog). Refreshes the session afterwards, so
 * everything that offered this goes away.
 */
export function SetPasswordForm({ email, onSaved, submitLabel = "Set password", extra }: {
  email: string; onSaved?: () => void; submitLabel?: string; extra?: ReactNode;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<unknown>(null);
  const formId = useId();
  const save = useMutation({
    mutationFn: () => api.post<{ data: { has_password: boolean } }>("/v1/auth/password", { password: next }),
    onSuccess: async () => {
      setNext(""); setAgain(""); setError(null);
      await qc.invalidateQueries({ queryKey: qk.session });
      onSaved?.();
    },
    onError: (e) => setError(asProblem(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return setError("The two passwords don't match.");
    save.mutate();
  };
  return (
    <form id={formId} className="grid max-w-md gap-3.5" onSubmit={submit}>
      {/* For password managers: which account this password is for. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <ProblemAlert error={error} />
      <FormField label="New password" hint="At least 12 characters. A few unrelated words make a good one.">
        {(p) => <Input {...p} type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />}
      </FormField>
      <FormField label="New password again">{(p) => <Input {...p} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />}</FormField>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={next.length < 12 || !again}><KeyRound /> {submitLabel}</Button>
        {extra}
      </div>
    </form>
  );
}

/**
 * What to do when no sign-in method can confirm it's this member: print a new one-time link on the
 * server, open it in this browser, and come back to `returnTo`. For someone who doesn't run the
 * server, who to ask instead.
 */
export function SignInLinkSteps({ session, returnTo }: { session: Pick<SessionInfo, "member" | "workspace" | "role">; returnTo: string }) {
  const command = signInLinkCommand(session, returnTo);
  const ask = <p className="text-base text-muted">If someone else runs your server, ask them for a new sign-in link for <strong className="font-medium text-fg">{session.member.email}</strong>, then open it in this browser.</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-base text-muted">
        {session.member.has_password === false ? "You haven't set a password yet" : "Password sign-in is turned off here"}, and this server can't send sign-in emails, so the way back in is a new one-time sign-in link.
      </p>
      {session.role === "owner" ? null : ask}
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-base">
        <li>
          On the computer that runs the server, in the folder with its <code className="font-mono">docker-compose.yml</code>, run:
          <div className="mt-1.5 flex items-start gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm" data-testid="sign-in-link-command">
              <Terminal aria-hidden className="mr-1.5 inline size-3.5 text-subtle" />{command}
            </code>
            <CopyButton text={command} />
          </div>
        </li>
        <li>Open the link it prints in this browser (a new tab is fine). It works once, for 15 minutes.</li>
        <li>You'll be back here, signed in again. If this page is still open, it notices and carries on with what you were doing.</li>
      </ol>
      {session.role === "owner" ? ask : null}
      {session.member.has_password === false ? <p className="text-sm text-subtle">Then set a password under Settings → Account, so next time you can confirm with it.</p> : null}
    </div>
  );
}

/** Remembered per session in this tab only: after "Skip for now" the welcome step doesn't come back until the next sign-in. */
const welcomeKey = (sessionId: string) => `hlcrm.welcome-skipped.${sessionId}`;
function readFlag(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string): void {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // storage blocked: the step is skipped for this page's life only
  }
}

/**
 * The first page after signing in with a one-time link, for a member with no password where passwords
 * are allowed (the first owner after `bootstrap`, typically): a welcome, and the chance to set a
 * password straight away, while the sign-in is recent enough to need no other proof. Skippable; the
 * Home card and Settings → Account keep offering it. Shown in place of the page asked for, which
 * follows once it is done or skipped, so a link with a return path still gets there.
 */
export function WelcomeGate({ session, children }: { session: Pick<SessionInfo, "member" | "workspace" | "session">; children: ReactNode }) {
  const caps = useCapabilities();
  const toast = useToast();
  const key = welcomeKey(session.session.id);
  const [skipped, setSkipped] = useState(() => readFlag(key));
  // Only for the session the page was opened with: a session that replaces it while a page is in use (confirming
  // it's you with a new link, in another tab) must not swap the page, and whatever it holds, for this step.
  const [openedWith] = useState(session.session.id);
  const candidate = session.session.id === openedWith && session.session.method === "server_link" && session.member.has_password === false && !skipped;
  if (!candidate) return <>{children}</>;
  if (caps.isPending) return null;
  if (!shouldSetPassword(caps.data, session)) return <>{children}</>;
  const done = () => {
    writeFlag(key);
    setSkipped(true);
  };
  const first = session.member.name.split(/\s+/)[0] || session.member.name;
  return (
    <div className="flex min-h-full items-start justify-center bg-bg px-4 py-12 sm:items-center">
      <main className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-lg font-semibold">hl-crm-db</span>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6 shadow-md">
          <h1 className="text-xl font-semibold">Welcome, {first}</h1>
          <p className="mt-1 text-base text-muted">
            You're signed in to <strong className="font-medium text-fg">{session.workspace.name}</strong> as {session.member.email}.
          </p>
          <p className="mt-3 text-base text-muted">
            You came in with a one-time link, and it can't be used again. Set a password now so you can sign in again any time, and confirm it's you when the app asks.
          </p>
          <div className="mt-5">
            <SetPasswordForm email={session.member.email} onSaved={() => {
              toast.toast({ tone: "success", title: "Password set", description: "Sign in with your email and this password from now on." });
              done();
            }} extra={<Button variant="ghost" onClick={done}>Skip for now</Button>} />
          </div>
        </div>
      </main>
    </div>
  );
}

/** The per-member preference (/v1/me/preferences) that remembers the Home card was dismissed. */
export const SET_PASSWORD_DISMISSED = "hint.set_password.dismissed";

/**
 * Home's nudge for a member without a password where passwords are allowed: dismissible (remembered
 * per member, on every browser), with the form right there. Settings → Account keeps a hint that stays.
 */
export function SetPasswordCard() {
  const s = useSession();
  const caps = useCapabilities();
  const prefs = usePrefs();
  const setPrefs = useSetPrefs();
  const toast = useToast();
  if (!shouldSetPassword(caps.data, s) || !prefs.isSuccess || prefs.data[SET_PASSWORD_DISMISSED] === true) return null;
  return (
    <section aria-labelledby="h-set-password" className="mt-6 rounded-lg border border-accent/40 bg-accent-soft/40 p-4">
      <div className="flex items-start gap-3">
        <KeyRound aria-hidden className="mt-0.5 size-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 id="h-set-password" className="text-md font-semibold">Set a password so you can sign in again</h2>
          <p className="mt-1 text-base text-muted">
            You signed in with a one-time link, and there's no other way back in yet. With a password you can sign in with your email any time, and confirm it's you when the app asks.
          </p>
          <div className="mt-4">
            <SetPasswordForm email={s.member.email} onSaved={() => toast.toast({ tone: "success", title: "Password set", description: "Sign in with your email and this password from now on." })} />
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss: set a password later" onClick={() => setPrefs.mutate({ [SET_PASSWORD_DISMISSED]: true })}><X /></Button>
      </div>
    </section>
  );
}
