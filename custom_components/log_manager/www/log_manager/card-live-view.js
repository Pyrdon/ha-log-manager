import { concern, registerConcern } from "./card-core.js";
import { utils } from "./card-utils.js";
import { ui } from "./card-ui.js";

// Late-bound cross-module seam: `card-core.js` holds the registry.
const loggers = concern("loggers");
const results = concern("results");
const selection = concern("selection");

// Live recording viewer: streaming, dedup grouping, filters,
// column widths and live summary.
// Extracted from the entry card; functions take the card instance and
// preserve its `this`-state and existing method names.

// Shared tooltip for a grouped-runs heading. Exposed on the `liveView` API
// object so the results view renders the same string.
export const DEDUP_GROUP_TITLE = "Identical entries grouped; click to expand.";

export function cleanupLivePolling(card) {
  if (card._livePollInterval) {
    clearInterval(card._livePollInterval);
    card._livePollInterval = null;
  }
}

// Logger filter is a searchable checkbox multi-select over the logger names
// present in the recording buffer. The card-held state (not the DOM-held
// checklist) is the model:
//   _loggerFilterNames    — every name seen in the buffer while the picker was
//                           closed, accumulated across polls.
//   _loggerFilterSelected — ticked names; the active filter selection.
//   _loggerFilterRendered — sorted snapshot last painted, for growth detection.
//   _loggerFilterOpen     — picker visibility gate.
// Rendering is visibility-gated: closed pickers only accumulate names; opening
// paints once from the sorted accumulated set; while open a repaint happens only
// when the accumulated set grew — never incremental appends.

// Accumulate the logger names present in the recording buffer. Cheap and
// DOM-free: safe to call on every poll while the picker is closed. A logger
// seen for the first time is ticked by default; a logger the user unticked has
// already been listed, so it is never "new" again and stays unticked. The
// ticked set is reconciled to the listed set so a badge-seeded logger that
// never emitted cannot hide every entry.
export function accumulateLoggerFilterNames(card) {
  if (!card._loggerFilterNames) card._loggerFilterNames = new Set();
  const selected = card._loggerFilterSelected || (card._loggerFilterSelected = new Set());
  let grew = false;
  (card._recordingBuffer || []).forEach(entry => {
    if (!entry || !entry.logger) return;
    if (!card._loggerFilterNames.has(entry.logger)) {
      card._loggerFilterNames.add(entry.logger);
      selected.add(entry.logger);
      grew = true;
    }
  });
  // Reconcile: drop ticked names that are not in the listed set.
  selected.forEach(name => {
    if (!card._loggerFilterNames.has(name)) selected.delete(name);
  });
  if (grew) updateLoggerFilterButton(card);
  return card._loggerFilterNames;
}

// Sorted snapshot of the accumulated names.
export function loggerFilterNames(card) {
  return Array.from(card._loggerFilterNames || []).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

// Friendly label for a logger name, using the entity when it is known.
export function loggerFilterLabel(card, name) {
  const states = (card._hass && card._hass.states) || {};
  const stateObj = Object.values(states).find(
    s => s.attributes && s.attributes.logger_name === name
  );
  return stateObj ? (stateObj.attributes.friendly_name || name) : name;
}

// Paint the picker's checkbox list from the accumulated sorted set. Names are
// already ticked by accumulation when they enter the picker; the remembered
// selection is kept. Only called when the picker is open and the set has grown.
export function renderLoggerFilterCheckboxes(card) {
  const list = card._loggerFilterList;
  if (!list) return;
  const names = loggerFilterNames(card);
  const selected = card._loggerFilterSelected;
  const query = (card._loggerFilterSearch && card._loggerFilterSearch.value || "").toLowerCase();
  list.innerHTML = names.map(name => {
    const checked = selected.has(name) ? " checked" : "";
    const label = loggerFilterLabel(card, name);
    const matches = !query || name.toLowerCase().includes(query) || label.toLowerCase().includes(query);
    return `<label class="logger-filter-item" style="display: ${matches ? "flex" : "none"};">
      <input type="checkbox" value="${utils.escapeAttr(name)}"${checked}>
      <span title="${utils.escapeAttr(name)}">${utils.escapeHtml(label)}</span>
    </label>`;
  }).join("");
  list.querySelectorAll("input[type='checkbox']").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(cb.value);
      else selected.delete(cb.value);
      updateLoggerFilterButton(card);
      applyLiveFilters(card);
    });
  });
  card._loggerFilterRendered = names.slice();
  updateLoggerFilterButton(card);
}

