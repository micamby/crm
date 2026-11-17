import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Bell, Building, ChevronDown, ChevronsUpDown, Columns3, Home, KeyRound, ListChecks, LogOut, Menu as MenuIcon, Monitor, Moon, Plug, Search, Settings, Sun, UserRound,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { WelcomeGate } from "./FirstRun";
import { useSignOut } from "./signout";

// Its own chunk (the palette brings search, record creation and forms with it), fetched once the page is idle.
const loadPalette = () => import("@/features/search/CommandPalette");
const CommandPalette = lazy(() => loadPalette().then((m) => ({ default: m.CommandPalette })));
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Kbd, Skeleton } from "@/components/ui/misc";
import {
  Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger,
} from "@/components/ui/overlays";
import { useApi } from "@/lib/api/context";
import { ApiProblem } from "@/lib/api/problem";
import type { Attention, ObjectSummary } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDateTime, roleLabel } from "@/lib/format";
import { plainLabel } from "@/lib/text";
import { qk } from "@/lib/keys";
import { usePrefs, useSetPrefs } from "@/lib/prefs";
import { reauthHref, SessionProvider, useSession, useSessionQuery, useSessionValue } from "@/lib/session";
import { ThemeProvider, useTheme, type ThemeChoice } from "@/lib/theme";
import { isJunction, navObjects, useObjects } from "@/meta/hooks";
import { ObjectIcon } from "@/meta/icons";

/** The signed-in frame: session bootstrap, theme, navigation, the command palette, and the page. */
export function AppShell() {
  const session = useSessionQuery();
  const value = useSessionValue(session.data);
  const prefs = usePrefs();
  const setPrefs = useSetPrefs();
  const onTheme = useCallback((t: ThemeChoice) => setPrefs.mutate({ theme: t === "system" ? null : t }), [setPrefs]);

  if (session.isPending) return <ShellSkeleton />;
  if (session.error) {
    if (session.error instanceof ApiProblem && session.error.status === 401) {
      const { pathname, search, hash } = window.location;
      return <Navigate to="/sign-in" search={{ return_to: `${pathname}${search}${hash}` }} replace />;
    }
    return (
      <div className="mx-auto max-w-xl p-6">
        <ProblemView error={session.error} onRetry={() => session.refetch()} />
      </div>
    );
  }
  const stored = prefs.data?.theme;
  return (
    <SessionProvider value={value}>
      <ThemeProvider stored={stored === "light" || stored === "dark" ? stored : prefs.isSuccess ? "system" : undefined} onChange={onTheme}>
        <WelcomeGate session={session.data}>
          <Frame />
        </WelcomeGate>
      </ThemeProvider>
    </SessionProvider>
  );
}

function Frame() {
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpenRaw] = useState(false);
  const [paletteUsed, setPaletteUsed] = useState(false);
  // Keys typed after ⌘K but before the palette is on screen (its code still loading): handed to it as its first query.
  const typedEarly = useRef("");
  const paletteMounted = useRef(false);
  const [initialQuery, setInitialQuery] = useState("");
  const paletteOpenRef = useRef(paletteOpen);
  useEffect(() => {
    paletteOpenRef.current = paletteOpen;
  }, [paletteOpen]);
  const setPaletteOpen = useCallback((o: boolean | ((x: boolean) => boolean)) => {
    setPaletteUsed(true);
    setPaletteOpenRaw(o);
  }, []);
  const onPaletteReady = useCallback(() => {
    paletteMounted.current = true;
  }, []);
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setNavOpen(false), [path]);
  useEffect(() => {
    // Fetch the palette's code while nothing else is happening, so ⌘K opens it at once.
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => void loadPalette(), { timeout: 4000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => void loadPalette(), 1500);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!paletteMounted.current) typedEarly.current = "";
        setPaletteOpen((o) => !o);
        return;
      }
      // Buffer what is typed while the palette is opening but not mounted yet.
      if (paletteOpenRef.current && !paletteMounted.current && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        typedEarly.current += e.key;
        setInitialQuery(typedEarly.current);
      } else if (paletteOpenRef.current && !paletteMounted.current && e.key === "Backspace") {
        e.preventDefault();
        typedEarly.current = typedEarly.current.slice(0, -1);
        setInitialQuery(typedEarly.current);
      }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [setPaletteOpen]);
  return (
    <div className="flex h-full min-h-0">
      <a href="#main" className="sr-only z-50 rounded-md bg-surface px-3 py-2 focus:not-sr-only focus:absolute focus:left-2 focus:top-2">Skip to content</a>
      <aside className="hidden w-60 shrink-0 border-r border-line bg-surface md:flex md:flex-col" aria-label="Main">
        <Sidebar onSearch={() => setPaletteOpen(true)} />
      </aside>
      <Dialog open={navOpen} onOpenChange={setNavOpen}>
        <NavDrawer onSearch={() => setPaletteOpen(true)} />
      </Dialog>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:hidden">
          <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setNavOpen(true)}><MenuIcon /></Button>
          <WorkspaceName className="min-w-0 flex-1" />
          <Button variant="ghost" size="icon" aria-label="Search and commands" onClick={() => setPaletteOpen(true)}><Search /></Button>
        </header>
        <ExpiryBanner />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      {paletteUsed ? <Suspense fallback={null}><CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} initialQuery={initialQuery} onReady={onPaletteReady} /></Suspense> : null}
    </div>
  );
}

