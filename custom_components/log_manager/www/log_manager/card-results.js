import { concern, registerConcern } from "./card-core.js";
import { utils } from "./card-utils.js";

// Late-bound cross-module seam: `card-core.js` holds the registry. `loggers`
// is aliased so it does not collide with the local `loggers` map below.
const liveView = concern("liveView");
const loggersApi = concern("loggers");
const recordingSession = concern("recordingSession");
const selection = concern("selection");

// Recording results view: grouping, summary, export and clipboard copy.
// Extracted from the entry card; functions take the card instance and
// preserve its `this`-state and existing method names.

// Selection keys that resolve to entries actually present in the recording
// buffer. Selections made in the counting panel belong to a different list
// and must not inflate the export scope.
export function selectedBufferKeys(card) {
  const bufferKeys = new Set(card._recordingBuffer.map(entry => selection.entryKey(card, entry)));
  return [...card._selectedKeys].filter(key => bufferKeys.has(key));
}

export function updateExportButtonState(card) {
  if (!card._liveSavePlainBtn) return;
  const hasEntries = card._recordingBuffer.length > 0;
  const scope = card._recordingState === "recording" ? "captured so far" : "all recorded";
  const selectedCount = selectedBufferKeys(card).length;
  const scopeLabel = selectedCount > 0 ? `${selectedCount} selected` : "all";
  card._liveSavePlainBtn.disabled = !hasEntries;
  card._liveSaveJsonlBtn.disabled = !hasEntries;
  card._liveCopyBtn.disabled = !hasEntries;
  card._liveSavePlainBtn.textContent = `Save ${scopeLabel} as .log`;
  card._liveSaveJsonlBtn.textContent = `Save ${scopeLabel} as JSONL`;
  card._liveCopyBtn.textContent = selectedCount > 0
    ? `Copy ${selectedCount} selected`
    : "Copy all";
  card._liveSavePlainBtn.title = `Save ${scope} entries as a plain-text .log file`;
  card._liveSaveJsonlBtn.title = `Save ${scope} entries as JSONL (.jsonl).`;
  card._liveCopyBtn.title = selectedCount > 0
    ? `Copy ${selectedCount} selected entr${selectedCount === 1 ? "y" : "ies"} to clipboard`
    : `Copy ${scope} entries to clipboard`;
}

export function showRecordingResults(card) {
    const count = card._recordingLogCount;
    const hasEntries = count > 0;

    // Accumulate the emitting loggers from the buffer; a reloaded card may have
    // no recorded-loggers list. Paint the checkboxes lazily.
    liveView.accumulateLoggerFilterNames(card);
    if (card._loggerFilterOpen) liveView.refreshLoggerFilterIfGrown(card);

    // Hide live top bar, show completed state.
    if (card._liveDialogTitle) card._liveDialogTitle.textContent = "Recording results";
    card._liveStatusText.parentElement.style.display = "none";
    card._livePauseBtn.style.display = "none";
    card._liveStopBtn.style.display = "none";
    card._liveCloseBtn.textContent = "Close";
    card._liveCloseBtn.title = "The recorded data stays available until you discard it.";
    card._liveClearBtn.style.display = "none";
    card._liveDiscardBtn.style.display = "";
    // Keep the grouping toggle visible and synced with the results setting.
    if (card._recordingDedupToggle) card._recordingDedupToggle.checked = liveView.isDedupEnabled(card);

    updateExportButtonState(card);
    // The recorded-count line moves into the results summary (so "Copy summary"
    // captures it too). The live summary line is only used for the empty state.
    card._liveSummary.textContent = hasEntries
      ? ""
      : `No events matched the configured levels.`;

    if (hasEntries) {
      // Live expansions don't transfer: results groups start collapsed.
      card._expandedDedupKeys.clear();
      results.rebuildResultsPreview(card);
      renderResultsSummary(card);
    } else {
      hideResultsSummary(card);
      // The summary owns the single empty-state message; leave the table blank.
      card._livePreview.innerHTML = "";
    }
    card._resultsShown = true;
    card._livePreview.scrollTop = 0;
    card._liveViewOpen = false;
    card._recordingLiveDialog.style.display = "flex";
    requestAnimationFrame(() => {
      card._recordingLiveDialog.classList.add("visible");
    });
  }

