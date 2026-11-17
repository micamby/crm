import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mailtoHref, safeHref, telHref } from "@/lib/safe-url";
import { safeReturn } from "@/features/auth/SignInPage";

describe("links from data", () => {
  it("renders only http(s), mailto and tel links", () => {
    expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "/relative", "vbscript:x", "https://exa\nmple.com", "file:///etc/passwd"]) {
      expect(safeHref(bad), bad).toBeNull();
    }
    expect(mailtoHref("a@b.co")).toBe("mailto:a@b.co");
    expect(mailtoHref("a@b.co?subject=x\"><script>")).toBeNull();
    expect(telHref("+1 (555) 010-2000 x12")).toBe("tel:+15550102000;ext=12");
    expect(telHref("call me")).toBeNull();
  });
  it("comes back after sign-in only to a page of this app", () => {
    expect(safeReturn("/o/contact?view=v_1#x")).toBe("/o/contact?view=v_1#x");
    for (const bad of ["//evil.example", "https://evil.example/", "/\\evil.example", "/auth/signed-in", "/sign-in?return_to=/", "/v1/me", "javascript:x", "/\tx", 42]) {
      expect(safeReturn(bad), String(bad)).toBe("/");
    }
    // An MCP client's authorization request comes back to the server's consent page, whatever its length (up to the server's 2048).
    const authorize = `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: `https://client.example/${"c".repeat(900)}.json`, redirect_uri: "https://client.example/cb", state: "s".repeat(400), code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://mcp.example.com/mcp/admin", scope: "admin" })}`;
    expect(authorize.length).toBeGreaterThan(512);
    expect(safeReturn(authorize)).toBe(authorize);
    expect(safeReturn("/auth/apps")).toBe("/auth/apps");
    expect(safeReturn(`/oauth/authorize?state=${"s".repeat(2048)}`)).toBe("/");
    for (const bad of ["/oauth/token", "/auth/apps/revoke", "/signed-out", "/healthz", "/mcp/ops", "/.well-known/openid-configuration", "/auth/sign-in?return_to=/oauth/authorize", "/AUTH/signed-in"]) expect(safeReturn(bad), bad).toBe("/");
  });
});

/** Relative luminance and contrast ratio, per WCAG 2.x. */
function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

describe("design tokens", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
  const block = (sel: string) => {
    const body = new RegExp(`${sel.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css)![1]!;
    return Object.fromEntries([...body.matchAll(/--hl-([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
  };
  for (const [name, t] of [["light", block(":root")], ["dark", { ...block(":root"), ...block(".dark") }]] as const) {
    it(`meets WCAG AA in the ${name} theme`, () => {
      const text: [string, string][] = [["fg", "bg"], ["fg", "surface"], ["muted", "surface"], ["muted", "bg"], ["muted", "surface-2"], ["subtle", "surface"], ["subtle", "bg"],
        ["accent", "surface"], ["accent-fg", "accent"], ["accent-soft-fg", "accent-soft"], ["danger-fg", "danger-soft"], ["warning-fg", "warning-soft"],
        ["success-fg", "success-soft"], ["info-fg", "info-soft"], ["danger-fg", "surface"]];
      for (const [f, b] of text) expect(ratio(t[f]!, t[b]!), `${f} on ${b}`).toBeGreaterThanOrEqual(4.5);
      for (const [f, b] of [["line-strong", "surface"], ["focus", "surface"], ["focus", "bg"]] as [string, string][]) expect(ratio(t[f]!, t[b]!), `${f} on ${b}`).toBeGreaterThanOrEqual(3);
    });
  }
});
