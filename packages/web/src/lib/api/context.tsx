import { createContext, useContext } from "react";
import type { ApiClient } from "./client";

const ApiContext = createContext<ApiClient | null>(null);

/** Provides the app's one ApiClient (made once per app, at its root). */
export const ApiProvider = ApiContext.Provider;

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi outside ApiProvider");
  return api;
}
