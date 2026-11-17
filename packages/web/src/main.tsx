import "./styles/app.css";
import { setNonce } from "get-nonce";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, readThemeHint } from "./lib/theme";

// The server puts a per-response nonce in this meta tag and allows it in the page's style-src: UI
// libraries that insert a <style> element (scroll locking under dialogs) use it.
const nonce = document.querySelector('meta[name="hlcrm-style-nonce"]')?.getAttribute("content");
if (nonce && !nonce.startsWith("__")) setNonce(nonce);

// The theme before the first paint (the member's saved choice replaces it once loaded).
applyTheme(readThemeHint());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
