import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { applyServerErrors, bodyFrom, checkForm, RecordFields, useRecordForm, type Values } from "@/features/record/RecordForm";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { FieldMeta, ObjectMeta, RecordData } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { touchedBy, useApplyWrite } from "@/lib/writes";
import { canWrite, visibleFields } from "@/meta/fields";
import { qk } from "@/lib/keys";
import { useDescribe } from "@/meta/hooks";

/**
 * Create a record of any object, from describe: the fields you must fill first, the rest one click
 * away, defaults filled in, relations through search pickers, and the server's validation messages on
 * the fields they concern. `prefill` sets values (a related list's parent); `extra` adds API-only
 * values such as `related_to` for tasks.
 */
export function CreateRecordDialog({ object, open, onOpenChange, prefill, extra, onCreated, stay }: {
  object: string; open: boolean; onOpenChange: (o: boolean) => void; prefill?: Record<string, unknown>; extra?: Record<string, unknown>;
  onCreated?: (r: RecordData) => void; stay?: boolean;
}) {
  const meta = useDescribe(object);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {meta.data ? (
        <CreateForm meta={meta.data} prefill={prefill} extra={extra} onClose={() => onOpenChange(false)} onCreated={onCreated} stay={stay} />
      ) : (
        <DialogContent title={`New record`} size="lg">
          {meta.error ? <ProblemView error={meta.error} onRetry={() => meta.refetch()} /> : (
            <div className="grid grid-cols-2 gap-4" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

function CreateForm({ meta, prefill, extra, onClose, onCreated, stay }: {
  meta: ObjectMeta; prefill?: Record<string, unknown>; extra?: Record<string, unknown>; onClose: () => void; onCreated?: (r: RecordData) => void; stay?: boolean;
}) {
  const api = useApi();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const navigate = useNavigate();
  const s = useSession();
  const writable = useMemo(() => visibleFields(meta).filter((f) => canWrite(f, meta.access, "create")), [meta]);
  const isRequired = (f: (typeof writable)[number]) => Boolean(f.required) && f.default === undefined && f.initial === undefined;
  // Fields filled in from a chosen relation (a deal's account from its contact): shown with the fields filled in up front.
  const [filled, setFilled] = useState<string[]>([]);
  const onFilled = useCallback((name: string) => setFilled((f) => (f.includes(name) ? f : [...f, name])), []);
  const first = writable.filter((f) => isRequired(f) || (prefill && Object.hasOwn(prefill, f.name)) || filled.includes(f.name));
  const rest = writable.filter((f) => !first.includes(f));
  const [showAll, setShowAll] = useState(first.length === 0 || writable.length <= 8);
  const fields = showAll ? [...first, ...rest] : first;
  const defaults = useMemo(() => {
    const d: Record<string, unknown> = { ...(prefill ?? {}) };
    // A task is yours unless you pick someone else.
    if (meta.name === "task" && writable.some((f) => f.name === "assignee") && d.assignee === undefined) d.assignee = s.member.id;
    return d;
  }, [prefill, meta.name, writable, s.member.id]);
  const { form } = useRecordForm(writable, undefined, defaults);
  useDependentPrefill(meta, writable, form, onFilled);
  const [formError, setFormError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ data: RecordData }>(`/v1/objects/${encodeURIComponent(meta.name)}/records`, body).then((r) => r.data),
    onSuccess: (rec) => {
      applyWrite({ object: meta.name, touched: touchedBy({ related_to: extra?.related_to, related: rec.related }) });
      toast.toast({ tone: "success", title: `${meta.label} created`, description: rec.display_name });
      onCreated?.(rec);
      onClose();
      if (!stay) void navigate({ to: "/o/$object/$id", params: { object: meta.name, id: rec.id } });
    },
    onError: (e) => {
      const p = asProblem(e);
      if (Object.keys(p.fieldErrors).length && !showAll) setShowAll(true);
      setFormError(applyServerErrors(form, writable, p));
    },
  });

  const submit = form.handleSubmit((values) => {
    setFormError(null);
    const body = bodyFrom(writable, values, "create");
    if (!checkForm(form, writable, "create", body)) {
      const bad = Object.keys(form.formState.errors);
      if (bad.some((n) => !first.some((f) => f.name === n))) setShowAll(true);
      return;
    }
    create.mutate({ ...body, ...(extra ?? {}) });
  });

  if (!meta.access.write) {
    return (
      <DialogContent title={`New ${meta.label.toLowerCase()}`}>
        <p className="text-base text-muted">Your role can view {meta.plural_label.toLowerCase()} but not create them.</p>
      </DialogContent>
    );
  }
  return (
    <DialogContent
      title={`New ${meta.label.toLowerCase()}`}
      description={meta.description}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="create-record" busy={create.isPending}>Create {meta.label.toLowerCase()}</Button>
        </>
      }
    >
      <form id="create-record" onSubmit={(e) => void submit(e)} noValidate>
        {formError ? <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{formError}</p> : null}
        {fields.length ? <RecordFields form={form} fields={fields} meta={meta} mode="create" autoFocusFirst /> : null}
        {!showAll && rest.length ? (
          <Button variant="link" className="mt-4" onClick={() => setShowAll(true)}>
            <ChevronDown className="size-3.5" /> {rest.length} more field{rest.length === 1 ? "" : "s"}
          </Button>
        ) : null}
      </form>
    </DialogContent>
  );
}

/**
 * Relations that follow from another one on a new record: a deal's or a lead's account is, most
 * likely, its contact's account. As on the server (capturing a lead reuses the contact's account
 * only for a caller who can read contact.account), the value is read with the caller's own access:
 * the contact is fetched through the API, which leaves out any field their role can't read, and the
 * contact's account field must be readable to them in describe. It is a prefill: the person can
 * change it, and a value they picked themselves is never replaced.
 */
const DEPENDENT_RELATIONS: Record<string, { from: string; to: string; via: string }[]> = {
  deal: [{ from: "primary_contact", to: "account", via: "account" }],
  lead: [{ from: "contact", to: "account", via: "account" }],
};

function useDependentPrefill(meta: ObjectMeta, writable: FieldMeta[], form: UseFormReturn<Values>, onFilled: (field: string) => void) {
  const api = useApi();
  const rule = DEPENDENT_RELATIONS[meta.name]?.find((r) => writable.some((f) => f.name === r.to) && meta.fields.some((f) => f.name === r.from));
  const from = rule ? meta.fields.find((f) => f.name === rule.from) : undefined;
  const to = rule ? writable.find((f) => f.name === rule.to) : undefined;
  const source = from?.type === "relation" && from.relation?.cardinality !== "many_to_many" ? from.relation?.to : undefined;
  const sourceMeta = useDescribe(to ? source : undefined);
  const via = rule ? sourceMeta.data?.fields.find((f) => f.name === rule.via) : undefined;
  const readable = Boolean(via && via.access !== "none" && via.type === "relation" && via.relation?.to === to?.relation?.to);
  const chosen = form.watch(rule?.from ?? "__none__");
  const id = typeof chosen === "string" && chosen ? chosen : null;
  const record = useQuery({
    queryKey: [...qk.records(source ?? ""), "record", id, "prefill"],
    queryFn: async ({ signal }) => (await api.get<{ data: RecordData }>(`/v1/objects/${encodeURIComponent(source!)}/records/${encodeURIComponent(id!)}`, undefined, signal)).data,
    enabled: readable && Boolean(source && id),
    staleTime: 30_000,
    retry: false,
  });
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!rule || !record.data) return;
    const value = record.data[rule.via];
    if (typeof value !== "string" || !value) return;
    const current = form.getValues(rule.to);
    // Only into an empty field, or over the value filled in from the previously chosen record: never over the person's own choice.
    if (current && current !== last.current) return;
    if (current === value) return;
    form.setValue(rule.to, value, { shouldDirty: true });
    last.current = value;
    onFilled(rule.to);
  }, [record.data, rule, form, onFilled]);
}
