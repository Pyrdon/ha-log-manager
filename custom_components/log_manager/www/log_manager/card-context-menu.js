import { concern, registerConcern } from "./card-core.js";
import { utils } from "./card-utils.js";

// Late-bound cross-module seam: `card-core.js` holds the registry. `selection`
// is aliased so it does not collide with the DOM Selection in
// `handlePreviewCopy`.
const addForm = concern("addForm");
const loggers = concern("loggers");
const results = concern("results");
const selectionApi = concern("selection");

// Context menu and plain-text serialization for the Log Manager card.
// Extracted from the entry card; functions take the card instance and
// preserve its `this`-state and existing method names.

export function previewMenuItems(card) {
    const hasEntries = card._recordingBuffer.length > 0;
    const selected = results.selectedBufferKeys(card).length;
    return [
      { label: "Save as .log", disabled: !hasEntries, action: () => results.downloadLogs(card, "plain") },
      { label: "Save as JSONL", disabled: !hasEntries, action: () => results.downloadLogs(card, "jsonl") },
      {
        label: selected > 0 ? `Copy ${selected} selected` : "Copy to clipboard",
        disabled: !hasEntries,
        action: () => results.copyLogsToClipboard(card),
      },
    ];
  }

export function showContextMenu(card, items, x, y) {
    const menu = card._contextMenu || card._previewContextMenu;
    if (!menu) return;
    const usable = (items || []).filter(Boolean);
    if (usable.length === 0) return;
    menu.innerHTML = "";
    usable.forEach(item => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.label;
      btn.disabled = !!item.disabled;
      if (item.title) btn.title = item.title;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        hideContextMenu(card);
        item.action();
      });
      menu.appendChild(btn);
    });
    menu.style.display = "block";
    // Clamp inside the viewport once the real size is known.
    menu.style.left = "0px";
    menu.style.top = "0px";
    const rect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

export function hideContextMenu(card) {
    const menu = card._contextMenu || card._previewContextMenu;
    if (menu) menu.style.display = "none";
  }

export function copyText(card, text) {
    if (text == null || text === "") return;
    navigator.clipboard.writeText(String(text)).catch(err => console.error("Failed to copy:", err));
  }

// Copy with a visible fallback: when the clipboard write rejects, surface a
// themed dialog telling the user to copy the text manually rather than failing
// silently.
export function copyTextWithFallback(card, text) {
    if (text == null || text === "") return;
    navigator.clipboard.writeText(String(text)).catch(err => {
      console.error("Failed to copy:", err);
      loggers.showDeleteConfirm(card,
        "Copy failed. Select the text and press Ctrl+C to copy it manually.",
        () => {},
        "Copy",
        "OK"
      );
    });
  }

// Themed menu for the results summary and status text: copy the element's own
// text.
export function summaryMenuItems(card, el) {
    const text = (el && el.textContent) || "";
    return [
      { label: "Copy summary", disabled: !text, action: () => copyTextWithFallback(card, text) },
    ];
  }

export function entriesToText(card, entries) {
    return entries.map(entry => {
      const time = utils.formatDateTime(entry.timestamp, card._hass);
      const level = entry.level.padEnd(8);
      const src = entry.source ? ` (${entry.source})` : "";
      return `[${time}] ${level} ${entry.logger}  ${entry.message}${src}`;
    }).join("\n") + "\n";
  }

