import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CARD_PATH = path.resolve(
  __dirname,
  "../../custom_components/log_manager/www/log_manager/log_manager_card.js"
);
// The stylesheet is split by surface; read every part plus the concatenator so
// CSS-text assertions see the whole stylesheet.
const STYLES_PATHS = [
  "card-styles.js",
  "card-styles-base.js",
  "card-styles-dialogs.js",
  "card-styles-recording.js",
  "card-styles-selection.js",
].map((name) =>
  path.resolve(
    __dirname,
    "../../custom_components/log_manager/www/log_manager",
    name
  )
);
const MARKUP_PATH = path.resolve(
  __dirname,
  "../../custom_components/log_manager/www/log_manager/card-markup.js"
);
const UTILS_PATH = path.resolve(
  __dirname,
  "../../custom_components/log_manager/www/log_manager/card-utils.js"
);

// Source text of the single card module, for assertions that inspect CSS/markup.
export const cardSource = fs.readFileSync(CARD_PATH, "utf8");
// Source text of the extracted style and markup modules, for assertions that
// inspect the CSS/markup text after the Step 2 split.
export const cardStylesSource = STYLES_PATHS.map((p) =>
  fs.readFileSync(p, "utf8")
).join("\n");
export const cardMarkupSource = fs.readFileSync(MARKUP_PATH, "utf8");
export const cardUtilsSource = fs.readFileSync(UTILS_PATH, "utf8");

let cardClass = null;

// Every concern module exports a mutable API object (see
// tools/js_add_api_objects.mjs). Re-export those objects so tests can call the
// concern functions directly and stub them with jest.spyOn(object, "fn").
// A frozen ESM namespace cannot be spied on; the object can.
export { utils } from "../../custom_components/log_manager/www/log_manager/card-utils.js";
export { loggers } from "../../custom_components/log_manager/www/log_manager/card-loggers.js";
export { addForm } from "../../custom_components/log_manager/www/log_manager/card-add-form.js";
export { selection } from "../../custom_components/log_manager/www/log_manager/card-selection.js";
export { recordingSetup } from "../../custom_components/log_manager/www/log_manager/card-recording-setup.js";
export { recordingSession } from "../../custom_components/log_manager/www/log_manager/card-recording-session.js";
export { liveView } from "../../custom_components/log_manager/www/log_manager/card-live-view.js";
export { results } from "../../custom_components/log_manager/www/log_manager/card-results.js";
export { contextMenu } from "../../custom_components/log_manager/www/log_manager/card-context-menu.js";

// jsdom defines `shadowRoot` as a getter-only accessor on Element.prototype.
// Tests assign `el.shadowRoot = mockRoot` before calling `_buildUI`, which then
// reads `this.shadowRoot` back to populate and query it. A read-only accessor
// cannot receive that assignment, so wrap it with a settable shim backed by a
// per-element store: a test-provided root is returned on read, otherwise the
// native getter (the real shadow root) is used.
function installShadowRootSetterShim() {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot");
  if (!descriptor || !descriptor.get) return;

  const nativeGet = descriptor.get;
  const overrides = new WeakMap();

  Object.defineProperty(Element.prototype, "shadowRoot", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get() {
      if (overrides.has(this)) return overrides.get(this);
      return nativeGet.call(this);
    },
    set(value) {
      overrides.set(this, value);
    },
  });
}

installShadowRootSetterShim();

// Preserved from the original harness (test lines ~12-25) for parity: a stub
// that exposes a detached div as `shadowRoot` while the card module is
// evaluated, then restores the native implementation. The module body only
// declares the class and registers it, so this window is inert; document
// instances are created later, after the restore, against jsdom's native
// attachShadow (which the card's shadowRoot interactions rely on).
function installAttachShadowStub() {
  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function () {
    const root = document.createElement("div");
    root.className = "shadow-root";
    this.shadowRoot = root;
    return root;
  };
  return () => {
    Element.prototype.attachShadow = originalAttachShadow;
  };
}

// Import the card module for its side effects (custom element definition +
// window.customCards registration) and return the exported class. The card
// loads its sibling style/markup modules through an async loader; wait for that
// promise so `_buildUI` has the strings before any test runs.
export async function setupCard() {
  if (cardClass) return cardClass;

  const restoreAttachShadow = installAttachShadowStub();
  try {
    const mod = await import(
      "../../custom_components/log_manager/www/log_manager/log_manager_card.js"
    );
    cardClass = mod.LogManagerCard;
    // The card loads its sibling style/markup modules asynchronously; wait so
    // `_buildUI` has the strings before any test runs.
    await mod.whenCardModulesLoaded();
  } finally {
    restoreAttachShadow();
  }

  return cardClass;
}