function NavDrawer({ onSearch }: { onSearch: () => void }) {
  // A dialog styled as a left drawer on small screens.
  return (
    <DialogContentDrawer>
      <Sidebar onSearch={onSearch} />
    </DialogContentDrawer>
  );
}

function DialogContentDrawer({ children }: { children: ReactNode }) {
  return (
    <DialogContent title="Navigation" hideClose className="left-0 top-0 h-full max-h-none w-72 max-w-[85vw] translate-x-0 rounded-none border-y-0 border-l-0 [&>div:first-child]:sr-only [&>div:nth-child(2)]:p-0">
      <div className="flex h-full flex-col">{children}</div>
    </DialogContent>
  );
}

function WorkspaceName({ className }: { className?: string }) {
  const s = useSession();
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-fg">
        {s.workspace.name.trim().charAt(0).toUpperCase() || "W"}
      </span>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-base font-semibold"><bdi>{plainLabel(s.workspace.name)}</bdi></p>
        <p className="truncate text-xs text-subtle">{roleLabel(s.role)}</p>
      </div>
    </div>
  );
}


function NavLink({ to, params, icon, children, badge, exact }: { to: string; params?: Record<string, string>; icon: ReactNode; children: ReactNode; badge?: ReactNode; exact?: boolean }) {
  return (
    <Link
      to={to as never}
      params={params as never}
      activeOptions={{ exact: exact ?? false, includeSearch: false }}
      className="group flex h-8 items-center gap-2.5 rounded-md px-2 text-base text-muted hover:bg-surface-2 hover:text-fg data-[status=active]:bg-accent-soft data-[status=active]:font-medium data-[status=active]:text-accent-soft-fg [&_svg]:size-4"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {badge}
    </Link>
  );
}

function Sidebar({ onSearch }: { onSearch: () => void }) {
  const s = useSession();
  const objects = useObjects();
  const { standard, custom } = navObjects(objects.data ?? []);
  const deal = (objects.data ?? []).find((o) => o.name === "deal" && o.access.read);
  const attention = useAttentionCount();
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = standard.filter((o) => !isJunction(o));
  const junctions = standard.filter(isJunction);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line px-3 py-3"><WorkspaceName /></div>
      <div className="px-3 pt-3">
        <button type="button" onClick={onSearch}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-surface-2 px-2 text-base text-subtle hover:border-line-strong hover:text-muted">
          <Search aria-hidden className="size-4" /><span className="flex-1 text-left">Search…</span><Kbd>⌘K</Kbd>
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-label="Sections">
        <div className="flex flex-col gap-0.5">
          <NavLink to="/" icon={<Home />} exact>Home</NavLink>
          <NavLink to="/inbox" icon={<Bell />} badge={attention ? <span className="rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-fg" aria-label={`${attention} unread`}>{attention}</span> : null}>Inbox</NavLink>
          <NavLink to="/tasks" icon={<ListChecks />}>My tasks</NavLink>
          {deal ? <NavLink to="/board" icon={<Columns3 />}>Deals board</NavLink> : null}
        </div>
        <NavSection title="Records" objects={primary} loading={objects.isPending} />
        {custom.length ? <NavSection title="Custom objects" objects={custom} /> : null}
        {junctions.length ? (
          <div className="mt-4">
            <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}
              className="flex w-full items-center gap-1 px-2 pb-1 text-xs font-medium uppercase tracking-wide text-subtle hover:text-muted">
              <ChevronDown aria-hidden className={cn("size-3 transition-transform", !moreOpen && "-rotate-90")} /> Links between records
            </button>
            {moreOpen ? <div className="flex flex-col gap-0.5">{junctions.map((o) => <ObjectNavLink key={o.name} o={o} />)}</div> : null}
          </div>
        ) : null}
        {objects.error ? <ProblemView compact error={objects.error} onRetry={() => objects.refetch()} className="mt-3" /> : null}
        <div className="mt-4 flex flex-col gap-0.5">
          <NavLink to="/settings" icon={<Settings />}>Settings</NavLink>
        </div>
      </nav>
      <div className="border-t border-line p-2"><UserMenu name={s.member.name} email={s.member.email} /></div>
    </div>
  );
}