export function handleListContextMenu(card, e) {
    // Text-editing surfaces keep the browser's native menu.
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    // Group headers are toggles, not loggers: give them a themed menu too so
    // right-click does not fall through to the browser's menu.
    const header = e.target.closest ? e.target.closest(".log-group-header") : null;
    if (header) {
      e.preventDefault();
      const group = header.dataset.group || "";
      showContextMenu(card, [
        { label: "Copy path prefix", action: () => copyText(card, group) },
        { label: "Collapse or expand section", action: () => {
          const collapsed = !loggers.getCollapsedGroups(card)[group];
          loggers.setGroupCollapsed(card, group, collapsed);
          card._scheduleUpdate && card._scheduleUpdate();
        } },
      ], e.clientX, e.clientY);
      return;
    }
    const row = e.target.closest ? e.target.closest(".log-row") : null;
    const loggerName = row && row.dataset.loggerName;
    if (!loggerName) return;
    e.preventDefault();
    const items = [];
    if (e.target.closest(".counter-badge")) {
      items.push({ label: "Expand or collapse panel", action: () => addForm.toggleExpand(card, loggerName) });
    }
    const eid = loggers.findEntityIdByLogger(card, loggerName);
    const friendly = eid ? (card._hass.states[eid].attributes.friendly_name || loggerName) : loggerName;
    items.push({ label: "Copy logger path", action: () => copyText(card, loggerName) });
    items.push({ label: "Copy friendly name", action: () => copyText(card, friendly) });
    const entry = e.target.closest(".selectable-entry");
    if (entry) {
      const keys = selectionApi.rowSelectionKeys(card, entry) || [];
      const all = (card._counters[loggerName] || {}).recent_logs || [];
      const one = all.find(en => selectionApi.entryKey(card, en) === keys[0]);
      const selected = all.filter(en => card._selectedKeys.has(selectionApi.entryKey(card, en)));
      items.push({ label: "Copy entry", disabled: !one, action: () => copyText(card, entriesToText(card, one ? [one] : [])) });
      items.push({
        label: `Copy selected entries (${selected.length})`,
        disabled: selected.length === 0,
        action: () => copyText(card, entriesToText(card, selected)),
      });
      items.push({ label: "Copy all captured entries", disabled: all.length === 0, action: () => copyText(card, entriesToText(card, all)) });
    } else {
      const editBtn = row.querySelector(".edit-btn");
      const removeBtn = row.querySelector(".remove-btn");
      items.push({ label: "Edit logger", disabled: !editBtn || editBtn.disabled, action: () => editBtn && editBtn.click() });
      items.push({ label: "Remove logger", disabled: !removeBtn || removeBtn.disabled, action: () => removeBtn && removeBtn.click() });
    }
    showContextMenu(card, items, e.clientX, e.clientY);
  }

export function handleChecklistContextMenu(card, e) {
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    const item = e.target.closest ? e.target.closest(".checklist-item") : null;
    if (!item) return;
    const cb = item.querySelector("input[type='checkbox']");
    const loggerName = cb && cb.dataset.logger;
    if (!loggerName) return;
    e.preventDefault();
    showContextMenu(card, [
      { label: "Copy logger path", action: () => copyText(card, loggerName) },
    ], e.clientX, e.clientY);
  }

export function handleHistoryContextMenu(card, e) {
    const tr = e.target.closest ? e.target.closest("tr") : null;
    if (!tr || !tr.closest("tbody")) return;
    e.preventDefault();
    const rowText = Array.from(tr.children).map(td => td.textContent).join("\t");
    const allText = card._historyLoggerPath ? historyRowsText(card, card._historyLoggerPath) : "";
    showContextMenu(card, [
      { label: "Copy row", action: () => copyText(card, rowText) },
      { label: "Copy all history", disabled: !allText, action: () => copyText(card, allText) },
    ], e.clientX, e.clientY);
  }

export function historyRowsText(card, loggerName) {
    return loggers.getAuditEntries(card, loggerName).slice(0, card.constructor.AUDIT_SHOW).map(a => (
      `${utils.formatDateTime(a.ts, card._hass)}\t${loggers.auditSourceLabel(card, a.source)}\t${a.old_level || "?"}\t${a.new_level || "?"}`
    )).join("\n");
  }

export function attachCopyPanelHandler(card, row) {
    const btn = row.querySelector(".copy-panel-btn");
    if (!btn) return;
    // Remove stale listeners to prevent duplicate handler accumulation.
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener("click", (e) => {
      e.stopPropagation();
      const loggerName = clone.dataset.logger;
      if (!loggerName) return;
      const stats = card._counters[loggerName];
      if (!stats) return;
      const all = stats.recent_logs || [];
      if (all.length === 0) return;
      const selected = all.filter(entry => card._selectedKeys.has(selectionApi.entryKey(card, entry)));
      const logs = selected.length > 0 ? selected : all;
      const text = entriesToText(card, logs);
      navigator.clipboard.writeText(text).then(() => {
        const original = clone.textContent;
        clone.textContent = "Copied!";
        setTimeout(() => { clone.textContent = original; }, 2000);
      }).catch(err => console.error("Failed to copy:", err));
    });
  }

