import { concern, registerConcern } from "./card-core.js";
import { utils } from "./card-utils.js";

// Late-bound cross-module seam: `card-core.js` holds the registry.
const loggers = concern("loggers");
const results = concern("results");
const selection = concern("selection");

// Live recording viewer: streaming, dedup grouping, filters,
// column widths and live summary.
// Extracted from the entry card; functions take the card instance and
// preserve its `this`-state and existing method names.

export function cleanupLivePolling(card) {
  if (card._livePollInterval) {
    clearInterval(card._livePollInterval);
    card._livePollInterval = null;
  }
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
    const prevLoggerFilter = card._liveLoggerFilter.value;
    const prevLevelFilter = card._liveLevelFilter.value;

    // Build logger filter dropdown.
    let filterHtml = '<option value="">All loggers</option>';
    card._recordingLoggers.forEach(name => {
      const stateObj = Object.values(card._hass.states).find(
        s => s.attributes.logger_name === name
      );
      const label = stateObj ? (stateObj.attributes.friendly_name || name) : name;
      filterHtml += `<option value="${utils.escapeAttr(name)}">${utils.escapeHtml(label)}</option>`;
    });
    card._liveLoggerFilter.innerHTML = filterHtml;
    card._liveLoggerFilter.value = initialLogger || prevLoggerFilter;
    card._liveLevelFilter.value = initialLogger ? "ALL" : prevLevelFilter;

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

    if (initialLogger) {
      applyLiveFilters(card);
      card._livePreview.scrollTop = 0;
    }
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

export function dedupRowInnerHtml(card, run, colors) {
    const logger = loggers.loggerCellHtml(card, run.logger);
    const msg = utils.escapeHtml(run.message);
    const chevron = card._expandedDedupKeys.has(run.key) ? "\u25BE" : "\u25B8";
    return `<span class="log-preview-col idx-col"><button type="button" class="dedup-toggle" title="Expand or collapse this group">${chevron}</button><span class="dedup-count">×${run.count}</span><span class="dedup-first-id">#${run.firstId + 1}</span></span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${utils.escapeHtml(run.level)}</span>
      <span class="log-preview-col time-col">${utils.dedupRangeText(run.firstTs, run.lastTs, card._locale())}</span>
      <span class="log-preview-col logger-col" title="${utils.escapeAttr(run.logger)}">${logger}</span>
      <span class="log-preview-col msg-col">${msg}</span>`;
  }

export function dedupItemsInnerHtml(card, run) {
    const colors = utils.levelColors(run.level);
    const logger = loggers.loggerCellHtml(card, run.logger);
    const msg = utils.escapeHtml(run.message);
    const keys = selection.runKeys(card, run);
    return run.times.map((ts, i) => {
      const time = new Date(ts * 1000).toLocaleTimeString(
        card._locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
      );
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
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    // The row and its badges are re-wired after in-place updates, so guard the
    // row-level double-click against accumulating duplicate listeners.
    if (!row.dataset.dedupDblclick) {
      row.dataset.dedupDblclick = "true";
      row.addEventListener("dblclick", (e) => { e.stopPropagation(); toggle(); });
    }
    row.querySelectorAll(".dedup-count").forEach(badge => {
      badge.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    });
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
    row.className = "log-preview-group selectable-entry";
    row.draggable = false;
    row.dataset.selKeys = JSON.stringify(selection.runKeys(card, run));
    row.dataset.logger = run.logger;
    row.dataset.level = run.level;
    row.dataset.key = run.key;
    row.dataset.firstId = String(run.firstId);
    row.dataset.count = String(run.count);
    row.dataset.ids = run.ids.join(",");
    row.style.background = colors.rowBg;
    row.title = "Identical entries grouped — expand to see each occurrence";
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
    const colors = utils.levelColors(run.level);
    group.row.dataset.count = String(run.count);
    group.row.dataset.ids = run.ids.join(",");
    group.row.dataset.selKeys = JSON.stringify(selection.runKeys(card, run));
    group.row.innerHTML = dedupRowInnerHtml(card, run, colors);
    // innerHTML replaced the toggle button, so re-wire it and keep state.
    wireDedupToggle(card, group.row, group.items, run.key);
    group.items.innerHTML = dedupItemsInnerHtml(card, run);
    group.items.style.display = card._expandedDedupKeys.has(run.key) ? "" : "none";
    selection.refreshSelection(card, group.row.parentElement || card._livePreview);
  }

export function appendFlatEntry(card, container, entry) {
    const time = new Date(entry.timestamp * 1000).toLocaleTimeString(
      card._locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    );
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
    const loggerFilter = card._liveLoggerFilter.value;
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
    const loggerFilter = card._liveLoggerFilter.value;
    const dedup = isDedupEnabled(card);

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

export function entryMatchesFilter(card, entry, levelFilter, loggerFilter) {
    // Exact match only: selecting a logger must not also show its children's
    // entries. Child loggers are reachable via "All loggers".
    if (loggerFilter && entry.logger !== loggerFilter) {
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
    const loggerFilter = card._liveLoggerFilter.value;
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
    card._livePauseBtn.title = card._livePaused ? "View paused — click to resume" : "Pause viewer update";
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
    const bufferPct = Math.round((seen / 10000) * 100);
    const recordingCount = card._recordingLoggers.length;
    const withEntries = new Set(card._recordingBuffer.map(entry => loggers.managedRoot(card, entry.logger))).size;
    const seenText = `${seen} entr${seen === 1 ? "y" : "ies"}${hidden > 0 ? ` (${hidden} hidden)` : ""}`;
    card._liveSummary.textContent =
      `${seenText} \u00B7 buffer at ${bufferPct}% \u00B7 ` +
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
    if (e.target === card._recordingLiveDialog) closeLive();
  });

  card._livePauseBtn.addEventListener("click", () => togglePauseLive(card));

  card._liveLoggerFilter.addEventListener("change", () => applyLiveFilters(card));
  card._liveLevelFilter.addEventListener("change", () => applyLiveFilters(card));

  // Clicking empty space or the header clears any text selection.
  card._livePreview.addEventListener("click", (e) => {
    if (e.target === card._livePreview || e.target.closest(".log-preview-header")) {
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    }
  });
}

// Mutable API object: the cross-concern call seam and the test stub target.
export const liveView = {
  cleanupLivePolling,
  openLiveView,
  pollRecordingEntries,
  updateLiveTimer,
  groupConsecutiveDedup,
  isDedupEnabled,
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
};
registerConcern("liveView", liveView);
