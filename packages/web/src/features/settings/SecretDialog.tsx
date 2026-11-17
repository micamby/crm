import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/misc";
import { Dialog, DialogContent } from "@/components/ui/overlays";

/**
 * A secret shown once (an API key, a webhook signing secret). It lives only in this dialog's state:
 * never cached, stored or logged by the app, and gone when the dialog closes.
 */
export function SecretDialog({ title, secret, note, onClose }: { title: string; secret: string; note: string; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && saved && onClose()}>
      <DialogContent title={title} hideClose description="Copy it now: it won't be shown again."
        footer={<Button variant="primary" disabled={!saved} onClick={onClose}>Done</Button>}>
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning-soft px-3 py-2 text-base text-warning-fg">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {note}
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm">{secret}</code>
            <CopyButton text={secret} />
          </div>
          <label className="flex items-center gap-2 text-base"><Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} /> I've stored it somewhere safe</label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