// The picker's closed state shows how many of the listed loggers are ticked.
export function updateLoggerFilterButton(card) {
  const btn = card._loggerFilterBtn;
  if (!btn) return;
  const names = card._loggerFilterNames || new Set();
  const selected = card._loggerFilterSelected || new Set();
  const total = names.size;
  const ticked = Array.from(names).filter(name => selected.has(name)).length;
  const label = (ticked === total || selected.size === 0)
    ? "All loggers"
    : `${ticked} logger${ticked === 1 ? "" : "s"}`;
  if (btn.textContent !== label) btn.textContent = label;
}

// Open the picker: paint once from the accumulated set, then re-render only on
// growth. Closing keeps the remembered selection.
export function openLoggerFilter(card) {
  card._loggerFilterOpen = true;
  accumulateLoggerFilterNames(card);
  renderLoggerFilterCheckboxes(card);
  if (card._loggerFilterPanel) card._loggerFilterPanel.style.display = "block";
  if (card._loggerFilterBtn) card._loggerFilterBtn.setAttribute("aria-expanded", "true");
}

export function closeLoggerFilter(card) {
  card._loggerFilterOpen = false;
  if (card._loggerFilterPanel) card._loggerFilterPanel.style.display = "none";
  if (card._loggerFilterBtn) card._loggerFilterBtn.setAttribute("aria-expanded", "false");
}

// While open, repaint only when new logger names arrived since the last paint.
export function refreshLoggerFilterIfGrown(card) {
  if (!card._loggerFilterOpen) return;
  const current = loggerFilterNames(card);
  const rendered = card._loggerFilterRendered || [];
  if (current.length !== rendered.length) {
    renderLoggerFilterCheckboxes(card);
  }
}

export function toggleLoggerFilter(card) {
  if (card._loggerFilterOpen) closeLoggerFilter(card);
  else openLoggerFilter(card);
}

export function openLiveView(card, initialLogger) {
    card._liveViewOpen = true;
    card._livePaused = false;
    card._pausedEntries = [];
    card._resultsShown = false;
    results.hideResultsSummary(card);
    if (card._liveDialogTitle) card._liveDialogTitle.textContent = "Live recording";
    if (card._recordingDedupToggle) card._recordingDedupToggle.checked = isDedupEnabled(card);

    // Preserve the previous filter selection unless a specific logger was
    // requested (e.g. from the recording-count badge).
    const prevLevelFilter = card._liveLevelFilter ? card._liveLevelFilter.value : "ALL";

    // Accumulate names from the buffer and (re)render the picker lazily.
    accumulateLoggerFilterNames(card);
    if (initialLogger) {
      // A specific logger was requested: tick only it.
      card._loggerFilterSelected = new Set([initialLogger]);
    }
    if (card._loggerFilterOpen) refreshLoggerFilterIfGrown(card);
    if (card._liveLevelFilter) card._liveLevelFilter.value = initialLogger ? "ALL" : prevLevelFilter;

    // Show top bar with live controls.
    card._liveStatusText.parentElement.style.display = "flex";
    card._livePauseBtn.style.display = "";
    card._livePauseBtn.textContent = "Pause";
    card._livePauseBtn.classList.remove("paused");
    card._livePauseBtn.title = "Pause viewer update";
    card._liveStopBtn.style.display = "";
    card._liveCloseBtn.textContent = "Close & keep recording";
    card._liveCloseBtn.title = "Close this window; the recording continues in the background.";
    card._liveClearBtn.style.display = "";
    card._liveDiscardBtn.style.display = "none";
    results.updateExportButtonState(card);

    updateLiveTimer(card);

    // Rebuild the preview on every open so captured entries appear immediately,
    // derived from the buffer with the current ticked logger set (the DOM is
    // cleared when the dialog closes). A specific-logger open scrolls to top.
    applyLiveFilters(card);
    if (initialLogger) card._livePreview.scrollTop = 0;
    liveView.updateLiveSummary(card);

    card._recordingLiveDialog.style.display = "flex";
    requestAnimationFrame(() => {
      card._recordingLiveDialog.classList.add("visible");
    });

    // Poll continuously; a paused view still refreshes the summary but skips
    // rebuilding the row list until it resumes.
    liveView.pollRecordingEntries(card);
    card._livePollInterval = setInterval(() => {
      liveView.pollRecordingEntries(card);
      updateLiveTimer(card);
    }, 1000);
  }

