import { Link } from "@tanstack/react-router";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/feedback";
import { Button } from "@/components/ui/button";

/**
 * An address that matches no page. Outside the signed-in frame it is the whole page, so it brings its
 * own main landmark; inside the frame (which has one) it doesn't add a second.
 */
export function NotFoundPage() {
  const inFrame = typeof document !== "undefined" && document.getElementById("main") !== null;
  const body = (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState icon={<SearchX />} heading="h1" title="Page not found" action={<Button asChild variant="primary"><Link to="/">Go home</Link></Button>}>
        This address doesn't match a page of the app. It may have moved, or the link may be incomplete.
      </EmptyState>
    </div>
  );
  return inFrame ? body : <main id="main" className="min-h-full bg-bg">{body}</main>;
}
