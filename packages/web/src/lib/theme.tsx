import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Light, dark, or the system's choice. The choice is stored in the member's preferences (the API), so
 * it follows them between browsers; a copy in localStorage only avoids a flash of the wrong theme while
 * the app starts (it holds nothing else).
 */
export type ThemeChoice = "light" | "dark" | "system";
const HINT_KEY = "hlcrm.theme";

export function readThemeHint(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(HINT_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function writeThemeHint(t: ThemeChoice): void {
  try {
    if (t === "system") window.localStorage.removeItem(HINT_KEY);
    else window.localStorage.setItem(HINT_KEY, t);
  } catch {
    // Storage may be unavailable (private mode); the preference on the server still applies.
  }
}

const prefersDark = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;

export function applyTheme(t: ThemeChoice): "light" | "dark" {
  const dark = t === "dark" || (t === "system" && prefersDark());
  document.documentElement.classList.toggle("dark", dark);
  return dark ? "dark" : "light";
}

interface ThemeValue { choice: ThemeChoice; resolved: "light" | "dark"; setChoice: (t: ThemeChoice) => void }
const Ctx = createContext<ThemeValue | null>(null);

export function useTheme(): ThemeValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme outside ThemeProvider");
  return v;
}

/**
 * `stored` is the member's saved choice once preferences load; `onChange` saves a new one. Follows the
 * system setting live while the choice is "system".
 */
export function ThemeProvider({ stored, onChange, children }: { stored: ThemeChoice | undefined; onChange?: (t: ThemeChoice) => void; children: ReactNode }) {
  const [choice, setLocal] = useState<ThemeChoice>(() => stored ?? readThemeHint());
  const [resolved, setResolved] = useState<"light" | "dark">(() => applyTheme(choice));
  useEffect(() => {
    if (stored && stored !== choice) {
      setLocal(stored);
      writeThemeHint(stored);
    }
    // Only when the stored preference arrives or changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);
  useEffect(() => {
    setResolved(applyTheme(choice));
    if (choice !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setResolved(applyTheme("system"));
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [choice]);
  const setChoice = useCallback((t: ThemeChoice) => {
    setLocal(t);
    writeThemeHint(t);
    onChange?.(t);
  }, [onChange]);
  const value = useMemo(() => ({ choice, resolved, setChoice }), [choice, resolved, setChoice]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