export function pollRecordingEntries(card) {
    if (card._recordingState !== "recording" && card._recordingState !== "completed") return;
    card._hass.connection.sendMessagePromise({
      type: "log_manager/recording_entries",
      after_id: card._liveLastId,
    }).then(res => {
      if (!res || !res.entries) return;
      const entries = res.entries;
      if (entries.length === 0) {
        liveView.updateLiveSummary(card);
        return;
      }

      // Store in recordingBuffer for export.
      for (const entry of entries) {
        card._recordingBuffer.push(entry);
      }
      // The picker accumulates names even while closed; if open it repaints
      // only when the accumulated set grew.
      accumulateLoggerFilterNames(card);
      refreshLoggerFilterIfGrown(card);

      card._liveLastId = res.next_id || 0;
      // While paused the summary (entry count, buffer fill) stays live but the
      // row list does not; the skipped rows replay on resume.
      if (card._livePaused) {
        card._pausedEntries.push(...entries);
      } else {
        appendLiveEntries(card, entries);
      }
      liveView.updateLiveSummary(card);
    }).catch(() => {});
  }

export function updateLiveTimer(card) {
    if (!card._recordingLiveDialog) return;
    if (card._recordingState === "recording") {
      const elapsed = Math.floor((Date.now() - card._recordingStartTime) / 1000);
      const remaining = Math.max(0, card._recordingMaxDuration - elapsed);
      const mins = String(Math.floor(remaining / 60)).padStart(2, "0");
      const secs = String(remaining % 60).padStart(2, "0");
      card._liveTimer.textContent = `${mins}:${secs} remaining`;
      card._liveStatusText.textContent = card._livePaused ? "Recording · view paused" : "Recording";
      card._liveStatusDot.style.display = "";
    } else {
      card._liveTimer.textContent = "";
      card._liveStatusText.textContent = "Recording complete";
      card._liveStatusDot.style.display = "none";
    }
  }

export function groupConsecutiveDedup(card, ordered) {
    const runs = [];
    let run = null;
    const flush = () => {
      if (run) {
        runs.push(run);
        run = null;
      }
    };
    for (const entry of ordered) {
      const key = utils.dedupKey(entry);
      if (run && run.key === key) {
        run.count += 1;
        run.lastTs = entry.timestamp;
        run.times.push(entry.timestamp);
        run.ids.push(entry.id);
      } else {
        flush();
        run = {
          key,
          logger: entry.logger,
          level: entry.level,
          message: entry.message,
          source: entry.source || "",
          firstId: entry.id,
          firstTs: entry.timestamp,
          lastTs: entry.timestamp,
          count: 1,
          times: [entry.timestamp],
          ids: [entry.id],
          first: entry,
        };
      }
    }
    flush();
    return runs;
  }

export function isDedupEnabled(card) {
    if (card._liveDedupOverride !== null && card._liveDedupOverride !== undefined) {
      return card._liveDedupOverride;
    }
    return !card.config || card.config.live_dedup !== false;
  }

// Pure: the 1-based id span a grouped run covers. A run of one shows a single
// id; a longer run shows `first–last` so the heading states the whole range.
export function dedupIdRangeText(run) {
    const ids = (run.ids && run.ids.length) ? run.ids : [run.firstId];
    const first = ids[0] + 1;
    const last = ids[ids.length - 1] + 1;
    return first === last ? `${first}` : `${first}\u2013${last}`;
  }