export function handlePreviewCopy(card, e) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!range || !card._livePreview.contains(range.startContainer)) return;

    const groupFor = (node) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el) return null;
      const row = el.closest(".log-preview-line, .log-preview-group");
      if (row) return row;
      const item = el.closest(".log-preview-group-item");
      if (item) {
        const prev = item.parentElement && item.parentElement.previousElementSibling;
        if (prev && prev.classList.contains("log-preview-group")) return prev;
      }
      return null;
    };
    const startRow = groupFor(range.startContainer);
    const endRow = groupFor(range.endContainer);
    if (!startRow || !endRow) return;

    const allRows = Array.from(card._livePreview.querySelectorAll(".log-preview-line, .log-preview-group"));
    const startIdx = allRows.indexOf(startRow);
    const endIdx = allRows.indexOf(endRow);
    if (startIdx === -1 || endIdx === -1) return;
    const from = Math.min(startIdx, endIdx);
    const to = Math.max(startIdx, endIdx);

    const formatEntry = (entry) => {
      const time = utils.formatDateTime(entry.timestamp, card._hass);
      const level = entry.level.padEnd(8);
      const src = entry.source ? ` (${entry.source})` : "";
      return `[${time}] ${level} ${entry.logger}  ${entry.message}${src}`;
    };
    const lines = [];
    for (let i = from; i <= to; i++) {
      const row = allRows[i];
      if (row.classList.contains("log-preview-group")) {
        // Expand grouped runs back to their buffer entries via the stored id list.
        const ids = String(row.dataset.ids || "")
          .split(",")
          .filter(s => s !== "")
          .map(Number);
        for (const id of ids) {
          const entry = card._recordingBuffer.find(rec => rec.id === id);
          if (entry) lines.push(formatEntry(entry));
        }
        continue;
      }
      const entry = card._recordingBuffer.find(rec => String(rec.id) === String(row.dataset.id));
      if (!entry) continue;
      lines.push(formatEntry(entry));
    }
    if (lines.length > 0) {
      e.preventDefault();
      e.clipboardData.setData("text/plain", lines.join("\n") + "\n");
    }
  }

// Wire the context menu onto the preview, logger list, checklist and history
// table. Called from the card shell once the UI elements exist.
export function attachContextMenu(card) {
  // One contextmenu handler on the live/results dialog suppresses the native
  // browser menu everywhere inside it, EXCEPT over text-entry controls (input,
  // textarea, select) where cut/copy/paste must stay native. The entry table
  // gets the themed preview menu; the summary/status text gets Copy/Select-all;
  // anywhere else the native menu is suppressed with no themed menu.
  const onDialogContextMenu = (e) => {
    const target = e.target;
    if (target && target.closest && target.closest("input, textarea, select")) return;
    e.preventDefault();
    if (target && target.closest && target.closest(".log-preview")) {
      showContextMenu(card, previewMenuItems(card), e.clientX, e.clientY);
      return;
    }
    const summary = target && target.closest
      ? target.closest("#results-summary, #live-summary, #live-status-text")
      : null;
    if (summary) {
      showContextMenu(card, summaryMenuItems(card, summary), e.clientX, e.clientY);
      return;
    }
    hideContextMenu(card);
  };
  if (card._recordingLiveDialog) {
    card._recordingLiveDialog.addEventListener("contextmenu", onDialogContextMenu);
  } else if (card._livePreview) {
    // Defensive fallback for a card built without the dialog element.
    card._livePreview.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(card, previewMenuItems(card), e.clientX, e.clientY);
    });
  }
  card._livePreview.addEventListener("scroll", () => hideContextMenu(card));
  card._activeList.addEventListener("contextmenu", (e) => handleListContextMenu(card, e));
  card._loggerChecklist.addEventListener("contextmenu", (e) => handleChecklistContextMenu(card, e));
  card._historyTableBody.addEventListener("contextmenu", (e) => handleHistoryContextMenu(card, e));
  window.addEventListener("click", () => hideContextMenu(card));

  // Format selected rows nicely when copying from the preview.
  card._livePreview.addEventListener("copy", (e) => handlePreviewCopy(card, e));
}

// Mutable API object: the cross-concern call seam and the test stub target.
export const contextMenu = {
  previewMenuItems,
  showContextMenu,
  hideContextMenu,
  copyText,
  copyTextWithFallback,
  summaryMenuItems,
  entriesToText,
  handleListContextMenu,
  handleChecklistContextMenu,
  handleHistoryContextMenu,
  historyRowsText,
  attachCopyPanelHandler,
  handlePreviewCopy,
  attachContextMenu,
};
registerConcern("contextMenu", contextMenu);
