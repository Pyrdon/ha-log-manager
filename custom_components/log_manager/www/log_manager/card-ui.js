// Generic presentation helpers for the Log Manager card: severity tinting of
// level-select options and a neutral confirmation dialog.
//
// Leaf module: depends only on card-utils.js. Concern modules consume it
// (ui.tintLevelOptions, ui.showConfirm); it never imports them.
import { utils } from "./card-utils.js";

// Sentinel values that are not severities. ALL is the neutral catch-all;
// DISABLED is the alert-off marker. Everything else maps to its level colour.
const SENTINEL_COLORS = {
  ALL: "var(--primary-text-color)",
  DISABLED: "var(--secondary-text-color)",
};

// Text colour for a single level option value.
export function optionColor(value) {
  if (SENTINEL_COLORS[value]) return SENTINEL_COLORS[value];
  return utils.levelColors(value).color;
}

// Colour every option of one level select by severity. Idempotent: re-running
// only rewrites the inline colours, so a rebuild is not required. Only option
// colours and the closed control's text colour are set; backgrounds and borders
// stay owned by each call site.
export function tintLevelOptions(select) {
  if (!select || !select.options) return;
  Array.from(select.options).forEach((opt) => {
    opt.style.color = optionColor(opt.value);
  });
  select.style.color = optionColor(select.value);
}

// The concrete level-select classes the card renders. Kept explicit rather
// than inferred so the enumeration is auditable; capture selectors use
// `.recording-level-select`.
const LEVEL_SELECT_SELECTORS = [
  "select.level-select",
  "select.alert-level-select",
  "select.recording-level-select",
  "select.filter-level-select",
  "select.set-all-level",
];

// Tint every level select in the card, including options. Accepts the card
// element or any container; falls back to the set-all select held on the card.
export function tintAllLevelSelects(card) {
  if (!card) return;
  const root = card.shadowRoot || card;
  if (typeof root.querySelectorAll === "function") {
    root.querySelectorAll(LEVEL_SELECT_SELECTORS.join(", ")).forEach(tintLevelOptions);
  }
  if (card._setAllLevel) tintLevelOptions(card._setAllLevel);
}

// Lazily wire the neutral confirm dialog's buttons once per element.
function ensureConfirmWired(card) {
  const dlg = card._confirmDialog;
  if (!dlg || dlg.dataset.wired) return;
  dlg.dataset.wired = "true";
  dlg.querySelector("#confirm-cancel-btn").addEventListener("click", () => closeConfirm(card, false));
  dlg.querySelector("#confirm-ok-btn").addEventListener("click", () => closeConfirm(card, true));
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) closeConfirm(card, false);
  });
}

function closeConfirm(card, confirmed) {
  const dlg = card._confirmDialog;
  if (dlg) dlg.style.display = "none";
  const target = card._confirmTarget;
  card._confirmTarget = null;
  if (!target) return;
  if (confirmed) target.onConfirm && target.onConfirm();
  else target.onCancel && target.onCancel();
}

// Dismiss an open confirm as if the user chose "No", running onCancel.
export function dismissConfirm(card) {
  if (!card._confirmDialog || card._confirmDialog.style.display !== "flex") return false;
  closeConfirm(card, false);
  return true;
}

// Neutral confirmation dialog, reusable for non-destructive prompts. Unlike
// showDeleteConfirm it carries no destructive styling; callers choose the
// button labels and whether the message is pre-escaped HTML.
export function showConfirm(card, message, onConfirm, opts = {}) {
  const {
    title = "Confirm",
    confirmLabel = "Yes",
    cancelLabel = "No",
    onCancel = null,
    htmlMessage = false,
  } = opts;
  const dlg = card._confirmDialog;
  if (!dlg) {
    // No dialog in the DOM (headless caller): run the callback directly.
    if (onConfirm) onConfirm();
    return;
  }
  ensureConfirmWired(card);
  card._confirmTarget = { onConfirm, onCancel };
  dlg.querySelector("#confirm-title").textContent = title;
  const msgEl = dlg.querySelector("#confirm-message");
  if (htmlMessage) msgEl.innerHTML = message;
  else msgEl.textContent = message;
  // A prior showNotice hid the cancel button; a confirm always restores it.
  const cancelBtn = dlg.querySelector("#confirm-cancel-btn");
  cancelBtn.style.display = "";
  cancelBtn.textContent = cancelLabel;
  dlg.querySelector("#confirm-ok-btn").textContent = confirmLabel;
  dlg.style.display = "flex";
}

// Display a message with a single OK button, no decision to make. Reuses the
// neutral confirm dialog; unlike showConfirm it runs no callback, so it is
// fire-and-forget. The cancel button is hidden while it is shown and restored
// by the next showConfirm.
export function showNotice(card, message, opts = {}) {
  const {
    title = "Notice",
    confirmLabel = "OK",
    htmlMessage = false,
  } = opts;
  const dlg = card._confirmDialog;
  if (!dlg) return;
  showConfirm(card, message, null, { title, confirmLabel, htmlMessage });
  const cancelBtn = dlg.querySelector("#confirm-cancel-btn");
  if (cancelBtn) cancelBtn.style.display = "none";
}

// Mutable API object: the test stub target for concern modules.
export const ui = {
  optionColor,
  tintLevelOptions,
  tintAllLevelSelects,
  showConfirm,
  showNotice,
  dismissConfirm,
};
