// Row selection and entry identity for the Log Manager card.
// Extracted from the entry card; functions take the card instance and
// preserve its `this`-state and existing method names.

import { concern, registerConcern } from "./card-core.js";

// Late-bound cross-module seam: `card-core.js` holds the registry.
const results = concern("results");

export function entryKey(card, entry) {
    return [entry.timestamp, entry.level, entry.logger, entry.message, entry.source || ""].join("|");
  }

export function runKeys(card, run) {
    return (run.times || []).map(ts => entryKey(card, {
      timestamp: ts,
      level: run.level,
      logger: run.logger,
      message: run.message,
      source: run.source,
    }));
  }

export function rowSelectionKeys(card, el) {
    const raw = el && el.dataset ? el.dataset.selKeys : null;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

export function orderedSelectableRows(card, container) {
    if (!container || typeof container.querySelectorAll !== "function") return [];
    return Array.from(container.querySelectorAll(".selectable-entry"))
      .filter(el => el.style.display !== "none");
  }

export function refreshSelection(card, container) {
    if (!container || typeof container.querySelectorAll !== "function") return;
    container.querySelectorAll(".selectable-entry").forEach(el => {
      const keys = rowSelectionKeys(card, el);
      const selected = !!keys && keys.length > 0 && keys.every(k => card._selectedKeys.has(k));
      el.classList.toggle("selected", selected);
    });
    if (container === card._livePreview) results.updateExportButtonState(card);
  }

export function clearSelection(card, container) {
    card._selectedKeys.clear();
    card._selectionAnchorRow = null;
    if (container) refreshSelection(card, container);
  }

export function applySelectionRange(card, container, fromRow, toRow) {
    const rows = orderedSelectableRows(card, container);
    const a = rows.indexOf(fromRow);
    const b = rows.indexOf(toRow);
    if (a === -1 || b === -1) return;
    const [from, to] = a <= b ? [a, b] : [b, a];
    for (let i = from; i <= to; i++) {
      const keys = rowSelectionKeys(card, rows[i]);
      if (keys) keys.forEach(k => card._selectedKeys.add(k));
    }
    refreshSelection(card, container);
  }

export function handleSelectionClick(card, container, target, e) {
    const row = target && target.closest ? target.closest(".selectable-entry") : null;
    if (!row) {
      // Clicking empty space or the header clears the selection.
      if (target === container ||
          (target.classList && (
            target.classList.contains("log-entries") ||
            target.classList.contains("log-preview") ||
            target.classList.contains("log-preview-header")
          ))) {
        clearSelection(card, container);
      }
      return;
    }
    const keys = rowSelectionKeys(card, row);
    if (!keys || keys.length === 0) return;
    if (e.shiftKey && card._selectionAnchorRow && container.contains(card._selectionAnchorRow)) {
      applySelectionRange(card, container, card._selectionAnchorRow, row);
    } else if (e.ctrlKey || e.metaKey) {
      const allSelected = keys.every(k => card._selectedKeys.has(k));
      keys.forEach(k => {
        if (allSelected) card._selectedKeys.delete(k);
        else card._selectedKeys.add(k);
      });
      card._selectionAnchorRow = row;
      refreshSelection(card, container);
    } else {
      card._selectedKeys.clear();
      keys.forEach(k => card._selectedKeys.add(k));
      card._selectionAnchorRow = row;
      refreshSelection(card, container);
    }
  }

export function attachSelection(card) {
    // Explicit row-selection model for the logger panel and the live/results views.
    card._activeList.addEventListener("mousedown", (e) => onSelectionMouseDown(card, card._activeList, e));
    card._livePreview.addEventListener("mousedown", (e) => onSelectionMouseDown(card, card._livePreview, e));
  }

export function onSelectionMouseDown(card, container, e) {
    if (e.button !== undefined && e.button !== 0) return;
    const row = e.target && e.target.closest ? e.target.closest(".selectable-entry") : null;
    if (!row) {
      handleSelectionClick(card, container, e.target, e);
      return;
    }
    if (typeof e.preventDefault === "function") e.preventDefault();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      handleSelectionClick(card, container, e.target, e);
      return;
    }
    handleSelectionClick(card, container, e.target, e);
    card._dragSelectState = { container, anchorRow: row };
    const onMove = (ev) => {
      const state = card._dragSelectState;
      if (!state) return;
      const over = ev.target && ev.target.closest ? ev.target.closest(".selectable-entry") : null;
      if (!over || over === state.anchorRow) return;
      applySelectionRange(card, state.container, state.anchorRow, over);
    };
    const onUp = () => {
      card._dragSelectState = null;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

// Mutable API object: the cross-concern call seam and the test stub target.
export const selection = {
  entryKey,
  runKeys,
  rowSelectionKeys,
  orderedSelectableRows,
  refreshSelection,
  clearSelection,
  applySelectionRange,
  handleSelectionClick,
  attachSelection,
  onSelectionMouseDown,
};
registerConcern("selection", selection);
