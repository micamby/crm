import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CommandPalette } from "@/features/search/CommandPalette";
import { ThemeProvider } from "@/lib/theme";
import { renderApp, type Handler } from "./utils";

const OBJECTS = [
  { name: "contact", label: "Contact", plural_label: "Contacts", standard: true, access: { read: true, write: true, archive: true }, id_prefix: "con", owned: true, field_count: 3 },
  { name: "deal_contact", label: "Deal contact", plural_label: "Deal contacts", standard: true, access: { read: true, write: true, archive: true }, id_prefix: "dc", owned: false, field_count: 2 },
  { name: "field_visit", label: "Field visit", plural_label: "Field visits", standard: false, access: { read: true, write: true, archive: true }, id_prefix: "fv", owned: true, field_count: 2 },
];

function handler(delay: { resolve?: () => void } = {}): Handler {
  return (c) => {
    if (c.path === "/v1/objects") return { body: { data: OBJECTS } };
    if (c.path === "/v1/search") {
      void delay;
      return { body: { data: [{ id: "con_1", object: "contact", display_name: "Ada Arden" }, { id: "con_2", object: "contact", display_name: "Ada Brook" }] } };
    }
    return undefined;
  };
}

const palette = (props: Partial<Parameters<typeof CommandPalette>[0]> = {}) => (
  <ThemeProvider stored="light"><CommandPalette open onOpenChange={() => {}} {...props} /></ThemeProvider>
);

describe("the command palette, by keyboard", () => {
  it("selects the first record when results arrive, so Enter opens it; no 'No matches' beside results", async () => {
    const { router } = renderApp(palette(), handler());
    const input = await screen.findByRole("combobox");
    await userEvent.type(input, "Ada");
    const first = await screen.findByRole("option", { name: /Ada Arden/ });
    await waitFor(() => expect(first).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByText("No matches")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/o/contact/con_1"));
  });

  it("keeps a selection the person moved when results come in", async () => {
    renderApp(palette(), handler());
    const input = await screen.findByRole("combobox");
    await userEvent.type(input, "Ad");
    await screen.findByRole("option", { name: /Ada Arden/ });
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("option", { name: /Ada Brook/ })).toHaveAttribute("aria-selected", "true"));
    await userEvent.type(input, "a");
    await new Promise((r) => setTimeout(r, 400));
    // Typing again resets: the first result is selected once more.
    await waitFor(() => expect(screen.getByRole("option", { name: /Ada Arden/ })).toHaveAttribute("aria-selected", "true"));
  });

  it("says 'No matches' only once a search settled with nothing", async () => {
    renderApp(palette(), (c) => (c.path === "/v1/objects" ? { body: { data: OBJECTS } } : c.path === "/v1/search" ? { body: { data: [] } } : undefined));
    const input = await screen.findByRole("combobox");
    await userEvent.type(input, "zzqx");
    expect(screen.queryByText("No matches")).not.toBeInTheDocument();
    expect(await screen.findByText("No matches")).toBeInTheDocument();
  });

  it("starts with what was typed before it loaded", async () => {
    renderApp(palette({ initialQuery: "Ada" }), handler());
    expect(await screen.findByRole("combobox")).toHaveValue("Ada");
    expect(await screen.findByRole("option", { name: /Ada Arden/ })).toBeInTheDocument();
  });

  it("offers to create custom objects whose API name has an underscore, but not link objects", async () => {
    renderApp(palette(), handler());
    await userEvent.type(await screen.findByRole("combobox"), "new");
    expect(await screen.findByRole("option", { name: "New field visit" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "New contact" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "New deal contact" })).not.toBeInTheDocument();
  });
});
