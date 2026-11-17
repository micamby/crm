import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { ApiProblem } from "@/lib/api/problem";

/** Signs out on the server, forgets everything cached, and leaves the app. */
export function useSignOut() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(async () => {
    try {
      await api.post("/v1/auth/sign-out");
    } catch (e) {
      if (!(e instanceof ApiProblem && e.status === 401)) {
        toast.error(e, "Couldn't sign out");
        return;
      }
    }
    api.setCsrfToken(null);
    qc.clear();
    window.location.assign("/signed-out");
  }, [api, qc, toast]);
}

