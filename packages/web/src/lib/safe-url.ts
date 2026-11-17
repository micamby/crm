/**
 * Links built from record data. Only http(s), mailto and tel links are ever rendered from a value;
 * anything else (javascript:, data:, a relative path) is shown as text. Emails and phones get their
 * scheme added here, so a stored value can never choose its own.
 */
const SAFE = new Set(["http:", "https:", "mailto:", "tel:"]);

/** The href for a URL field's value, or null when it isn't a safe absolute link. */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > 2048 || [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return null;
  try {
    const u = new URL(v);
    return SAFE.has(u.protocol) && (u.protocol === "mailto:" || u.protocol === "tel:" || u.hostname !== "") ? u.href : null;
  } catch {
    return null;
  }
}

export function mailtoHref(value: unknown): string | null {
  if (typeof value !== "string" || !/^[^\s@<>"]+@[^\s@<>"]+$/.test(value.trim())) return null;
  return `mailto:${encodeURIComponent(value.trim()).replace(/%40/g, "@")}`;
}

export function telHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.trim().replace(/[^\d+x]/g, "");
  return /^\+?\d{3,20}(x\d{1,8})?$/.test(digits) ? `tel:${digits.replace("x", ";ext=")}` : null;
}