export function rebuildResultsPreview(card) {
    const container = card._livePreview;
    if (!container) return;
    if (card._recordingBuffer.length === 0) {
      // The summary owns the single empty-state message; leave the table blank.
      container.innerHTML = "";
      return;
    }
    const levelFilter = card._liveLevelFilter.value;
    const loggerFilter = card._loggerFilterSelected;
    liveView.accumulateLoggerFilterNames(card);
    let html = liveView.previewHeaderHtml(card);
    // Results render oldest-first, matching the live view, so a group's first
    // id is its first chronological entry in both views.
    const ordered = card._recordingBuffer.slice();
    if (!liveView.isDedupEnabled(card)) {
      ordered.forEach(entry => {
        html += resultsLineHtml(card, entry);
      });
    } else {
      // Filters apply so the visible stream groups the same way it does live.
      for (const run of liveView.groupConsecutiveDedup(card, ordered)) {
        // Filter on the run's representative entry so its numeric `levelno`
        // participates in the severity comparison (REQ-CARD-089).
        if (!liveView.entryMatchesFilter(card, run.first, levelFilter, loggerFilter)) continue;
        html += run.count === 1 ? resultsLineHtml(card, run.first) : resultsGroupHtml(card, run);
      }
    }
    container.innerHTML = html;
    liveView.applyColumnWidths(card);
    liveView.wireColumnResize(card);
    // The preview DOM was replaced: live trackers reference detached nodes.
    card._liveLastGroup = null;
    card._liveLastSingle = null;
    container.querySelectorAll(".log-preview-group").forEach(row => {
      const items = row.nextElementSibling;
      if (!items || !items.classList.contains("log-preview-group-items")) return;
      liveView.wireDedupToggle(card, row, items, row.dataset.key);
    });
    selection.refreshSelection(card, container);
    container.scrollTop = 0;
  }

export function resultsLineHtml(card, entry) {
    const time = utils.formatClockTime(entry.timestamp, card._hass);
    const level = entry.level;
    const colors = utils.levelColors(level);
    const logger = loggersApi.loggerCellHtml(card, entry.logger);
    const msg = utils.escapeHtml(entry.message);
    return `<div class="log-preview-line selectable-entry" data-id="${entry.id}" data-sel-keys="${utils.escapeAttr(JSON.stringify([selection.entryKey(card, entry)]))}" draggable="false" data-logger="${utils.escapeAttr(entry.logger)}" data-level="${utils.escapeAttr(level)}" data-key="${utils.escapeAttr(utils.dedupKey(entry))}" style="background: ${colors.rowBg};">
      <span class="log-preview-col idx-col">${entry.id + 1}</span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${utils.escapeHtml(level)}</span>
      <span class="log-preview-col time-col">${time}</span>
      <span class="log-preview-col logger-col" title="${utils.escapeAttr(entry.logger)}">${logger}</span>
      <span class="log-preview-col msg-col">${msg}</span>
    </div>`;
  }

export function resultsGroupHtml(card, run) {
    const colors = utils.levelColors(run.level);
    // Results groups start collapsed; live expansions don't transfer.
    const expanded = card._expandedDedupKeys.has(run.key);
    return `<div class="log-preview-group" data-sel-keys="${utils.escapeAttr(JSON.stringify(selection.runKeys(card, run)))}" draggable="false" data-logger="${utils.escapeAttr(run.logger)}" data-level="${utils.escapeAttr(run.level)}" data-key="${utils.escapeAttr(run.key)}" data-first-id="${run.firstId}" data-count="${run.count}" data-ids="${utils.escapeAttr(run.ids.join(","))}" style="background: ${colors.rowBg};" title="${utils.escapeAttr(liveView.DEDUP_GROUP_TITLE)}">
      ${liveView.dedupRowInnerHtml(card, run, colors)}
    </div><div class="log-preview-group-items" style="display: ${expanded ? "" : "none"};">${liveView.dedupItemsInnerHtml(card, run)}</div>`;
  }

export function summarizeResults(card, logs) {
    const severityOrder = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
    const severity = {};
    // Numeric level per name, when the entry carried `levelno`; used to order
    // non-standard levels by real severity rather than alphabetically.
    const severityNo = {};
    const loggers = {};
    for (const entry of logs) {
      severity[entry.level] = (severity[entry.level] || 0) + 1;
      if (severityNo[entry.level] == null && entry.levelno != null) {
        severityNo[entry.level] = entry.levelno;
      }
      const root = loggersApi.managedRootFor(card, entry.logger);
      loggers[root] = (loggers[root] || 0) + 1;
    }
    const top = (rows, limit) => {
      // Code-unit tie-break: locale-independent so top-5 picks are stable.
      const sorted = rows.slice().sort((a, b) => b.count - a.count || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
      return { top: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) };
    };
    const loggerRows = Object.entries(loggers).map(([name, count]) => (
      { label: name, logger: name, count, sortKey: name }
    ));
    return {
      total: logs.length,
      severity: severityOrder
        .filter(level => severity[level] > 0)
        .map(level => ({ level, count: severity[level] }))
        // Non-standard levels trail after the ordered ones, sorted by numeric
        // severity with a name fallback (REQ-CARD-089).
        .concat(Object.keys(severity).filter(level => !severityOrder.includes(level))
          .sort((a, b) => utils.compareEntriesBySeverity(
            { level: a, levelno: severityNo[a] },
            { level: b, levelno: severityNo[b] },
          ))
          .map(level => ({ level, count: severity[level] }))),
      loggers: top(loggerRows, 5),
    };
  }

