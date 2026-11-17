/**
 * The plural of an English label, for an object created without a `plural_label` ("Property" →
 * "Properties", "Box" → "Boxes", "Status" → "Statuses"). Only the last word changes, keeping its case.
 * A small set of rules, not a dictionary: a label it gets wrong is fixed by giving `plural_label`,
 * which always wins.
 */
const IRREGULAR: Record<string, string> = { person: "people", child: "children" };
const VOWELS = new Set(["a", "e", "i", "o", "u"]);

export function pluralize(label: string): string {
  const m = /^(.*?)([A-Za-z]+)$/s.exec(label);
  if (!m) return `${label}s`;
  const [, head, word] = m as unknown as [string, string, string];
  const lower = word.toLowerCase();
  const irregular = IRREGULAR[lower];
  if (irregular) return head + matchCase(word, irregular);
  // An acronym (SKU, API): "SKUs".
  if (word.length > 1 && word === word.toUpperCase()) return `${label}s`;
  const add = (cut: number, suffix: string) => head + word.slice(0, word.length - cut) + suffix;
  if (lower.endsWith("quiz")) return add(0, "zes");
  // Already ending in "s": "Address", "Status" and "Analysis" have plurals of their own; anything else
  // ending in "s" ("Settings", "News", "Projects") is most likely plural already and is left alone.
  if (/(ss|us)$/.test(lower)) return add(0, "es");
  if (lower.endsWith("sis") && lower.length > 4) return add(2, "es");
  if (lower.endsWith("s")) return label;
  if (/(x|z|ch|sh)$/.test(lower)) return add(0, "es");
  if (lower.endsWith("y") && lower.length > 1 && !VOWELS.has(lower.at(-2)!)) return add(1, "ies");
  return add(0, "s");
}

/** `plural` with the first letter's case of `word` ("Person" → "People"). */
function matchCase(word: string, plural: string): string {
  return word[0] === word[0]!.toUpperCase() ? plural[0]!.toUpperCase() + plural.slice(1) : plural;
}
