import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogIn, RotateCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { SessionInfo, SignInAnswer } from "@/lib/api/types";
import { qk } from "@/lib/keys";
import { currentReturnTo, reauthHref } from "@/lib/session";
import { anyMethod, confirmMethods, useCapabilities } from "@/lib/signin";
import { SignInLinkSteps } from "./FirstRun";

/** A recent sign-in is one in the last 10 minutes (the server's RECENT_SIGN_IN_SECONDS). */
const RECENT_MS = 10 * 60_000;

/**
 * "Confirm it's you": shown when an action needs a recent sign-in (creating or rotating an API key,
 * changing a password without the current one, unlinking single sign-on) and the session's sign-in is
 * older than that. It offers only what can work for this member right now (lib/signin.ts):
 * - their password, here, after which the action goes ahead (the request helper retries it with the
 *   new session);
 * - an emailed code or single sign-on, on the sign-in page, which comes back to this page;
 * - with none of those (no password yet, no email, no single sign-on: a fresh self-hosted install),
 *   the command that prints a new one-time sign-in link. Opening it in this browser replaces the
 *   session; this dialog notices the new, recent session and the action carries on too.
 */
export function ReauthDialog({ open, onDone }: { open: boolean; onDone: (confirmed: boolean) => void }) {
  if (!open) return null;
  return <ReauthBody onDone={onDone} />;
}

function ReauthBody({ onDone }: { onDone: (confirmed: boolean) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const session = qc.getQueryData<SessionInfo>(qk.session);
  const caps = useCapabilities();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const methods = confirmMethods(caps.data, session);
  const [returnTo] = useState(currentReturnTo);

  const elsewhere = () => {
    onDone(false);
    window.location.assign(reauthHref(returnTo));
  };
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!session) return elsewhere();
    setBusy(true);
    setError(null);
    try {
      const a = await api.post<SignInAnswer>("/auth/password", { email: session.member.email, password, workspace: session.workspace.id });
      if (a.status !== "signed_in") return elsewhere();
      api.setCsrfToken(a.csrf_token);
      void qc.invalidateQueries({ queryKey: qk.session });
      onDone(true);
    } catch (err) {
      const p = asProblem(err);
      setError(p.code === "sign_in_failed" ? "That password isn't right." : p.status === 429 ? `Too many attempts. Wait a little${methods.emailCode || methods.sso ? ", or sign in again another way" : ""}.` : p.detail);
    } finally {
      setBusy(false);
    }
  };

  const other = [methods.emailCode ? "an emailed code" : null, methods.sso ? "single sign-on" : null].filter(Boolean).join(" or ");
  const none = caps.isSuccess && session ? !anyMethod(methods) : false;
  const description = "For your security, this needs a recent sign-in: your last one was more than 10 minutes ago.";

  return (
    <Dialog open onOpenChange={(o) => !o && onDone(false)}>
      <DialogContent title="Confirm it's you" size={none ? "md" : "sm"} description={description}
        footer={methods.password ? (
          <>
            <Button onClick={() => onDone(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="reauth-form" busy={busy} disabled={!password}><ShieldCheck /> Confirm</Button>
          </>
        ) : none ? (
          <NewLinkFooter session={session!} onDone={onDone} />
        ) : (
          <>
            <Button onClick={() => onDone(false)}>Cancel</Button>
            <Button variant="primary" onClick={elsewhere} disabled={caps.isPending}><LogIn /> Sign in again</Button>
          </>
        )}>
        {caps.isPending ? <Skeleton className="h-16" />
          : methods.password ? (
            <form id="reauth-form" className="flex flex-col gap-3" onSubmit={(e) => void confirm(e)}>
              {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
              <p className="text-base text-muted">Enter the password for <strong className="font-medium text-fg">{session!.member.email}</strong>. What you were doing carries on afterwards.</p>
              <FormField label="Password">{(p) => <Input {...p} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}</FormField>
              {other ? <Button variant="link" className="self-start" onClick={elsewhere}><KeyRound className="size-3.5" /> Sign in another way ({other})</Button> : null}
            </form>
          ) : none ? (
            <SignInLinkSteps session={session!} returnTo={returnTo} />
          ) : (
            <p className="text-base text-muted">Sign in again with {other || "your usual method"}, then you'll come back to this page to do it.</p>
          )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * While the person fetches a new link: watches for this browser's session to become a new, recent one
 * (the link was opened in another tab), then sets its CSRF token and lets the waiting action carry on.
 */
function NewLinkFooter({ session, onDone }: { session: SessionInfo; onDone: (confirmed: boolean) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [notYet, setNotYet] = useState(false);
  const [checking, setChecking] = useState(false);
  const finished = useRef(false);
  const live = useQuery({
    queryKey: ["auth", "reauth-watch"],
    queryFn: ({ signal }) => api.get<SessionInfo>("/v1/auth/session", undefined, signal),
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
    retry: false,
    gcTime: 0,
  });
  const fresh = live.data && live.data.session.id !== session.session.id && Date.now() - new Date(live.data.session.signed_in_at).getTime() < RECENT_MS ? live.data : null;
  useEffect(() => {
    if (!fresh || finished.current) return;
    finished.current = true;
    api.setCsrfToken(fresh.csrf_token);
    qc.setQueryData(qk.session, fresh);
    onDone(true);
  }, [fresh, api, qc, onDone]);
  return (
    <>
      {notYet ? <span role="status" className="mr-auto text-sm text-muted">Not yet: open the new link in this browser first.</span> : null}
      <Button onClick={() => onDone(false)}>Cancel</Button>
      <Button variant="primary" busy={checking} onClick={() => {
        setChecking(true);
        void live.refetch().then((r) => setNotYet(!(r.data && r.data.session.id !== session.session.id))).finally(() => setChecking(false));
      }}>
        <RotateCw /> I've opened the link
      </Button>
    </>
  );
}