export function dedupRowInnerHtml(card, run, colors) {
    const logger = loggers.loggerCellHtml(card, run.logger);
    const msg = utils.escapeHtml(run.message);
    const chevron = card._expandedDedupKeys.has(run.key) ? "\u25BE" : "\u25B8";
    return `<span class="log-preview-col idx-col"><button type="button" class="dedup-toggle" title="Expand or collapse this group">${chevron}</button><span class="dedup-count">×${run.count}</span><span class="dedup-first-id">${dedupIdRangeText(run)}</span></span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${utils.escapeHtml(run.level)}</span>
      <span class="log-preview-col time-col">${utils.dedupRangeText(run.firstTs, run.lastTs, card._hass)}</span>
      <span class="log-preview-col logger-col" title="${utils.escapeAttr(run.logger)}">${logger}</span>
      <span class="log-preview-col msg-col">${msg}</span>`;
  }

export function dedupItemsInnerHtml(card, run, opts = {}) {
    const colors = utils.levelColors(run.level);
    const logger = loggers.loggerCellHtml(card, run.logger);
    const msg = utils.escapeHtml(run.message);
    const keys = selection.runKeys(card, run);
    const idxs = opts.onlyLast ? [run.times.length - 1] : run.times.map((_, i) => i);
    return idxs.map(i => {
      const ts = run.times[i];
      const time = utils.formatClockTime(ts, card._hass);
      const id = run.ids && run.ids[i] != null ? run.ids[i] + 1 : "";
      return `<div class="log-preview-group-item selectable-entry" data-sel-keys="${utils.escapeAttr(JSON.stringify(keys[i] ? [keys[i]] : []))}" draggable="false" style="background: ${colors.rowBg}; border-left: 2px solid ${colors.color}; margin-left: 24px;">
        <span class="log-preview-col idx-col">${id}</span>
        <span class="log-preview-col level-col" style="color: ${colors.color};">${utils.escapeHtml(run.level)}</span>
        <span class="log-preview-col time-col">${time}</span>
        <span class="log-preview-col logger-col" title="${utils.escapeAttr(run.logger)}">${logger}</span>
        <span class="log-preview-col msg-col">${msg}</span>
      </div>`;
    }).join("");
  }

export function wireDedupToggle(card, row, items, key) {
    const btn = row.querySelector(".dedup-toggle");
    if (!btn) return;
    const toggle = () => {
      const expanded = items.style.display === "none";
      items.style.display = expanded ? "" : "none";
      const chevron = row.querySelector(".dedup-toggle");
      if (chevron) chevron.textContent = expanded ? "\u25BE" : "\u25B8";
      if (expanded) {
        card._expandedDedupKeys.add(key);
      } else {
        card._expandedDedupKeys.delete(key);
      }
    };
    // The whole heading is a toggle (it is not selectable). The chevron button
    // and the count badge stop propagation so they toggle exactly once; a
    // click elsewhere in the heading bubbles to the row listener.
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    row.querySelectorAll(".dedup-count").forEach(badge => {
      badge.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    });
    row.addEventListener("click", () => toggle());
  }

export function startDedupGroup(card, container, firstEntry, secondEntry) {
    const run = {
      key: utils.dedupKey(firstEntry),
      logger: firstEntry.logger,
      level: firstEntry.level,
      message: firstEntry.message,
      source: firstEntry.source || "",
      firstId: firstEntry.id,
      firstTs: firstEntry.timestamp,
      lastTs: secondEntry.timestamp,
      count: 2,
      times: [firstEntry.timestamp, secondEntry.timestamp],
      ids: [firstEntry.id, secondEntry.id],
    };
    const colors = utils.levelColors(run.level);
    const row = document.createElement("div");
    // The heading is a toggle, not a selectable entry: its occurrences remain
    // individually selectable (REQ-CARD-093).
    row.className = "log-preview-group";
    row.draggable = false;
    row.dataset.selKeys = JSON.stringify(selection.runKeys(card, run));
    row.dataset.logger = run.logger;
    row.dataset.level = run.level;
    row.dataset.key = run.key;
    row.dataset.firstId = String(run.firstId);
    row.dataset.count = String(run.count);
    row.dataset.ids = run.ids.join(",");
    row.style.background = colors.rowBg;
    row.title = DEDUP_GROUP_TITLE;
    row.innerHTML = dedupRowInnerHtml(card, run, colors);
    const items = document.createElement("div");
    items.className = "log-preview-group-items";
    items.style.display = card._expandedDedupKeys.has(run.key) ? "" : "none";
    items.innerHTML = dedupItemsInnerHtml(card, run);
    wireDedupToggle(card, row, items, run.key);
    container.appendChild(row);
    container.appendChild(items);
    return { key: run.key, row, items, run };
  }