export function ensureResultsSummaryEl(card) {
    const host = card._livePreview && card._livePreview.parentElement;
    if (!host) return null;
    let el = host.querySelector("#results-summary");
    if (!el) {
      el = document.createElement("div");
      el.id = "results-summary";
      el.className = "results-summary";
      el.style.display = "none";
      host.appendChild(el);
    }
    // Place the summary below the table, directly after the status line.
    if (card._liveSummary && card._liveSummary.parentElement === host) {
      host.insertBefore(el, card._liveSummary.nextSibling);
    }
    return el;
  }

export function hideResultsSummary(card) {
    const host = card._livePreview && card._livePreview.parentElement;
    const el = host && host.querySelector("#results-summary");
    if (el) el.style.display = "none";
  }

export function renderResultsSummary(card) {
    const el = ensureResultsSummaryEl(card);
    if (!el) return;
    // The recorded-count line belongs to the summary and must survive a filter
    // that hides every entry, so gate the block on the session total instead.
    const recordedTotal = card._recordingLogCount || 0;
    if (recordedTotal === 0) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    // The details follow the active results filter, matching the table.
    const levelFilter = card._liveLevelFilter ? card._liveLevelFilter.value : "ALL";
    const loggerFilter = card._loggerFilterSelected || new Set();
    const visible = card._recordingBuffer.filter(entry =>
      liveView.entryMatchesFilter(card, entry, levelFilter, loggerFilter)
    );
    const summary = summarizeResults(card, visible);
    const esc = (s) => utils.escapeHtml(String(s == null ? "" : s));
    const escAttr = (s) => utils.escapeAttr(String(s == null ? "" : s));
    const friendly = (name) => {
      const stateObj = Object.values((card._hass && card._hass.states) || {}).find(
        s => s.attributes.logger_name === name
      );
      return stateObj ? (stateObj.attributes.friendly_name || name) : name;
    };
    const sevLine = summary.severity.map(({ level, count }) => {
      const colors = utils.levelColors(level);
      return `<span style="color: ${colors.color};">${esc(level)} ${count}</span>`;
    }).join(" · ");
    const loggerRows = summary.loggers.top.map(({ logger, count }) =>
      `<div class="summary-row"><span class="summary-label" title="${escAttr(logger)}">${esc(friendly(logger))}</span><span class="summary-count">×${count}</span></div>`
    ).join("") + (summary.loggers.more > 0 ? `<div class="results-summary-more">+${summary.loggers.more} more</div>` : "");
    const recordedLine = `Recorded ${recordedTotal} log entr${recordedTotal === 1 ? "y" : "ies"} over ${utils.formatDuration(card._recordingDuration || 0)}.`;
    // With every entry filtered out, keep just the recorded line.
    const details = summary.total === 0 ? "" : `
      <div class="summary-title">Summary</div>
      <div class="summary-sev-line">${sevLine}</div>
      <div class="summary-section-title">Loggers</div>
      ${loggerRows}`;
    el.innerHTML = `
      <div class="summary-recorded-line">${esc(recordedLine)}</div>${details}`;
    el.style.display = "";
  }

export function fetchResults(card) {
    card._hass.connection.sendMessagePromise({
      type: "log_manager/stop_recording",
    }).then(res => {
      if (res && res.logs) {
        card._recordingBuffer = res.logs;
        card._recordingDuration = res.duration || 0;
        card._recordingLogCount = res.log_count || 0;
        card._recordingBackendCount = res.log_count || 0;
        card._recordingState = "results";
        results.showRecordingResults(card);
      }
    }).catch(err => {
      console.error("Failed to fetch recording results:", err);
      card._recordingState = null;
      recordingSession.updateRecordingUI(card);
    });
  }