function ObjectNavLink({ o }: { o: ObjectSummary }) {
  return <NavLink to="/o/$object" params={{ object: o.name }} icon={<ObjectIcon object={o} />}>{o.plural_label}</NavLink>;
}

function NavSection({ title, objects, loading }: { title: string; objects: ObjectSummary[]; loading?: boolean }) {
  return (
    <div className="mt-4">
      <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-subtle">{title}</p>
      <div className="flex flex-col gap-0.5">
        {loading ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="mx-2 my-2 h-4 w-32" />) : objects.map((o) => <ObjectNavLink key={o.name} o={o} />)}
      </div>
    </div>
  );
}

/** Unread notifications, for the inbox badge. Quietly absent for roles that can't read the inbox. */
function useAttentionCount(): number {
  const api = useApi();
  const q = useQuery({
    queryKey: qk.attention,
    queryFn: async ({ signal }) => (await api.get<{ data: Attention }>("/v1/me/attention", undefined, signal)).data,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return q.data?.counts.unread ?? 0;
}

function UserMenu({ name, email }: { name: string; email: string }) {
  const signOut = useSignOut();
  const theme = useTheme();
  return (
    <Menu>
      <MenuTrigger asChild>
        {/* Named by its visible text (with "Account menu" for screen readers in front), so voice control finds it by what it shows. */}
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2">
          <span className="sr-only">Account menu: </span>
          <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-surface-3 text-sm font-semibold">{name.charAt(0).toUpperCase()}</span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-base font-medium">{name}</span>
            <span className="block truncate text-xs text-subtle">{email}</span>
          </span>
          <ChevronsUpDown aria-hidden className="size-3.5 text-subtle" />
        </button>
      </MenuTrigger>
      <MenuContent side="top" align="start" className="w-60">
        <MenuLabel>Signed in as {email}</MenuLabel>
        <MenuItem asChild><Link to="/settings/account"><UserRound /> Account and sessions</Link></MenuItem>
        <MenuItem asChild><Link to="/settings/account" hash="password"><KeyRound /> Password</Link></MenuItem>
        <MenuItem asChild><Link to="/settings/account" hash="connected-apps"><Plug /> Connected apps</Link></MenuItem>
        <MenuItem asChild><Link to="/settings/notifications"><Bell /> Notification settings</Link></MenuItem>
        <MenuSeparator />
        <MenuLabel>Theme</MenuLabel>
        <MenuRadioGroup value={theme.choice} onValueChange={(v) => theme.setChoice(v as ThemeChoice)}>
          <MenuRadioItem value="system"><Monitor /> System</MenuRadioItem>
          <MenuRadioItem value="light"><Sun /> Light</MenuRadioItem>
          <MenuRadioItem value="dark"><Moon /> Dark</MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem asChild><Link to="/settings/schema"><Building /> Workspace schema</Link></MenuItem>
        <MenuItem onSelect={() => void signOut()}><LogOut /> Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** A warning in the last 10 minutes before the session's absolute end (idle time is extended by use). */
function ExpiryBanner() {
  const s = useSession();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const ends = new Date(s.session.expires_at).getTime();
  if (!Number.isFinite(ends) || ends - now > 10 * 60_000) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning-soft px-4 py-2 text-sm text-warning-fg">
      <span className="flex-1">Your session ends at {formatDateTime(s.session.expires_at)}. Sign in again to keep working without interruption.</span>
      <Button size="sm" variant="secondary" onClick={() => window.location.assign(reauthHref())}>Sign in again</Button>
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex h-full" aria-busy="true" aria-label="Loading">
      <div className="hidden w-60 shrink-0 flex-col gap-3 border-r border-line bg-surface p-3 md:flex">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-4 w-36" />)}
      </div>
      <div className="flex-1 p-6"><Skeleton className="h-6 w-56" /><Skeleton className="mt-6 h-64 w-full" /></div>
    </div>
  );
}