export function bumpDedupGroup(card, group, entry) {
    const run = group.run;
    run.count += 1;
    run.lastTs = entry.timestamp;
    run.ids.push(entry.id);
    run.times.push(entry.timestamp);
    group.row.dataset.count = String(run.count);
    group.row.dataset.ids = run.ids.join(",");
    group.row.dataset.selKeys = JSON.stringify(selection.runKeys(card, run));
    // In-place count + time-range + chevron update; do not rebuild the row, so
    // the wired toggle listeners and `_expandedDedupKeys` state survive.
    const badge = group.row.querySelector(".dedup-count");
    if (badge) badge.textContent = `\u00D7${run.count}`;
    const idEl = group.row.querySelector(".dedup-first-id");
    if (idEl) idEl.textContent = dedupIdRangeText(run);
    const timeCol = group.row.querySelector(".time-col");
    if (timeCol) timeCol.textContent = utils.dedupRangeText(run.firstTs, run.lastTs, card._hass);
    // Append only the new occurrence as a child; existing children keep their
    // DOM and selection classes.
    group.items.insertAdjacentHTML("beforeend", dedupItemsInnerHtml(card, run, { onlyLast: true }));
    // A growing `data-sel-keys` list means the group row's own selected state
    // can change, and the new child needs its selected class derived.
    selection.refreshSelection(card, group.row.parentElement || card._livePreview);
  }

export function appendFlatEntry(card, container, entry) {
    const time = utils.formatClockTime(entry.timestamp, card._hass);
    const level = entry.level;
    const colors = utils.levelColors(level);
    const logger = loggers.loggerCellHtml(card, entry.logger);
    const msg = utils.escapeHtml(entry.message);
    const div = document.createElement("div");
    div.className = "log-preview-line selectable-entry";
    div.draggable = false;
    div.dataset.selKeys = JSON.stringify([selection.entryKey(card, entry)]);
    div.dataset.logger = entry.logger;
    div.dataset.level = level;
    div.dataset.key = utils.dedupKey(entry);
    div.dataset.id = entry.id;
    div.style.background = colors.rowBg;
    div.innerHTML = `<span class="log-preview-col idx-col">${entry.id + 1}</span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${level}</span>
      <span class="log-preview-col time-col">${time}</span>
      <span class="log-preview-col logger-col" title="${utils.escapeAttr(entry.logger)}">${logger}</span>
      <span class="log-preview-col msg-col">${msg}</span>`;
    container.appendChild(div);
    return div;
  }

export function appendDedupEntry(card, container, entry) {
    const key = utils.dedupKey(entry);
    if (card._liveLastGroup && card._liveLastGroup.key === key) {
      bumpDedupGroup(card, card._liveLastGroup, entry);
      card._liveLastSingle = null;
      return;
    }
    if (card._liveLastSingle && card._liveLastSingle.key === key) {
      const first = card._liveLastSingle;
      const group = startDedupGroup(card, container, first.entry, entry);
      first.el.remove();
      card._liveLastGroup = group;
      card._liveLastSingle = null;
      return;
    }
    const div = appendFlatEntry(card, container, entry);
    card._liveLastSingle = { key, el: div, entry };
    card._liveLastGroup = null;
  }