export function closeLiveView(card) {
    liveView.cleanupLivePolling(card);
    card._liveViewOpen = false;
    card._resultsShown = false;
    // Close the picker but keep the remembered ticked set for the next open.
    liveView.closeLoggerFilter(card);
    hideResultsSummary(card);
    card._recordingLiveDialog.classList.remove("visible");
    card._recordingLiveDialog.style.display = "none";
    // Restore live top bar state for next open. Filter, entries, and scroll
    // position are preserved so reopening the view restores the same state.
    card._liveStatusText.parentElement.style.display = "flex";
    card._livePauseBtn.style.display = "";
    card._liveStopBtn.style.display = "";
    card._livePaused = false;
    card._pausedEntries = [];
    // A completed recording stays available until explicitly discarded.
    if (card._recordingState === "results") {
      card._recordingState = "completed";
    }
    recordingSession.updateRecordingUI(card);
  }

export function downloadLogs(card, format) {
    // Download exactly the selection when one exists, otherwise everything.
    const selectedKeys = new Set(selectedBufferKeys(card));
    const logs = selectedKeys.size > 0
      ? card._recordingBuffer.filter(e => selectedKeys.has(selection.entryKey(card, e)))
      : card._recordingBuffer;
    const dateStr = utils.formatFileTimestamp(new Date(), card._hass);

    let content, filename, mimeType;

    if (format === "plain") {
      const lines = logs.map(entry => {
        const time = utils.formatDateTime(entry.timestamp, card._hass);
        const level = entry.level.padEnd(8);
        const logger = entry.logger;
        const msg = entry.message;
        const src = entry.source ? ` (${entry.source})` : "";
        return `[${time}] ${level} ${logger}  ${msg}${src}`;
      }).join("\n");
      content = lines + "\n";
      filename = `recording_${dateStr}.log`;
      mimeType = "text/plain";
    } else {
      content = logs.map(entry => JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        logger: entry.logger,
        message: entry.message,
        source: entry.source || undefined,
      })).join("\n") + "\n";
      filename = `recording_${dateStr}.jsonl`;
      mimeType = "application/jsonl";
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

export function copyLogsToClipboard(card) {
    const logs = card._recordingBuffer;
    if (!logs || logs.length === 0) return;
    const selected = logs.filter(entry => card._selectedKeys.has(selection.entryKey(card, entry)));
    const toCopy = selected.length > 0 ? selected : logs;
    const text = toCopy.map(entry => {
      const time = utils.formatDateTime(entry.timestamp, card._hass);
      const level = entry.level.padEnd(8);
      const src = entry.source ? ` (${entry.source})` : "";
      return `[${time}] ${level} ${entry.logger}  ${entry.message}${src}`;
    }).join("\n") + "\n";

    navigator.clipboard.writeText(text).then(() => {
      const original = card._liveCopyBtn.textContent;
      card._liveCopyBtn.textContent = "Copied!";
      setTimeout(() => { card._liveCopyBtn.textContent = original; }, 2000);
    }).catch(err => {
      console.error("Failed to copy:", err);
    });
  }

// Wire the export controls of the live/results dialog onto the card.
export function attachResults(card) {
  card._liveSavePlainBtn.addEventListener("click", () => downloadLogs(card, "plain"));
  card._liveSaveJsonlBtn.addEventListener("click", () => downloadLogs(card, "jsonl"));
  card._liveCopyBtn.addEventListener("click", () => copyLogsToClipboard(card));
  // Grouping toggle repaints whichever view is currently shown.
  if (card._recordingDedupToggle) {
    card._recordingDedupToggle.addEventListener("change", () => {
      card._liveDedupOverride = card._recordingDedupToggle.checked;
      if (card._resultsShown) {
        rebuildResultsPreview(card);
        renderResultsSummary(card);
      } else if (card._liveViewOpen) {
        // Live expansions are keyed by plain dedup key; a regrouping can merge
        // runs differently, so drop stale expansion state before rebuilding.
        card._expandedDedupKeys.clear();
        liveView.rebuildLivePreview(card);
      }
    });
  }
}

// Mutable API object: the cross-concern call seam and the test stub target.
export const results = {
  selectedBufferKeys,
  updateExportButtonState,
  showRecordingResults,
  rebuildResultsPreview,
  resultsLineHtml,
  resultsGroupHtml,
  summarizeResults,
  ensureResultsSummaryEl,
  hideResultsSummary,
  renderResultsSummary,
  fetchResults,
  closeLiveView,
  downloadLogs,
  copyLogsToClipboard,
  attachResults,
};
registerConcern("results", results);
