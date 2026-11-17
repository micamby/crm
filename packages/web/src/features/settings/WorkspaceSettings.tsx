import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import type { SignInSettings } from "@/lib/api/types";
import { qk } from "@/lib/keys";
import { useSession } from "@/lib/session";
import { ALL_SCOPES, SCOPE_LABELS } from "./ConnectedApps";
import { Section } from "./SettingsLayout";

/** How members of this workspace may sign in. Only an owner can change it. */
export function WorkspaceSettings() {
  const s = useSession();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  // An older server's settings lack the OAuth fields: show them as the server's defaults would be (on, every scope).
  const [draft, setDraft] = useState<SignInSettings>({ ...s.workspace.sign_in, oauth_apps: s.workspace.sign_in.oauth_apps ?? true, oauth_scopes: s.workspace.sign_in.oauth_scopes ?? ALL_SCOPES });
  const [domains, setDomains] = useState(s.workspace.sign_in.sso_allowed_domains.join(", "));
  const editable = s.isOwner;
  const [confirmOff, setConfirmOff] = useState(false);
  const save = useMutation({
    mutationFn: () => api.patch<{ data: SignInSettings }>("/v1/workspace/sign-in", {
      password: draft.password, sso: draft.sso, sso_allowed_domains: domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean),
      oauth_apps: draft.oauth_apps, oauth_scopes: draft.oauth_scopes,
    }),
    onSuccess: () => {
      setConfirmOff(false);
      void qc.invalidateQueries({ queryKey: qk.session });
      toast.toast({ tone: "success", title: "Sign-in settings saved" });
    },
    onError: (e) => toast.error(e, "Couldn't save"),
  });
  return (
    <Section title="Workspace sign-in" description={editable ? "Which ways members of this workspace may sign in. Emailed codes always work." : "Only an owner can change these."}>
      <form className="grid max-w-lg gap-4" onSubmit={(e) => {
        e.preventDefault();
        // Turning connecting apps off ends every connection in the workspace at once: confirm it first.
        if (s.workspace.sign_in.oauth_apps !== false && !draft.oauth_apps) setConfirmOff(true);
        else save.mutate();
      }}>
        <label className="flex items-center justify-between gap-4 text-base">
          <span>Password sign-in<span className="block text-sm text-muted">Members may set a password and sign in with it.</span></span>
          <Switch checked={draft.password} disabled={!editable} onCheckedChange={(v) => setDraft({ ...draft, password: v })} aria-label="Password sign-in" />
        </label>
        <label className="flex items-center justify-between gap-4 text-base">
          <span>Single sign-on<span className="block text-sm text-muted">Members may sign in through the server's identity provider, when one is set up.</span></span>
          <Switch checked={draft.sso} disabled={!editable} onCheckedChange={(v) => setDraft({ ...draft, sso: v })} aria-label="Single sign-on" />
        </label>
        <FormField label="Email domains single sign-on accepts" hint="Separated by commas. Empty: any domain the server accepts.">
          {(p) => <Input {...p} disabled={!editable || !draft.sso} value={domains} placeholder="example.com" onChange={(e) => setDomains(e.target.value)} />}
        </FormField>
        <label className="flex items-center justify-between gap-4 text-base">
          <span>Connecting apps<span className="block text-sm text-muted">Members may connect AI assistants and other apps to the MCP servers by signing in and approving (when the server has it set up).</span></span>
          <Switch checked={draft.oauth_apps} disabled={!editable} onCheckedChange={(v) => setDraft({ ...draft, oauth_apps: v })} aria-label="Connecting apps" />
        </label>
        <fieldset className="grid gap-1.5" disabled={!editable || !draft.oauth_apps}>
          <legend className="mb-1 text-sm font-medium text-muted">What connected apps may be allowed to do (each member's role still limits it)</legend>
          {ALL_SCOPES.map((sc) => (
            <label key={sc} className="flex items-center gap-2 text-base">
              <input type="checkbox" className="size-4 accent-[var(--hl-accent)]" checked={draft.oauth_scopes.includes(sc)}
                onChange={(e) => setDraft({ ...draft, oauth_scopes: e.target.checked ? ALL_SCOPES.filter((x) => x === sc || draft.oauth_scopes.includes(x)) : draft.oauth_scopes.filter((x) => x !== sc) })} />
              {SCOPE_LABELS[sc]} <code className="text-sm text-subtle">{sc}</code>
            </label>
          ))}
        </fieldset>
        {editable ? <div><Button type="submit" variant="primary" busy={save.isPending}>Save</Button></div> : null}
      </form>
      <ConfirmDialog open={confirmOff} onOpenChange={setConfirmOff} danger busy={save.isPending} confirmLabel="Turn off and disconnect"
        title="Turn off connecting apps?" description="Every app connected in this workspace is disconnected at once, and members can't connect new ones until it is turned back on."
        onConfirm={() => save.mutate()} />
    </Section>
  );
}