export function rebuildLivePreview(card) {
    const container = card._livePreview;
    if (!container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 20;
    const prevTop = container.scrollTop;
    const levelFilter = card._liveLevelFilter.value;
    const loggerFilter = card._loggerFilterSelected;
    accumulateLoggerFilterNames(card);
    container.innerHTML = "";
    ensurePreviewHeader(card);
    card._liveLastGroup = null;
    card._liveLastSingle = null;
    if (isDedupEnabled(card)) {
      for (const entry of card._recordingBuffer) {
        if (!entryMatchesFilter(card, entry, levelFilter, loggerFilter)) continue;
        appendDedupEntry(card, container, entry);
      }
    } else {
      for (const entry of card._recordingBuffer) {
        const div = appendFlatEntry(card, container, entry);
        div.style.display = entryMatchesFilter(card, entry, levelFilter, loggerFilter) ? "" : "none";
      }
    }
    refreshLoggerFilterIfGrown(card);
    selection.refreshSelection(card, container);
    if (atBottom) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTop = Math.min(prevTop, container.scrollHeight);
    }
  }

export function resetDedupState(card) {
    card._liveLastGroup = null;
    card._liveLastSingle = null;
    card._expandedDedupKeys.clear();
    card._selectedKeys.clear();
    card._selectionAnchorRow = null;
  }

export function appendLiveEntries(card, entries) {
    const container = card._livePreview;
    ensurePreviewHeader(card);
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 20;

    const levelFilter = card._liveLevelFilter.value;
    const loggerFilter = card._loggerFilterSelected;
    const dedup = isDedupEnabled(card);

    // Accumulate the logger names seen in this batch.
    accumulateLoggerFilterNames(card);

    for (const entry of entries) {
      if (dedup) {
        // Filter-hidden entries skip the DOM entirely: they neither render
        // nor break visible runs, so groups reflect the visible stream.
        if (!entryMatchesFilter(card, entry, levelFilter, loggerFilter)) continue;
        appendDedupEntry(card, container, entry);
        continue;
      }
      const div = appendFlatEntry(card, container, entry);
      // Apply current filters so the filter controls can re-show rows in place.
      div.style.display = entryMatchesFilter(card, entry, levelFilter, loggerFilter) ? "" : "none";
    }
    selection.refreshSelection(card, container);

    if (atBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

export function loadColumnWidths(card) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem("log_manager_col_widths") || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Corrupt/unavailable storage: fall back to the CSS defaults.
    }
    return {};
  }

export function persistColumnWidths(card) {
    try {
      window.localStorage.setItem("log_manager_col_widths", JSON.stringify(card._colWidths || {}));
    } catch {
      // Storage unavailable: widths just won't persist.
    }
  }

export function applyColumnWidths(card) {
    if (!card._livePreview || !card._livePreview.style || !card._livePreview.style.setProperty) return;
    const w = card._colWidths || {};
    const set = (name, value) => {
      if (value) card._livePreview.style.setProperty(`--col-${name}`, `${value}px`);
    };
    set("idx", w.idx);
    set("level", w.level);
    set("time", w.time);
    set("logger", w.logger);
  }

