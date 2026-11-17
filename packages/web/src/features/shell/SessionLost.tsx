import { useQueryClient } from "@tanstack/react-query";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { qk } from "@/lib/keys";
import { signInHref } from "@/lib/session";

/**
 * Shown when a request answers 401 after the app was signed in: the session ended (idle or absolute
 * timeout, signed out elsewhere, revoked by an admin). It keeps the page as it was underneath, so
 * nothing on screen vanishes, and offers to sign in again and come back to this page.
 */
export function SessionLostDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const hadSession = qc.getQueryData(qk.session) !== undefined;
  if (!open || !hadSession || window.location.pathname.startsWith("/sign-in")) return null;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title="Your session has ended"
        description="You were signed out, perhaps after a period of inactivity or from another device. Sign in again to carry on where you were."
        hideClose
        footer={<Button variant="primary" onClick={() => window.location.assign(signInHref())}><LogIn /> Sign in again</Button>}
      >
        <p className="text-base text-muted">Changes you hadn't saved yet may need to be made again.</p>
      </DialogContent>
    </Dialog>
  );
}
