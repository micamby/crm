/**
 * Text from the workspace (labels, names, values) can carry Unicode bidirectional controls: a value
 * stored as U+202E + "exe.txt" would display as "txt.exe". Values are shown inside `<bdi>` (the
 * shared display components do it), which keeps their direction from leaking into what's around them;
 * labels in menus, headers and navigation also lose the controls themselves.
 */

// LRM, RLM, ALM and the embedding, override and isolate controls.
const BIDI_CONTROLS = /[‎‏؜‪-‮⁦-⁩]/g;

/** A label without bidirectional control characters. */
export const plainLabel = (s: string | null | undefined): string => (s ?? "").replace(BIDI_CONTROLS, "");

/** True when the text holds bidirectional controls. */
export const hasBidiControls = (s: string) => new RegExp(BIDI_CONTROLS.source).test(s);

/**
 * Descriptions of the standard objects and fields are written for API clients and AI agents, and
 * name the operations that change things ("Change its stage with move_deal_stage"). People see them
 * as hints in forms and dialogs, so here they say what to do in the app instead. Workspaces created
 * earlier keep the stored wording, so this is done as describe arrives (meta/hooks.ts), not in the catalog.
 */
const FOR_PEOPLE: [RegExp, string][] = [
  [/Change its stage with move_deal_stage\./g, "Change its stage on the deal's page or on the Deals board."],
  [/Stage ID or stage name\. Defaults to the pipeline's first stage\. Change later with move_deal_stage\./g,
    "Starts in the pipeline's first stage unless you pick another. Change it later on the deal's page or on the Deals board."],
  [/Change later with move_deal_stage\./g, "Change it later on the deal's page or on the Deals board."],
  [/Becomes a deal through convert_lead\./g, "Becomes a deal when you convert it on the lead's page."],
  [/\bmove_deal_stage\b/g, "moving the deal to another stage"],
  [/\bconvert_lead\b/g, "converting the lead"],
];

/** A standard object's or field's description in words for people (see FOR_PEOPLE). */
export function forPeople(text: string | undefined): string | undefined {
  if (!text) return text;
  let out = text;
  for (const [re, words] of FOR_PEOPLE) out = out.replace(re, words);
  return out;
}