export function wireColumnResize(card) {
    if (!card._livePreview || typeof card._livePreview.querySelectorAll !== "function") return;
    const kinds = ["idx", "level", "time", "logger"];
    card._livePreview.querySelectorAll(".log-preview-header .log-preview-col").forEach(cell => {
      if (cell.dataset.resizable) return;
      const kind = kinds.find(k => cell.classList.contains(`${k}-col`));
      if (!kind) return;
      cell.dataset.resizable = "true";
      cell.classList.add("resizable-col");
      cell.addEventListener("mousedown", (e) => {
        const rect = cell.getBoundingClientRect();
        if (rect.right - e.clientX > 6) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = rect.width;
        const onMove = (ev) => {
          card._colWidths[kind] = Math.max(40, Math.round(startW + (ev.clientX - startX)));
          applyColumnWidths(card);
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          persistColumnWidths(card);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

export function previewHeaderHtml(card) {
    return `<div class="log-preview-header">
      <span class="log-preview-col idx-col">#</span>
      <span class="log-preview-col level-col">Level</span>
      <span class="log-preview-col time-col">Time</span>
      <span class="log-preview-col logger-col">Logger</span>
      <span class="log-preview-col msg-col">Message</span>
    </div>`;
  }

export function ensurePreviewHeader(card) {
    if (!card._livePreview.querySelector(".log-preview-header")) {
      card._livePreview.insertAdjacentHTML("afterbegin", previewHeaderHtml(card));
    }
    applyColumnWidths(card);
    wireColumnResize(card);
  }

export function entryMatchesFilter(card, entry, levelFilter, loggerSelected) {
    // `loggerSelected` is the ticked-name Set. An entry shows when its logger
    // name is in the set; ticking one logger never implies its children.
    if (loggerSelected instanceof Set) {
      if (loggerSelected.size > 0 && !loggerSelected.has(entry.logger)) {
        return false;
      }
    } else if (loggerSelected && entry.logger !== loggerSelected) {
      // Tolerate a single-name string for callers/tests that pass one.
      return false;
    }
    if (levelFilter && levelFilter !== "ALL") {
      // Numeric severity comparison with a name fallback for retained buffers
      // captured before entries carried `levelno` (REQ-CARD-089).
      if (utils.entrySeverity(entry.level, entry.levelno) < utils.levelFilterFloor(levelFilter)) {
        return false;
      }
    }
    return true;
  }

export function applyLiveFilters(card) {
    if (isDedupEnabled(card)) {
      // Visible-stream grouping: regroup so hidden entries no longer split
      // identical visible runs. Results render newest-first, live oldest-first.
      if (card._resultsShown) {
        results.rebuildResultsPreview(card);
      } else {
        rebuildLivePreview(card);
      }
      if (card._resultsShown) results.renderResultsSummary(card);
      return;
    }
    const levelFilter = card._liveLevelFilter.value;
    const loggerFilter = card._loggerFilterSelected;
    card._livePreview.querySelectorAll(".log-preview-line").forEach(el => {
      el.style.display = entryMatchesFilter(card, 
        { logger: el.dataset.logger, level: el.dataset.level },
        levelFilter,
        loggerFilter
      ) ? "" : "none";
    });
    // The summary follows the filter on the flat path too.
    if (card._resultsShown) results.renderResultsSummary(card);
  }

export function togglePauseLive(card) {
    card._livePaused = !card._livePaused;
    card._livePauseBtn.textContent = card._livePaused ? "Resume" : "Pause";
    card._livePauseBtn.classList.toggle("paused", card._livePaused);
    card._livePauseBtn.title = card._livePaused ? "Paused; click to resume." : "Pause viewer update";
    if (card._recordingState === "recording") {
      card._liveStatusText.textContent = card._livePaused ? "Recording · view paused" : "Recording";
    }
    if (card._livePaused) {
      return;
    }
    // Replay rows captured while paused, then poll for anything newer.
    if (card._pausedEntries.length > 0) {
      const pending = card._pausedEntries;
      card._pausedEntries = [];
      appendLiveEntries(card, pending);
    }
    liveView.pollRecordingEntries(card);
  }

export function updateLiveSummary(card) {
    const seen = card._recordingBuffer.length;
    const hidden = Math.max(0, card._recordingBackendCount - seen);
    const recordingCount = card._recordingLoggers.length;
    const withEntries = new Set(card._recordingBuffer.map(entry => loggers.managedRoot(card, entry.logger))).size;
    const seenText = `${seen} entr${seen === 1 ? "y" : "ies"}${hidden > 0 ? ` (${hidden} hidden)` : ""}`;
    card._liveSummary.textContent =
      `${seenText} \u00B7 ` +
      `${recordingCount} logger${recordingCount === 1 ? "" : "s"} recording \u00B7 ` +
      `${withEntries} with entr${withEntries === 1 ? "y" : "ies"}`;
    results.updateExportButtonState(card);
  }

// Wire the live-view dialog and preview controls onto the card.
export function attachLiveView(card) {
  // Open the live view only while a recording is in progress.
  card._liveBtn.addEventListener("click", () => {
    if (card._recordingState === "recording") openLiveView(card);
  });

  // Live view dialog handlers.
  const closeLive = () => results.closeLiveView(card);
  card._liveCloseBtn.addEventListener("click", closeLive);
  card._recordingLiveDialog.addEventListener("click", (e) => {
    if (e.target === card._recordingLiveDialog) {
      closeLive();
      return;
    }
    // A click outside the entry table clears any explicit selection, unless it
    // landed on a control that does not change which logs are seen: the entry
    // table, the export actions, the top bar (Pause/Stop), the grouping row,
    // the filter bar/picker, or any interactive control. Filter changes may
    // re-derive the selection themselves; the clearing click is not the place.
    const target = e.target;
    if (!target || !target.closest) return;
    if (target.closest(".log-preview")) return;
    if (target.closest("#live-export-actions")) return;
    if (target.closest("#live-top-bar")) return;
    if (target.closest(".dedup-row")) return;
    if (target.closest("#live-filter-bar")) return;
    if (target.closest(".logger-filter")) return;
    if (target.closest("button, input, select, textarea, label")) return;
    if (card._selectedKeys && card._selectedKeys.size > 0) {
      selection.clearSelection(card, card._livePreview);
    }
  });

  card._livePauseBtn.addEventListener("click", () => togglePauseLive(card));

  // The logger filter is now a searchable checkbox multi-select. The button
  // toggles the panel; the search box filters visible rows; checkbox changes
  // repaint the list.
  if (card._loggerFilterBtn) {
    card._loggerFilterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLoggerFilter(card);
    });
  }
  if (card._loggerFilterSearch) {
    card._loggerFilterSearch.addEventListener("input", () => {
      renderLoggerFilterCheckboxes(card);
    });
  }
  // A click outside the picker closes it without touching the selection.
  card._recordingLiveDialog.addEventListener("click", (e) => {
    if (!card._loggerFilterOpen) return;
    if (e.target.closest && e.target.closest(".logger-filter")) return;
    closeLoggerFilter(card);
  });

  card._liveLevelFilter.addEventListener("change", () => {
    // Keep the closed control's colour in step with the new selection.
    ui.tintLevelOptions(card._liveLevelFilter);
    applyLiveFilters(card);
  });
  // Colour every level-filter option, not just the selected value.
  ui.tintLevelOptions(card._liveLevelFilter);

  // Clicking empty space or the header clears any text selection.
  card._livePreview.addEventListener("click", (e) => {
    if (e.target === card._livePreview || e.target.closest(".log-preview-header")) {
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    }
  });

  // Wheel anywhere over the recording window scrolls the entry list, but only
  // while that list actually overflows; otherwise let the page scroll normally.
  card._recordingLiveDialog.addEventListener("wheel", (e) => {
    const list = card._livePreview;
    if (!list) return;
    if (e.target && e.target.closest && e.target.closest(".log-preview, .logger-filter")) return;
    const canScroll = list.scrollHeight > list.clientHeight + 1;
    if (!canScroll) return;
    e.preventDefault();
    list.scrollTop += e.deltaY;
  }, { passive: false });
}

// Mutable API object: the cross-concern call seam and the test stub target.
export const liveView = {
  cleanupLivePolling,
  openLiveView,
  accumulateLoggerFilterNames,
  loggerFilterNames,
  loggerFilterLabel,
  renderLoggerFilterCheckboxes,
  updateLoggerFilterButton,
  openLoggerFilter,
  closeLoggerFilter,
  refreshLoggerFilterIfGrown,
  toggleLoggerFilter,
  pollRecordingEntries,
  updateLiveTimer,
  groupConsecutiveDedup,
  isDedupEnabled,
  dedupIdRangeText,
  dedupRowInnerHtml,
  dedupItemsInnerHtml,
  wireDedupToggle,
  startDedupGroup,
  bumpDedupGroup,
  appendFlatEntry,
  appendDedupEntry,
  rebuildLivePreview,
  resetDedupState,
  appendLiveEntries,
  loadColumnWidths,
  persistColumnWidths,
  applyColumnWidths,
  wireColumnResize,
  previewHeaderHtml,
  ensurePreviewHeader,
  entryMatchesFilter,
  applyLiveFilters,
  togglePauseLive,
  updateLiveSummary,
  attachLiveView,
  DEDUP_GROUP_TITLE,
};
registerConcern("liveView", liveView);
