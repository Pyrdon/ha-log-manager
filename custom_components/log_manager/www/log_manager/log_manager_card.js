class LogManagerCard extends HTMLElement {
  // Audit-trail display policy. Backend keeps AUDIT_KEEP entries per logger
  // (see MAX_AUDIT in const.py); the panel shows the newest AUDIT_SHOW.
  static AUDIT_KEEP = 5;
  static AUDIT_SHOW = 3;

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._availableLoggers = [];
    this._uiBuilt = false;
    this._isAddSectionVisible = false;
    this._editingPath = null;
    this._counters = {};
    this._lastCounterFetch = 0;
    this._expandedLogger = null;
    this._deleteConfirmTarget = null;
    this._updateScheduled = false;
    this._prevRowStates = {};
    this._prevPanelHtml = {};
    // One-shot: forces the next panel rebuild even while a control inside it
    // holds focus, so a committed change repaints without a click-away.
    this._panelRefreshRequested = null;

    this._recordingState = null; // null | "recording" | "stopping" | "completed" | "results"
    this._recordingStartTime = 0;
    this._recordingLoggers = [];
    this._recordingLevelOverrides = {};
    // Levels changed to make a recording capture more verbose events; restored
    // when the session ends.
    this._recordingRestoreLevels = {};
    // Raise intents recorded at selection/profile-load time; applied on start.
    this._recordingRaiseIntents = {};
    // Explicit row selection, keyed by stable entry key (survives rebuilds).
    this._selectedKeys = new Set();
    this._selectionAnchorRow = null;
    this._dragSelectState = null;
    this._recordingBuffer = [];
    this._recordingDuration = 0;
    this._recordingLogCount = 0;
    this._recordingTimerInterval = null;
    this._recordingMaxDuration = 300;
    this._recordingCounts = {};
    this._recordingBackendCount = 0;
    this._liveViewOpen = false;
    this._livePaused = false;
    // Rows captured while the view is paused; replayed on resume.
    this._pausedEntries = [];
    this._liveLastId = 0;
    this._liveLastGroup = null;
    this._liveLastSingle = null;
    // Plain dedup keys: two distant runs of the same message share one
    // expansion flag, so expanding one expands both after a rebuild.
    this._expandedDedupKeys = new Set();
    this._resultsShown = false;
    this._liveDedupOverride = null;
    this._colWidths = this._loadColumnWidths();
    // True when the recording settings have diverged from the shown profile.
    this._profileDirty = false;
    this._modifiedBaseName = "";

    this._friendlyNameDirty = false;

    this._savedPath = sessionStorage.getItem("logManagerPath") || "";
    this._savedName = sessionStorage.getItem("logManagerName") || "";
  }

  _debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  _persistState() {
    if (this._pathInput) sessionStorage.setItem("logManagerPath", this._pathInput.value);
    if (this._friendlyNameInput) sessionStorage.setItem("logManagerName", this._friendlyNameInput.value);
  }

  _clearState() {
    if (this._pathInput) this._pathInput.value = "";
    if (this._friendlyNameInput) this._friendlyNameInput.value = "";
    this._editingPath = null;
    this._friendlyNameDirty = false;
    sessionStorage.removeItem("logManagerPath");
    sessionStorage.removeItem("logManagerName");
  }

  _deriveFriendlyName(path) {
    const lastSegment = (path.split(".").pop() || "").trim();
    if (!lastSegment) return "";
    return lastSegment.split("_").map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(" ");
  }

  _applyAutoFriendlyName(force = false) {
    if (this._friendlyNameDirty && !force) return;
    const path = this._pathInput.value.trim();
    if (!path) return;
    const derived = this._deriveFriendlyName(path);
    if (!derived) return;
    this._friendlyNameInput.value = derived;
    this._persistState();
    this._validateAddButton();
  }

  _fetchCounters() {
    if (!this._hass || !this._hass.connection) return;
    const now = Date.now();
    if (now - this._lastCounterFetch < 5000) return;
    this._lastCounterFetch = now;

    this._hass.connection.sendMessagePromise({ type: "log_manager/get_stats" }).then(res => {
      // Only re-render if counter data actually changed, to preserve hover tooltips.
      if (JSON.stringify(this._counters) !== JSON.stringify(res)) {
        this._counters = res;
        this._updateActiveList();
      }
    }).catch(() => {});
  }

  _renderCounterBadgeHtml(loggerName) {
    const stats = this._counters[loggerName];
    if (!stats) return "";

    const warningCount = stats.warning || 0;
    const errorCount = stats.error || 0;
    if (warningCount === 0 && errorCount === 0) return "";

    let html = "";
    if (warningCount > 0) {
      const title = `${warningCount} warning${warningCount !== 1 ? "s" : ""} — click to expand`;
      html += `<span class="counter-badge warning-badge" title="${this._escapeAttr(title)}" data-logger="${this._escapeAttr(loggerName)}">&#9888; ${warningCount}</span>`;
    }
    if (errorCount > 0) {
      const title = `${errorCount} error${errorCount !== 1 ? "s" : ""} — click to expand`;
      html += `<span class="counter-badge error-badge" title="${this._escapeAttr(title)}" data-logger="${this._escapeAttr(loggerName)}">&#10005; ${errorCount}</span>`;
    }
    return html;
  }

  _effectiveChipInfo(stateObj, currentLevel, isUnavailable) {
    if (isUnavailable || currentLevel !== "NOTSET") return null;
    const effectiveLevel = stateObj.attributes.effective_level;
    if (!effectiveLevel) return null;
    const effectiveSource = stateObj.attributes.effective_source;
    const sourceText = (!effectiveSource || effectiveSource === "root")
      ? `Effective level ${effectiveLevel} from the root logger`
      : `Effective level ${effectiveLevel} inherited from ${effectiveSource}`;
    return { effectiveLevel, sourceText };
  }

  _renderEffectiveChip(stateObj, currentLevel, isUnavailable) {
    const info = this._effectiveChipInfo(stateObj, currentLevel, isUnavailable);
    if (!info) return "";
    const colors = this._levelColors(info.effectiveLevel);
    return `<div class="effective-line" style="color: ${colors.color};" title="${this._escapeAttr(info.sourceText)}">Effective: <span class="effective-level" style="color: ${colors.color};">${this._escapeHtml(info.effectiveLevel)}</span></div>`;
  }

  _updateEffectiveChipInPlace(pathDiv, stateObj, currentLevel, isUnavailable) {
    const existing = pathDiv.querySelector(".effective-line");
    const html = this._renderEffectiveChip(stateObj, currentLevel, isUnavailable);
    if (!html) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      // Keep the raised chip (if any) as the last line in the path block.
      const raised = pathDiv.querySelector(".raised-line");
      if (raised) raised.insertAdjacentHTML("beforebegin", html);
      else pathDiv.insertAdjacentHTML("beforeend", html);
      return;
    }
    // Update the existing node in place so the tooltip hover timer survives,
    // following the counter-badge pattern.
    const fresh = document.createElement("div");
    fresh.innerHTML = html;
    const freshLine = fresh.firstChild;
    const levelSpan = existing.querySelector(".effective-level");
    const freshSpan = freshLine.querySelector(".effective-level");
    if (levelSpan && freshSpan) {
      levelSpan.textContent = freshSpan.textContent;
      levelSpan.setAttribute("style", freshSpan.getAttribute("style") || "");
    }
    // Refresh the container too: the "Effective:" text takes its colour from it.
    existing.setAttribute("style", freshLine.getAttribute("style") || "");
    existing.setAttribute("title", freshLine.getAttribute("title") || "");
  }

  // Update the "Raised to X" chip in place, or create/remove it.
  _updateRaisedChipInPlace(pathDiv, html) {
    const existing = pathDiv.querySelector(".raised-line");
    if (!html) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      pathDiv.insertAdjacentHTML("beforeend", html);
      return;
    }
    const fresh = document.createElement("div");
    fresh.innerHTML = html;
    const freshLine = fresh.firstChild;
    existing.textContent = freshLine.textContent;
    existing.setAttribute("title", freshLine.getAttribute("title") || "");
  }

  // Set or clear a title attribute only when it changes, preserving tooltips.
  _setSelectTitle(select, title) {
    if (!select) return;
    if (title) select.setAttribute("title", title);
    else select.removeAttribute("title");
  }

  _findEntityIdByLogger(loggerName) {
    if (!this._hass) return null;
    const eid = Object.keys(this._hass.states).find(id => {
      if (!id.startsWith("select.")) return false;
      return this._hass.states[id].attributes.logger_name === loggerName;
    });
    return eid || null;
  }

  _isGroupingEnabled() {
    return !this.config || this.config.group_by_prefix !== false;
  }

  _getCollapsedGroups() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem("log_manager_collapsed_groups") || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Corrupt JSON falls through to the empty default below.
    }
    return {};
  }

  _setGroupCollapsed(prefix, collapsed) {
    try {
      const map = this._getCollapsedGroups();
      if (collapsed) {
        map[prefix] = true;
      } else {
        delete map[prefix];
      }
      window.localStorage.setItem("log_manager_collapsed_groups", JSON.stringify(map));
    } catch {
      // Storage unavailable (private mode); collapse state just won't persist.
    }
  }

  // Build an ordered display model from managed logger paths.
  //
  // The tree is compressed (Patricia-style): a chain of single-child,
  // non-terminal segments is merged into one label, so ancestors only appear
  // where the hierarchy actually branches. Nodes are emitted pre-order as:
  //   { kind: "group", key, label, depth, ancestors, count }   branch header
  //   { kind: "row", logger, key, label, depth, ancestors, ... }  a logger
  _buildLoggerTree(names) {
    const root = { children: new Map(), terminal: false, path: "" };
    for (const name of names) {
      const segments = String(name).split(".");
      let node = root;
      let path = "";
      for (const segment of segments) {
        path = path ? `${path}.${segment}` : segment;
        let child = node.children.get(segment);
        if (!child) {
          child = { segment, path, children: new Map(), terminal: false };
          node.children.set(segment, child);
        }
        node = child;
      }
      node.terminal = true;
    }

    const countUnder = (node) => {
      let count = node.terminal ? 1 : 0;
      for (const child of node.children.values()) count += countUnder(child);
      return count;
    };

    const items = [];
    const emit = (node, depth, ancestors) => {
      // Merge a unary, non-terminal chain into this label.
      let label = node.segment;
      let current = node;
      while (!current.terminal && current.children.size === 1) {
        current = [...current.children.values()][0];
        label = `${label}.${current.segment}`;
      }
      const childAncestors = [...ancestors, current.path];
      if (current.terminal) {
        items.push({
          kind: "row",
          logger: current.path,
          key: current.path,
          label,
          depth,
          ancestors,
          collapsible: current.children.size > 0,
          count: current.children.size,
        });
      } else {
        items.push({
          kind: "group",
          key: current.path,
          label,
          depth,
          ancestors,
          count: countUnder(current),
        });
      }
      const children = [...current.children.values()].sort((a, b) =>
        a.segment.localeCompare(b.segment)
      );
      for (const child of children) {
        emit(child, depth + 1, childAncestors);
      }
    };

    // A namespace whose descendants are all leaves groups nothing at a deeper
    // level. When it is also the only root, its header adds no separation.
    const isFlat = (node) => {
      for (const child of node.children.values()) {
        if (!child.terminal || child.children.size > 0) return false;
      }
      return true;
    };
    const roots = [...root.children.values()].sort((a, b) =>
      a.segment.localeCompare(b.segment)
    );
    if (roots.length === 1 && !roots[0].terminal && isFlat(roots[0])) {
      const children = [...roots[0].children.values()].sort((a, b) =>
        a.segment.localeCompare(b.segment)
      );
      for (const child of children) emit(child, 0, []);
    } else {
      for (const child of roots) emit(child, 0, []);
    }
    return items;
  }

  _ensureGroupHeader(item) {
    let el = Array.from(this._activeList.children).find(
      e => e.classList && e.classList.contains("log-group-header") && e.dataset.group === item.key
    ) || null;
    const collapsed = !!this._getCollapsedGroups()[item.key];
    const chevron = collapsed ? "\u25B8" : "\u25BE";
    if (!el) {
      el = document.createElement("div");
      el.className = "log-group-header";
      el.dataset.group = item.key;
      el.title = "Toggle section";
      el.innerHTML = `<span class="log-group-chevron"></span><span class="log-group-name"></span><span class="log-group-count"></span>`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this._setGroupCollapsed(item.key, !this._getCollapsedGroups()[item.key]);
        this._updateActiveList();
      });
    }
    el.querySelector(".log-group-chevron").textContent = chevron;
    el.querySelector(".log-group-name").textContent = item.label;
    el.querySelector(".log-group-count").textContent = `(${item.count})`;
    return el;
  }

  _getAlertInfo(loggerName) {
    const eid = this._findEntityIdByLogger(loggerName);
    if (!eid) {
      return { threshold: 0, level: "ERROR", disabled: true, unavailable: true };
    }
    const stateObj = this._hass.states[eid];
    const unavailable = stateObj.state === "unavailable" || stateObj.state === "unknown";
    const threshold = stateObj.attributes.alert_threshold || 0;
    return {
      threshold,
      level: stateObj.attributes.alert_level || "ERROR",
      // Canonical disabled representation is threshold 0; surfaced as DISABLED.
      disabled: threshold === 0,
      unavailable,
    };
  }

  _getAuditEntries(loggerName) {
    const eid = this._findEntityIdByLogger(loggerName);
    if (!eid) return [];
    const audit = this._hass.states[eid].attributes.audit || [];
    return Array.isArray(audit)
      ? audit.slice(0, LogManagerCard.AUDIT_KEEP)
      : [];
  }

  // Compact signature of the newest audit entries. Used to detect history
  // changes without rebuilding DOM; the full history renders in the dialog.
  _auditTitle(loggerName) {
    const entries = this._getAuditEntries(loggerName);
    if (!entries || entries.length === 0) return "";
    const sourceLabels = { ui: "UI", core: "Home Assistant" };
    return entries.slice(0, LogManagerCard.AUDIT_SHOW).map(a => {
      const when = this._formatDateTime(a.ts);
      const who = sourceLabels[a.source] || a.source || "unknown";
      return `${a.old_level || "?"} \u2192 ${a.new_level || "?"} by ${who} at ${when}`;
    }).join("\n");
  }

  _auditSourceLabel(source) {
    return { ui: "UI", core: "Home Assistant" }[source] || source || "unknown";
  }

  // Table rows (When | Source | From | To) for the level-change history dialog.
  _historyRowsHtml(loggerName) {
    const entries = this._getAuditEntries(loggerName).slice(0, LogManagerCard.AUDIT_SHOW);
    if (entries.length === 0) {
      return `<tr><td colspan="4" style="color: var(--secondary-text-color); font-style: italic;">No level changes recorded.</td></tr>`;
    }
    return entries.map(a => {
      const when = this._formatDateTime(a.ts);
      return `<tr>
        <td>${this._escapeHtml(when)}</td>
        <td>${this._escapeHtml(this._auditSourceLabel(a.source))}</td>
        <td>${this._levelPillHtml(a.old_level || "?")}</td>
        <td>${this._levelPillHtml(a.new_level || "?")}</td>
      </tr>`;
    }).join("");
  }

  _openHistoryDialog(loggerName) {
    if (!this._historyDialog) return;
    this._historyLoggerPath = loggerName;
    if (this._historyLoggerName) {
      const { friendly, path } = this._loggerDisplay(loggerName);
      this._historyLoggerName.textContent = friendly === path ? path : `${friendly} (${path})`;
      this._historyLoggerName.title = path;
    }
    if (this._historyTableBody) this._historyTableBody.innerHTML = this._historyRowsHtml(loggerName);
    this._historyDialog.style.display = "flex";
    requestAnimationFrame(() => this._historyDialog.classList.add("visible"));
  }

  _renderLogPanelHtml(loggerName) {
    const stats = this._counters[loggerName] || {"warning": 0, "error": 0, "recent_logs": [], "levels": {}};

    const alertInfo = this._getAlertInfo(loggerName);
    const auditHistory = this._auditTitle(loggerName);

    const recentLogs = stats.recent_logs || [];
    const hasEntries = recentLogs.length > 0;
    let entriesHtml = "";
    if (recentLogs.length === 0) {
      entriesHtml = `<div class="log-entry-empty">No recent log entries.</div>`;
    } else {
      const levelChips = {
        "CRITICAL": ["C", "log-level-error"],
        "ERROR": ["E", "log-level-error"],
        "WARNING": ["W", "log-level-warning"],
        "INFO": ["I", "log-level-info"],
        "DEBUG": ["D", "log-level-debug"],
      };
      recentLogs.forEach((entry, index) => {
        const time = new Date(entry.timestamp * 1000).toLocaleTimeString(this._locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
        const chip = levelChips[entry.level] || [entry.level.charAt(0), "log-level-debug"];
        const colors = this._levelColors(entry.level);
        const msg = this._escapeHtml(entry.message);
        const src = entry.source ? this._escapeHtml(entry.source.split("/").pop()) : "";
        entriesHtml += `
          <div class="log-entry selectable-entry" data-entry-index="${index}" data-sel-keys="${this._escapeAttr(JSON.stringify([this._entryKey(entry)]))}" draggable="false" style="background: ${colors.rowBg}; border-left: 2px solid ${colors.color};" title="Click to select; Ctrl/Cmd-click to add to the selection">
            <span class="log-time">${time}</span>
            <span class="log-level ${chip[1]}">${chip[0]}</span>
            <span class="log-msg">${msg}</span>
            ${src ? `<span class="log-src">${src}</span>` : ""}
          </div>`;
      });
    }

    // Alert options: DISABLED plus the three severities, each tinted.
    const alertDisabled = alertInfo.disabled;
    const alertOptions = ["DISABLED", "WARNING", "ERROR", "CRITICAL"]
      .map(l => {
        const isDisabledOpt = l === "DISABLED";
        const selected = isDisabledOpt
          ? alertDisabled
          : (!alertDisabled && l === alertInfo.level);
        const color = isDisabledOpt
          ? "var(--secondary-text-color)"
          : this._levelColors(l).color;
        return `<option value="${l}" style="color: ${color};"${selected ? " selected" : ""}>${l}</option>`;
      }).join("");
    const alertColors = alertDisabled
      ? { color: "var(--secondary-text-color)" }
      : this._levelColors(alertInfo.level);
    const thresholdValue = alertDisabled ? 1 : Math.max(1, alertInfo.threshold);
    const thresholdHidden = alertDisabled ? ' style="display: none;"' : "";

    // The counting floor is fixed at WARNING; explain only when the logger's
    // own level is numerically stricter, since then its events never reach the
    // counters. Hidden when the effective level is unknown.
    const gateLevel = this._effectiveGateLevel(loggerName);
    const gateIdx = gateLevel ? this._levelIndex(gateLevel) : -1;
    const gateStricter = gateIdx > this._levelIndex("WARNING");
    const gateColor = gateStricter ? this._levelColors(gateLevel).color : "";
    const countWarningHtml = gateStricter
      ? `<div class="count-warning" title="The logger's own level discards these events before the counter handler runs.">This logger is set to <span style="color: ${gateColor}; font-weight: 600;">${this._escapeHtml(gateLevel)}</span>, so events below it never reach the counters.</div>`
      : "";

    return `
      <div class="log-panel">
        <div class="panel-controls-row">
          <label class="alert-row" title="Notify once when this many events at or above the chosen severity have been counted since the last reset. Choose DISABLED to turn the alert off; resetting the counters re-arms it.">
            Alert:
            <select class="alert-level-select" data-logger="${this._escapeAttr(loggerName)}" style="color: ${alertColors.color}; border-color: ${alertColors.color};"${alertInfo.unavailable ? " disabled" : ""}>${alertOptions}</select>
            <span>&ge;</span>
            <input class="alert-threshold-input" type="number" min="1" max="100000" step="1" value="${thresholdValue}" data-logger="${this._escapeAttr(loggerName)}"${thresholdHidden}${alertInfo.unavailable ? " disabled" : ""}>
          </label>
          <button type="button" class="icon-btn history-btn" data-logger="${this._escapeAttr(loggerName)}" title="${this._escapeAttr(auditHistory ? `Show level-change history\n\n${auditHistory}` : "Show level-change history")}">
            <ha-icon icon="mdi:history" style="--mdi-icon-size: 14px;"></ha-icon>
          </button>
        </div>
        ${countWarningHtml}
        <div class="log-entries">${entriesHtml}</div>
        ${hasEntries ? `<div class="selection-hint" title="Plain click selects one entry; Ctrl/Cmd-click or drag extends the selection.">Click to select &middot; Ctrl/Cmd-click or drag to select more</div>` : ""}
        <div class="log-disclaimer" title="This panel is fed by the counter badges, which capture events at WARNING and above once they reach the logger's own level. It does not affect or reflect recording.">This panel shows WARNING and above; events below the logger's own level never reach the counters.</div>
        ${hasEntries ? `<div style="display: flex; gap: 8px; margin-top: 8px;">
          <button class="reset-btn" data-logger="${this._escapeAttr(loggerName)}" title="Clears this logger's captured entries and counts, and re-arms its alert.">
            <ha-icon icon="mdi:refresh" style="--mdi-icon-size: 14px;"></ha-icon>
            Clear
          </button>
          <button class="copy-panel-btn" data-logger="${this._escapeAttr(loggerName)}" title="Copy the selected entries, or all captured entries when none are selected">
            <ha-icon icon="mdi:content-copy" style="--mdi-icon-size: 14px;"></ha-icon>
            Copy
          </button>
        </div>` : ""}
      </div>`;
  }

  _escapeAttr(str) {
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  _escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  _levelColors(level) {
    const map = {
      "DEBUG":     { bg: "rgba(3, 169, 244, 0.15)", color: "#03a9f4", rowBg: "rgba(3, 169, 244, 0.08)" },
      "INFO":      { bg: "rgba(76, 175, 80, 0.15)",  color: "#4caf50", rowBg: "rgba(76, 175, 80, 0.08)" },
      "WARNING":   { bg: "rgba(255, 152, 0, 0.15)",  color: "#ff9800", rowBg: "rgba(255, 152, 0, 0.08)" },
      "ERROR":     { bg: "rgba(244, 67, 54, 0.15)",  color: "#f44336", rowBg: "rgba(244, 67, 54, 0.08)" },
      "CRITICAL":  { bg: "rgba(156, 39, 176, 0.15)", color: "#9c27b0", rowBg: "rgba(156, 39, 176, 0.08)" },
      "NOTSET":    { bg: "transparent",               color: "var(--primary-text-color)", rowBg: "rgba(var(--rgb-primary-text-color), 0.03)" },
    };
    return map[level] || map["NOTSET"];
  }

  // Toggle the expand panel for a logger. Closes the add/edit section if open.
  _toggleExpand(loggerName) {
    if (this._expandedLogger === loggerName) {
      this._expandedLogger = null;
    } else {
      this._expandedLogger = loggerName;
      // Close the add/edit section to avoid two panels open at once.
      if (this._isAddSectionVisible) {
        this._closeAddSection();
      }
    }
    this._updateActiveList();
  }

  // Close the add/edit section without animation helpers.
  _closeAddSection() {
    this._isAddSectionVisible = false;
    this._editingPath = null;
    this._addSectionWrapper.style.overflow = "hidden";
    this._addSectionWrapper.classList.remove("visible");
    this._toggleIcon.setAttribute("icon", "mdi:plus");
    this._toggleText.innerText = "Add logger";
    this._restoreAddSectionPosition();
    this._clearState();
  }

  // Default position: between the logger list and the action buttons.
  _restoreAddSectionPosition() {
    const card = this.shadowRoot.querySelector("ha-card");
    const actions = card && card.querySelector(".card-actions");
    if (card && actions && this._addSectionWrapper.parentElement !== card) {
      card.insertBefore(this._addSectionWrapper, actions);
    } else if (card && actions && this._addSectionWrapper.nextElementSibling !== actions) {
      card.insertBefore(this._addSectionWrapper, actions);
    }
  }

  // Edit position: directly beneath the row being edited.
  _insertAddSectionAfter(row) {
    if (!row || !row.parentElement) return;
    // Re-inserting to the same position would tear the node out and back in,
    // restarting its open animation. Skip when it is already placed correctly.
    if (this._addSectionWrapper.parentElement === row.parentElement
        && this._addSectionWrapper.previousElementSibling === row) {
      return;
    }
    row.parentElement.insertBefore(this._addSectionWrapper, row.nextSibling);
  }

  // Open the add/edit section. Closes any expanded log panel.
  _openAddSection(focus = "path") {
    if (this._expandedLogger) {
      this._expandedLogger = null;
      // Repaint now so the collapsed panel disappears with the section opening
      // rather than lingering until the next unrelated render.
      this._updateActiveList();
    }
    this._isAddSectionVisible = true;
    this._addSectionWrapper.classList.add("visible");
    this._toggleIcon.setAttribute("icon", "mdi:chevron-up");
    this._toggleText.innerText = "Cancel";
    setTimeout(() => {
      if (this._isAddSectionVisible) {
        this._addSectionWrapper.style.overflow = "visible";
        const target = focus === "name" ? this._friendlyNameInput : this._pathInput;
        target.focus();
        target.select();
      }
    }, 300);
    this._renderDropdown();
  }

  _attachBadgeHandlers(row) {
    row.querySelectorAll(".counter-badge").forEach(badge => {
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        const loggerName = badge.dataset.logger;
        if (!loggerName) return;
        this._toggleExpand(loggerName);
      });
    });
  }

  _attachResetHandler(row) {
    const btn = row.querySelector(".reset-btn");
    if (!btn) return;
    // Remove stale listeners to prevent duplicate handler accumulation.
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener("click", (e) => {
      e.stopPropagation();
      const loggerName = clone.dataset.logger;
      if (!loggerName) return;
      this._hass.callService("log_manager", "reset_counters", {
        logger_name: loggerName
      });
      // Clear counts and captured entries but keep the panel open.
      if (this._counters[loggerName]) {
        this._counters[loggerName] = {"warning": 0, "error": 0, "last_warning": "", "last_error": "", "recent_logs": [], "levels": {}};
      }
      this._updateActiveList();
    });
  }

  _attachAlertHandler(row) {
    const send = () => {
      const sel = row.querySelector(".alert-level-select");
      const num = row.querySelector(".alert-threshold-input");
      if (!sel || !num) return;
      const loggerName = sel.dataset.logger;
      if (!loggerName) return;
      // DISABLED is canonical threshold 0; a severity requires at least one.
      const disabled = sel.value === "DISABLED";
      const count = disabled ? 0 : Math.max(1, parseInt(num.value, 10) || 1);
      // Repaint once the committed value lands, without waiting for a blur.
      this._panelRefreshRequested = loggerName;
      this._hass.callService("log_manager", "set_alert_threshold", {
        logger_name: loggerName,
        events: count,
        level: disabled ? "ERROR" : sel.value,
      });
    };
    // Remove stale listeners to prevent duplicate handler accumulation.
    row.querySelectorAll(".alert-level-select, .alert-threshold-input").forEach(el => {
      const clone = el.cloneNode(true);
      el.replaceWith(clone);
    });
    const sel = row.querySelector(".alert-level-select");
    const num = row.querySelector(".alert-threshold-input");
    if (sel) {
      sel.addEventListener("change", send);
      sel.addEventListener("click", (e) => e.stopPropagation());
    }
    if (num) {
      num.addEventListener("change", send);
      num.addEventListener("click", (e) => e.stopPropagation());
      // Commit on Enter so the field does not need a click-away.
      num.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          send();
        }
      });
    }
  }

  _attachHistoryHandler(row) {
    const btn = row.querySelector(".history-btn");
    if (!btn) return;
    // Remove stale listeners to prevent duplicate handler accumulation.
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener("click", (e) => {
      e.stopPropagation();
      const loggerName = clone.dataset.logger;
      if (loggerName) this._openHistoryDialog(loggerName);
    });
  }

  // --- Explicit row selection -------------------------------------------------

  // Stable identity for an entry across rebuilds. Includes the timestamp so
  // consecutive identical entries keep distinct selection keys.
  _entryKey(entry) {
    return [entry.timestamp, entry.level, entry.logger, entry.message, entry.source || ""].join("|");
  }

  // Keys for a dedup run: selecting a group selects its whole run.
  _runKeys(run) {
    return (run.times || []).map(ts => this._entryKey({
      timestamp: ts,
      level: run.level,
      logger: run.logger,
      message: run.message,
      source: run.source,
    }));
  }

  _rowSelectionKeys(el) {
    const raw = el && el.dataset ? el.dataset.selKeys : null;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  _orderedSelectableRows(container) {
    if (!container || typeof container.querySelectorAll !== "function") return [];
    return Array.from(container.querySelectorAll(".selectable-entry"))
      .filter(el => el.style.display !== "none");
  }

  // Re-apply the selected class from the stored key set after any rebuild.
  _refreshSelection(container) {
    if (!container || typeof container.querySelectorAll !== "function") return;
    container.querySelectorAll(".selectable-entry").forEach(el => {
      const keys = this._rowSelectionKeys(el);
      const selected = !!keys && keys.length > 0 && keys.every(k => this._selectedKeys.has(k));
      el.classList.toggle("selected", selected);
    });
    if (container === this._livePreview) this._updateExportButtonState();
  }

  _clearSelection(container) {
    this._selectedKeys.clear();
    this._selectionAnchorRow = null;
    if (container) this._refreshSelection(container);
  }

  _applySelectionRange(container, fromRow, toRow) {
    const rows = this._orderedSelectableRows(container);
    const a = rows.indexOf(fromRow);
    const b = rows.indexOf(toRow);
    if (a === -1 || b === -1) return;
    const [from, to] = a <= b ? [a, b] : [b, a];
    for (let i = from; i <= to; i++) {
      const keys = this._rowSelectionKeys(rows[i]);
      if (keys) keys.forEach(k => this._selectedKeys.add(k));
    }
    this._refreshSelection(container);
  }

  _handleSelectionClick(container, target, e) {
    const row = target && target.closest ? target.closest(".selectable-entry") : null;
    if (!row) {
      // Clicking empty space or the header clears the selection.
      if (target === container ||
          (target.classList && (
            target.classList.contains("log-entries") ||
            target.classList.contains("log-preview") ||
            target.classList.contains("log-preview-header")
          ))) {
        this._clearSelection(container);
      }
      return;
    }
    const keys = this._rowSelectionKeys(row);
    if (!keys || keys.length === 0) return;
    if (e.shiftKey && this._selectionAnchorRow && container.contains(this._selectionAnchorRow)) {
      this._applySelectionRange(container, this._selectionAnchorRow, row);
    } else if (e.ctrlKey || e.metaKey) {
      const allSelected = keys.every(k => this._selectedKeys.has(k));
      keys.forEach(k => {
        if (allSelected) this._selectedKeys.delete(k);
        else this._selectedKeys.add(k);
      });
      this._selectionAnchorRow = row;
      this._refreshSelection(container);
    } else {
      this._selectedKeys.clear();
      keys.forEach(k => this._selectedKeys.add(k));
      this._selectionAnchorRow = row;
      this._refreshSelection(container);
    }
  }

  // Press-and-drag across rows extends the selection; native text selection and
  // the drag image are suppressed so the explicit model is the only interaction.
  _onSelectionMouseDown(container, e) {
    if (e.button !== undefined && e.button !== 0) return;
    const row = e.target && e.target.closest ? e.target.closest(".selectable-entry") : null;
    if (!row) {
      this._handleSelectionClick(container, e.target, e);
      return;
    }
    if (typeof e.preventDefault === "function") e.preventDefault();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      this._handleSelectionClick(container, e.target, e);
      return;
    }
    this._handleSelectionClick(container, e.target, e);
    this._dragSelectState = { container, anchorRow: row };
    const onMove = (ev) => {
      const state = this._dragSelectState;
      if (!state) return;
      const over = ev.target && ev.target.closest ? ev.target.closest(".selectable-entry") : null;
      if (!over || over === state.anchorRow) return;
      this._applySelectionRange(state.container, state.anchorRow, over);
    };
    const onUp = () => {
      this._dragSelectState = null;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

  _attachCopyPanelHandler(row) {
    const btn = row.querySelector(".copy-panel-btn");
    if (!btn) return;
    // Remove stale listeners to prevent duplicate handler accumulation.
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener("click", (e) => {
      e.stopPropagation();
      const loggerName = clone.dataset.logger;
      if (!loggerName) return;
      const stats = this._counters[loggerName];
      if (!stats) return;
      const all = stats.recent_logs || [];
      if (all.length === 0) return;
      const selected = all.filter(entry => this._selectedKeys.has(this._entryKey(entry)));
      const logs = selected.length > 0 ? selected : all;
      const text = logs.map(entry => {
        const time = this._formatDateTime(entry.timestamp);
        const level = entry.level.padEnd(8);
        const src = entry.source ? ` (${entry.source})` : "";
        return `[${time}] ${level} ${entry.logger}  ${entry.message}${src}`;
      }).join("\n") + "\n";
      navigator.clipboard.writeText(text).then(() => {
        const original = clone.textContent;
        clone.textContent = "Copied!";
        setTimeout(() => { clone.textContent = original; }, 2000);
      }).catch(err => console.error("Failed to copy:", err));
    });
  }

  // Update badge elements in-place without destroying the DOM, so title tooltips survive.
  _updateBadgesInPlace(row, loggerName) {
    const stats = this._counters[loggerName];
    const warningCount = stats ? (stats.warning || 0) : 0;
    const errorCount = stats ? (stats.error || 0) : 0;

    let badgesContainer = row.querySelector(".counter-badges");

    const upsertBadge = (cls, count, icon, label) => {
      if (count > 0) {
        const title = `${count} ${label}${count !== 1 ? "s" : ""} — click to expand`;
        let badge = badgesContainer ? badgesContainer.querySelector(`.${cls}`) : null;
        if (badge) {
          // Update existing badge in-place — DOM stays alive, tooltip survives.
          badge.textContent = `${icon} ${count}`;
          badge.setAttribute("title", title);
        } else {
          // Create badge element.
          if (!badgesContainer) {
            badgesContainer = document.createElement("div");
            badgesContainer.className = "counter-badges";
            const wrapper = row.querySelector(".log-controls-wrapper");
            wrapper.insertBefore(badgesContainer, wrapper.querySelector(".log-controls"));
          }
          badge = document.createElement("span");
          badge.className = `counter-badge ${cls}`;
          badge.title = title;
          badge.dataset.logger = loggerName;
          badge.textContent = `${icon} ${count}`;
          badge.addEventListener("click", (e) => {
            e.stopPropagation();
            this._toggleExpand(loggerName);
          });
          badgesContainer.appendChild(badge);
        }
      }
    };

    upsertBadge("warning-badge", warningCount, "\u26A0", "warning");
    upsertBadge("error-badge", errorCount, "\u2715", "error");

    // Remove badges that should no longer exist.
    if (badgesContainer) {
      if (warningCount === 0) {
        const el = badgesContainer.querySelector(".warning-badge");
        if (el) el.remove();
      }
      if (errorCount === 0) {
        const el = badgesContainer.querySelector(".error-badge");
        if (el) el.remove();
      }
      // Remove container if empty.
      if (badgesContainer.children.length === 0) {
        badgesContainer.remove();
      }
    }
  }

  // Show a styled delete confirmation dialog instead of browser confirm().
  _showDeleteConfirm(message, onConfirm, title = "Remove logger", confirmLabel = "Remove", onCancel = null, htmlMessage = false) {
    this._deleteConfirmTarget = { onConfirm, onCancel };
    this._deleteDialog.querySelector(".delete-dialog-title").textContent = title;
    const msgEl = this._deleteDialog.querySelector(".delete-dialog-message");
    // Only pre-escaped HTML is passed here; plain text remains the safe default.
    if (htmlMessage) msgEl.innerHTML = message;
    else msgEl.textContent = message;
    this.shadowRoot.getElementById("delete-confirm-btn").textContent = confirmLabel;
    this._deleteDialog.style.display = "flex";
  }

  set hass(hass) {
    this._hass = hass;

    if (!this._uiBuilt) {
      this._buildUI();
      this._fetchLoggers();
      this._uiBuilt = true;
      this._checkExistingRecording();
    }

    this._scheduleUpdate();

    this._fetchCounters();
  }

  // Debounce a list/recording repaint via rAF so redundant DOM work within one
  // frame collapses into a single pass.
  _scheduleUpdate() {
    if (this._updateScheduled) return;
    this._updateScheduled = true;
    requestAnimationFrame(() => {
      try {
        this._updateActiveList();
        this._updateRecordingUI();
      }
      finally { this._updateScheduled = false; }
    });
  }

  _buildUI() {
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px 16px 8px 16px; display: flex; flex-direction: column; }
        .header { margin-bottom: 12px; }
        .section-title { font-size: 18px; font-weight: 500; margin: 0; }
        .header { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
        .set-all-row {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-left: auto;
          font-size: 12px;
          color: var(--secondary-text-color);
        }
        select.set-all-level {
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          font-size: 12px;
          cursor: pointer;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }
        button.set-all-apply {
          padding: 3px 10px;
          font-size: 12px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: none;
          color: var(--secondary-text-color);
          cursor: pointer;
        }
        button.set-all-apply:hover:not(:disabled) {
          color: var(--primary-text-color);
          border-color: var(--primary-text-color);
        }
        button.set-all-apply:disabled { opacity: 0.5; cursor: default; }
        .active-list { margin-bottom: 0; display: flex; flex-direction: column; gap: 8px; }

        .log-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          padding: 10px 12px;
          border-radius: 8px;
          border: 1px solid var(--divider-color);
          transition: box-shadow 0.2s ease, border-color 0.2s ease;
          cursor: pointer;
        }

        .log-row:hover {
          border-color: rgba(var(--rgb-primary-text-color), 0.15);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        }

        .log-group-header {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          font-weight: 500;
          color: var(--secondary-text-color);
          cursor: pointer;
          user-select: none;
          padding: 4px 10px;
          border-radius: 6px;
          background: rgba(var(--rgb-primary-text-color), 0.04);
          transition: background 0.15s ease, color 0.15s ease;
        }
        .log-group-header:hover {
          background: rgba(var(--rgb-primary-text-color), 0.09);
          color: var(--primary-text-color);
        }
        .log-group-name { font-weight: 600; letter-spacing: 0.2px; }
        .log-group-count { opacity: 0.75; }
        .log-group-chevron { display: inline-block; width: 16px; }
        .row-group-chevron {
          background: none;
          border: none;
          color: var(--secondary-text-color);
          cursor: pointer;
          padding: 0 4px 0 0;
          font-size: 10px;
          line-height: 1;
        }
        .row-group-chevron:hover { color: var(--primary-text-color); }

        .action-btn {
          opacity: 0.25;
          transition: opacity 0.2s ease-in-out;
        }

        .log-row:hover .action-btn {
          opacity: 1;
        }

        .log-name {
          flex: 1 1 0;
          font-size: 14px;
          word-break: break-word;
          margin-right: 12px;
          line-height: 1.3;
          min-width: 120px;
          cursor: pointer;
        }

        .log-name.unavailable { opacity: 0.6; color: var(--secondary-text-color); }

        .log-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

        .counter-badges { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .log-controls-wrapper { display: flex; align-items: center; gap: 8px; flex-shrink: 0; min-width: 0; }

        .counter-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 24px;
          height: 22px;
          border-radius: 11px;
          font-size: 11px;
          font-weight: 600;
          padding: 0 7px;
          cursor: pointer;
          transition: filter 0.15s ease, transform 0.15s ease;
          user-select: none;
        }

        .counter-badge:hover {
          filter: brightness(1.25);
          transform: scale(1.05);
        }

        .counter-badge:active {
          transform: scale(0.97);
        }

        .counter-badge.warning-badge {
          background: rgba(255, 152, 0, 0.18);
          color: #ff9800;
        }

        .counter-badge.error-badge {
          background: rgba(244, 67, 54, 0.18);
          color: var(--error-color);
        }

        .counter-badge.recording-count-badge {
          background: rgba(76, 175, 80, 0.18);
          color: #4caf50;
        }

        .log-panel {
          width: 100%;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--divider-color);
          word-break: normal;
          overflow-wrap: break-word;
        }

        .log-entries {
          display: flex;
          flex-direction: column;
          gap: 4px;
          max-height: 200px;
          overflow-y: auto;
          user-select: none;
          -webkit-user-select: none;
        }

        .log-entry {
          display: flex;
          align-items: baseline;
          gap: 6px;
          font-size: 12px;
          line-height: 1.4;
          padding: 4px 6px;
          border-radius: 4px;
          cursor: pointer;
          word-break: normal;
          overflow-wrap: break-word;
          user-select: none;
          -webkit-user-select: none;
          -webkit-user-drag: none;
        }

        .log-entry:hover {
          filter: brightness(1.12);
        }

        .log-entry.copied {
          outline: 1px solid var(--primary-color);
        }

        .log-entry-empty {
          font-size: 12px;
          color: var(--secondary-text-color);
          font-style: italic;
          padding: 4px 0;
        }

        .log-disclaimer {
          font-size: 11px;
          color: var(--secondary-text-color);
          font-style: italic;
          margin-top: 6px;
          opacity: 0.8;
        }

        /* Explains why a verbose count level captures nothing. */
        .count-warning {
          font-size: 11px;
          color: #ff9800;
          line-height: 1.35;
          margin-bottom: 6px;
        }

        /* Makes the modifier-key multi-select model discoverable. */
        .selection-hint {
          font-size: 11px;
          color: var(--secondary-text-color);
          opacity: 0.8;
          margin-top: 6px;
        }

        .log-time {
          color: var(--secondary-text-color);
          font-family: monospace;
          font-size: 11px;
          flex-shrink: 0;
        }

        .log-level {
          font-size: 10px;
          font-weight: 600;
          padding: 1px 5px;
          border-radius: 3px;
          flex-shrink: 0;
          text-transform: uppercase;
        }

        .log-level-warning {
          background: rgba(255, 152, 0, 0.18);
          color: #ff9800;
        }

        .log-level-error {
          background: rgba(244, 67, 54, 0.18);
          color: var(--error-color);
        }

        .log-level-info {
          background: rgba(76, 175, 80, 0.18);
          color: #4caf50;
        }

        .log-level-debug {
          background: rgba(3, 169, 244, 0.18);
          color: #03a9f4;
        }

        /* Per-logger controls share one wrapping row. */
        .panel-controls-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 12px;
          margin-bottom: 6px;
          min-height: 22px;
        }

        .alert-row {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--secondary-text-color);
        }

        select.alert-level-select,
        input.alert-threshold-input {
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          font-size: 11px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }

        select.alert-level-select {
          cursor: pointer;
        }

        input.alert-threshold-input {
          width: 72px;
          padding-right: 0;
        }

        select.alert-level-select:disabled,
        input.alert-threshold-input:disabled {
          opacity: 0.5;
          cursor: default;
        }

        .audit-line {
          font-size: 11px;
          color: var(--secondary-text-color);
          margin-bottom: 6px;
        }

        .audit-label {
          font-weight: 600;
        }

        .log-msg {
          color: var(--primary-text-color);
          overflow-wrap: break-word;
          word-break: normal;
          flex: 1 1 0;
          min-width: 0;
        }

        .log-src {
          color: var(--secondary-text-color);
          font-size: 10px;
          font-family: monospace;
          flex-shrink: 0;
        }

        .reset-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-top: 8px;
          padding: 4px 10px;
          font-size: 12px;
          background: none;
          color: var(--secondary-text-color);
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          cursor: pointer;
          transition: color 0.2s, border-color 0.2s;
        }

        .reset-btn:hover {
          color: var(--primary-text-color);
          border-color: var(--primary-text-color);
        }

        .reset-btn:disabled {
          opacity: 0.7;
          color: var(--secondary-text-color);
          border-color: var(--divider-color);
          cursor: default;
        }

        .reset-btn:disabled:hover {
          color: var(--secondary-text-color);
          border-color: var(--divider-color);
        }

        .copy-panel-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-top: 8px;
          padding: 4px 10px;
          font-size: 12px;
          background: none;
          color: var(--secondary-text-color);
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          cursor: pointer;
          transition: color 0.2s, border-color 0.2s;
        }

        .copy-panel-btn:hover:not(:disabled) {
          color: var(--primary-text-color);
          border-color: var(--primary-text-color);
        }

        .copy-panel-btn:disabled {
          opacity: 0.7;
          cursor: default;
        }

select.level-select {
          padding: 4px 8px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          font-size: 13px;
          cursor: pointer;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }

        select.level-select:hover {
          border-color: rgba(var(--rgb-primary-text-color), 0.3);
        }

        .add-section-wrapper {
          max-height: 0;
          opacity: 0;
          overflow: hidden;
          transition: max-height 0.3s ease-in-out, opacity 0.3s ease-in-out;
          margin: 0;
        }

        .add-section-wrapper.visible {
          max-height: 500px;
          opacity: 1;
          margin: 8px 0;
        }

        .add-section {
          background: rgba(var(--rgb-primary-text-color), 0.03);
          padding: 16px;
          border-radius: 8px;
          border: 1px solid var(--divider-color);
        }

        .add-section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .add-section-title {
          font-weight: 500;
          font-size: 14px;
          color: var(--secondary-text-color);
        }

        .field-label {
          display: block;
          font-size: 12px;
          font-weight: 500;
          color: var(--secondary-text-color);
          margin-bottom: 4px;
          margin-top: 12px;
        }

        .input-wrapper { position: relative; margin-bottom: 12px; margin-top: 0; }

        input[type="text"] {
          width: calc(100% - 18px);
          padding: 8px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-family: inherit;
        }

        .options-list {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          max-height: 200px;
          overflow-y: auto;
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
          border-top: none;
          border-radius: 0 0 4px 4px;
          z-index: 999;
          display: none;
          box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        }

        .option-item {
          padding: 4px 8px;
          cursor: pointer;
          color: var(--primary-text-color);
          font-size: 13px;
          word-break: break-all;
        }

        .option-item:hover { background: rgba(var(--rgb-primary-text-color), 0.05); }
        /* Highlight marks a curated namespace without recolouring the label,
           so fuzzy-match tinting stays readable on highlighted rows. */
        .option-item.highlight { font-weight: bold; background: rgba(var(--rgb-primary-color), 0.06); }
        .fuzzy-hit {
          font-weight: 700;
          color: var(--primary-color);
          background: rgba(var(--rgb-primary-color), 0.18);
          text-decoration: underline;
          border-radius: 2px;
        }
        .option-star { color: var(--primary-color); }

        .friendly-input { margin-bottom: 0; }

        button {
          padding: 8px 16px;
          background: var(--primary-color);
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 500;
        }

        button:disabled { background: var(--disabled-text-color); cursor: not-allowed; }

        .icon-btn {
          background: none;
          color: var(--error-color);
          cursor: pointer;
          padding: 4px;
          display: flex;
          align-items: center;
          border: none;
          transition: opacity 0.2s, color 0.2s;
        }

        .icon-btn:hover { opacity: 0.8; }
        .edit-btn { color: var(--primary-text-color); }
        .edit-btn:hover { color: var(--primary-color); }
        /* History is an informational action, not a destructive one: keep it
           off the error colour the shared icon-btn rule applies. */
        .history-btn { color: var(--secondary-text-color); }
        .history-btn:hover { color: var(--primary-color); }

        .card-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-top: 1px solid var(--divider-color);
          padding-top: 8px;
          margin-top: 12px;
        }

        .toggle-add-btn {
          background: none;
          color: var(--secondary-text-color);
          padding: 8px;
          display: flex;
          align-items: center;
          gap: 8px;
          border-radius: 4px;
          transition: background 0.2s;
          border: none;
          cursor: pointer;
          width: auto;
        }

        .toggle-add-btn:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
          color: var(--primary-text-color);
        }

        /* Styled delete confirmation dialog overlay. */
        .delete-dialog-overlay {
          display: none;
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 1000000001;
          align-items: center;
          justify-content: center;
        }

        .delete-dialog-box {
          background: var(--card-background-color);
          border-radius: 12px;
          padding: 24px;
          max-width: 400px;
          width: 90%;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }

        .delete-dialog-title {
          font-size: 16px;
          font-weight: 500;
          margin-bottom: 8px;
        }

        .delete-dialog-message {
          font-size: 14px;
          color: var(--secondary-text-color);
          margin-bottom: 20px;
        }

        .delete-dialog-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }

        .delete-dialog-actions button {
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
        }

        .btn-cancel {
          background: none;
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
        }

        .btn-cancel:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
        }

        .btn-danger {
          background: var(--error-color);
          color: white;
          border: none;
        }

        .btn-danger:hover {
          filter: brightness(1.1);
        }

        /* Recording UI styles */
        .recording-active {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: var(--error-color);
          font-weight: 500;
        }

        .recording-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--error-color);
          animation: recording-pulse 1.5s ease-in-out infinite;
        }

        @keyframes recording-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.7); }
        }

        .recording-timer {
          font-family: monospace;
          font-size: 14px;
        }

        .recording-tag {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--error-color);
          color: white;
          font-size: 10px;
          font-weight: 700;
          margin-right: 4px;
          animation: recording-pulse 1.5s ease-in-out infinite;
          flex-shrink: 0;
          vertical-align: middle;
        }

        .pinned-tag {
          display: inline-flex;
          align-items: center;
          padding: 1px 7px;
          border-radius: 9px;
          border: 1px solid var(--divider-color);
          color: var(--secondary-text-color);
          font-size: 10px;
          font-weight: 600;
          margin-right: 4px;
          flex-shrink: 0;
          vertical-align: middle;
        }

        .effective-line {
          font-size: 11px;
          color: var(--secondary-text-color);
          margin-top: 2px;
        }

        .raised-line {
          font-size: 11px;
          color: #ff9800;
          margin-top: 2px;
          font-weight: 600;
        }

        .btn-record {
          color: var(--error-color) !important;
        }

        .btn-record:hover {
          background: rgba(244, 67, 54, 0.08) !important;
        }

        .btn-view-recording {
          color: var(--primary-color) !important;
          font-weight: 600;
        }

        .btn-view-recording:hover {
          background: rgba(var(--rgb-primary-color), 0.08) !important;
        }

        .context-menu {
          position: fixed;
          z-index: 1000000000;
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
          padding: 4px;
          min-width: 160px;
        }

        .context-menu button {
          display: block;
          width: 100%;
          text-align: left;
          background: none;
          border: none;
          color: var(--primary-text-color);
          padding: 6px 10px;
          font-size: 13px;
          border-radius: 4px;
          cursor: pointer;
        }

        .context-menu button:hover:not(:disabled) {
          background: rgba(var(--rgb-primary-text-color), 0.08);
        }

        .context-menu button:disabled {
          opacity: 0.5;
          cursor: default;
        }

        .dialog-overlay {
          display: none;
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 999999999;
          align-items: center;
          justify-content: center;
        }

        .dialog-overlay.visible {
          display: flex;
        }

        .dialog-box {
          background: var(--card-background-color);
          border-radius: 12px;
          padding: 24px;
          max-width: 400px;
          width: 90%;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }

        .dialog-box-wide {
          max-width: 900px;
          max-height: 85vh;
          overflow-y: auto;
        }

        /* Recording setup needs room for exclusions without a cramped scrollbar. */
        .dialog-box.recording-setup-box {
          max-width: 580px;
          max-height: 85vh;
          overflow-y: auto;
        }

        .history-dialog-box {
          max-width: 520px;
          max-height: 85vh;
          overflow-y: auto;
        }

        .history-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          margin-top: 8px;
        }

        .history-table th,
        .history-table td {
          text-align: left;
          padding: 4px 8px;
          border-bottom: 1px solid var(--divider-color);
        }

        .history-table th {
          color: var(--secondary-text-color);
          font-weight: 600;
        }

        .dialog-title {
          font-size: 16px;
          font-weight: 500;
          margin-bottom: 8px;
        }

        .dialog-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 16px;
        }

        .dialog-actions button {
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
        }

        .btn-primary {
          background: var(--primary-color);
          color: white;
          border: none;
        }

        .btn-primary:hover {
          filter: brightness(1.1);
        }

        .btn-primary:disabled {
          background: var(--disabled-text-color);
          cursor: not-allowed;
          filter: none;
        }

        .btn-secondary {
          background: none;
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
        }

        .btn-secondary:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
        }

        .btn-secondary.paused {
          color: #ff9800;
          border-color: #ff9800;
        }

        .btn-secondary:disabled,
        .btn-secondary:disabled:hover {
          opacity: 0.5;
          cursor: not-allowed;
          background: none;
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
        }

        .logger-checklist {
          max-height: 380px;
          overflow-y: auto;
          margin: 12px 0;
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          padding: 4px;
        }

        .profile-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 8px;
          font-size: 13px;
        }

        .profile-label {
          color: var(--secondary-text-color);
          flex-shrink: 0;
        }

        #recording-profile-select {
          flex: 1;
          min-width: 0;
          padding: 4px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-size: 13px;
        }

        .profile-btn {
          padding: 4px 10px;
          font-size: 12px;
          flex-shrink: 0;
        }

        .dedup-row {
          display: flex;
          align-items: center;
          gap: 6px;
          margin: 8px 0;
          font-size: 13px;
          color: var(--secondary-text-color);
        }

        .profile-save-row {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }

        #recording-profile-name {
          flex: 1;
          min-width: 0;
          padding: 4px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-size: 13px;
        }

        .checklist-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          font-size: 13px;
          border-radius: 4px;
          cursor: pointer;
        }

        .checklist-item:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
        }

        .checklist-item input[type="checkbox"] {
          margin: 0;
          cursor: pointer;
        }

        .checklist-item .logger-label {
          flex: 1;
          word-break: break-all;
          line-height: 1.3;
        }

        .checklist-item .logger-level {
          font-size: 11px;
          opacity: 0.7;
          flex-shrink: 0;
        }

        .recording-level-select {
          font-size: 11px;
          padding: 2px 4px;
          border-radius: 3px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          flex-shrink: 0;
          max-width: 90px;
        }

        .recording-level-select:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .checklist-item {
          flex-wrap: wrap;
        }

        .exclude-toggle {
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 3px;
          border: 1px solid var(--divider-color);
          background: none;
          color: var(--secondary-text-color);
          cursor: pointer;
          flex-shrink: 0;
        }

        .exclude-toggle:hover {
          color: var(--primary-text-color);
          border-color: var(--primary-text-color);
        }

        .exclude-area {
          flex-basis: 100%;
          margin-top: 4px;
          padding-left: 26px;
        }

        .exclude-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-bottom: 4px;
        }

        .exclude-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          padding: 1px 4px 1px 8px;
          border-radius: 10px;
          background: rgba(var(--rgb-primary-text-color), 0.08);
          color: var(--primary-text-color);
        }

        .exclude-chip-remove {
          border: none;
          background: none;
          color: var(--secondary-text-color);
          cursor: pointer;
          font-size: 11px;
          padding: 0 2px;
        }

        .exclude-chip-remove:hover {
          color: var(--error-color);
        }

        .exclude-input-wrapper { position: relative; }

        .exclude-options {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          z-index: 10;
        }

        .exclude-input {
          font-size: 12px;
          padding: 3px 6px;
          border-radius: 3px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          width: 100%;
          box-sizing: border-box;
        }

        .exclude-input.exclude-invalid {
          border-color: var(--error-color);
        }

        .select-all-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          font-size: 13px;
          font-weight: 500;
          border-bottom: 1px solid var(--divider-color);
          margin-bottom: 4px;
          cursor: pointer;
        }

        .select-all-row input[type="checkbox"] {
          margin: 0;
          cursor: pointer;
        }

        .recording-summary {
          font-size: 14px;
          color: var(--secondary-text-color);
          margin-bottom: 12px;
        }

        .log-preview {
          max-height: 420px;
          overflow-y: auto;
          /* Opaque, and matching the sticky header, so rows scrolled under the
             header can never show through or peek above it. */
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          padding: 0 0 4px;
          font-family: monospace;
          font-size: 12px;
          line-height: 1.5;
          user-select: none;
          -webkit-user-select: none;
        }

        .log-preview-line {
          display: flex;
          gap: 8px;
          padding: 2px 10px;
          user-select: none;
          -webkit-user-select: none;
        }

        .log-preview-line:hover {
          filter: brightness(1.2);
        }

        .log-preview-group {
          display: flex;
          gap: 8px;
          padding: 2px 10px;
          user-select: none;
          -webkit-user-select: none;
        }

        .log-preview-group:hover {
          filter: brightness(1.2);
        }

        .log-preview-group .idx-col {
          width: auto;
          min-width: 44px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }

        .dedup-toggle {
          background: none;
          border: none;
          color: var(--secondary-text-color);
          cursor: pointer;
          padding: 0;
          font-size: 10px;
          line-height: 1;
        }

        .dedup-toggle:hover {
          color: var(--primary-text-color);
        }

        .dedup-count {
          display: inline-block;
          margin-left: 2px;
          padding: 0 7px;
          border-radius: 11px;
          font-size: 11px;
          font-weight: 600;
          background: rgba(var(--rgb-primary-text-color), 0.12);
        }

        .log-preview-group-items {
          display: flex;
          flex-direction: column;
        }

        .log-preview-group-item {
          display: flex;
          gap: 8px;
          padding: 2px 10px;
          opacity: 0.4;
          user-select: none;
          -webkit-user-select: none;
          -webkit-user-drag: none;
        }

        .log-preview-group-item:hover {
          opacity: 1;
        }

        .log-preview-group-item + .log-preview-group-item {
          border-top: 1px solid var(--divider-color);
        }

        .results-summary {
          display: flex;
          flex-direction: column;
          gap: 2px;
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--divider-color);
          font-size: 13px;
        }

        .summary-title {
          font-weight: 600;
          font-size: 13px;
          margin-bottom: 4px;
        }

        .summary-section-title {
          font-weight: 600;
          color: var(--secondary-text-color);
          font-size: 12px;
          margin-top: 8px;
          margin-bottom: 2px;
        }

        .summary-sev-line {
          color: var(--secondary-text-color);
        }

        .summary-row {
          display: flex;
          align-items: baseline;
          gap: 8px;
          padding: 1px 0;
        }

        .summary-label {
          color: var(--secondary-text-color);
          min-width: 140px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .summary-message {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .summary-count {
          margin-left: auto;
          color: var(--secondary-text-color);
          font-variant-numeric: tabular-nums;
        }

        .results-summary-more {
          color: var(--secondary-text-color);
          font-style: italic;
        }

        .log-preview-header {
          display: flex;
          gap: 8px;
          padding: 4px 10px;
          font-weight: 600;
          color: var(--secondary-text-color);
          position: sticky;
          top: 0;
          z-index: 1;
          background: var(--card-background-color);
          border-bottom: 1px solid var(--divider-color);
          user-select: none;
          -webkit-user-select: none;
        }

        .log-preview-col {
          flex-shrink: 0;
        }

        .log-preview-col.idx-col {
          width: var(--col-idx, 44px);
          color: var(--secondary-text-color);
        }

        .log-preview-col.level-col {
          width: var(--col-level, 64px);
          font-weight: 600;
        }

        .log-preview-col.time-col {
          width: var(--col-time, 80px);
        }

        .log-preview-col.logger-col {
          width: var(--col-logger, 180px);
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .logger-child {
          color: var(--primary-text-color);
          opacity: 0.75;
          font-size: 0.9em;
        }

        .log-preview-header .resizable-col {
          position: relative;
          cursor: col-resize;
        }

        .log-preview-header .resizable-col::after {
          content: "";
          position: absolute;
          right: -3px;
          top: 0;
          bottom: 0;
          width: 6px;
        }

        /* Explicit row selection model (replaces native text selection). */
        .selectable-entry {
          user-select: none;
          -webkit-user-select: none;
          -webkit-user-drag: none;
        }

        .selectable-entry.selected {
          background: rgba(var(--rgb-primary-color), 0.18) !important;
          border-left: 3px solid var(--primary-color) !important;
          outline: 2px solid var(--primary-color);
          outline-offset: -2px;
        }

        .log-preview-col.msg-col {
          flex: 1;
          min-width: 0;
          white-space: pre-wrap;
          word-break: break-all;
        }
      </style>
      <ha-card>
        <div class="header">
          <div class="section-title">Loggers</div>
          <label class="set-all-row" title="Set the level of every managed logger at once. Core-pinned loggers are left untouched.">
            Set all:
            <select id="set-all-level" class="set-all-level"></select>
            <button type="button" id="set-all-apply" class="set-all-apply" disabled>Apply</button>
          </label>
        </div>

        <div id="active-list" class="active-list"></div>

        <div class="add-section-wrapper" id="add-section-wrapper">
          <div class="add-section">
            <div class="add-section-header">
              <div class="add-section-title">Configure logger</div>
              <button id="add-btn" disabled>Save</button>
            </div>

            <label class="field-label" for="friendly-name-input"
                   title="Display name shown in the card.">Friendly name</label>
            <input type="text" id="friendly-name-input" class="friendly-input"
                   placeholder="Optional display name" />

            <label class="field-label" for="path-input"
                   title="Python logger path to manage.">Logger path</label>
            <div class="input-wrapper">
              <input type="text" id="path-input" placeholder="Search or enter logger path..." />
              <div id="options-list" class="options-list"></div>
            </div>
          </div>
        </div>

        <div class="card-actions">
          <button class="toggle-add-btn" id="toggle-add-btn" title="Add a new logger to manage">
            <ha-icon icon="mdi:plus" id="toggle-icon"></ha-icon>
            <span id="toggle-text">Add logger</span>
          </button>

          <button class="toggle-add-btn" id="record-btn" title="Record log events for export">
            <ha-icon icon="mdi:record-circle" id="record-icon"></ha-icon>
            <span id="record-text">Record</span>
          </button>

          <button class="toggle-add-btn" id="discard-record-btn" style="display: none; color: var(--error-color);" title="Discard the recorded logs">
            <ha-icon icon="mdi:trash-can-outline"></ha-icon>
          </button>

          <button class="toggle-add-btn" id="live-btn" style="display: none;" title="View live log entries">
            <ha-icon icon="mdi:eye-outline" id="live-icon"></ha-icon>
            <span id="live-text">Live</span>
          </button>

          <button class="toggle-add-btn" onclick="window.location.href='/config/logs'" title="Open Home Assistant core log viewer">
            <ha-icon icon="mdi:text-box-search-outline"></ha-icon>
            View core logs
          </button>
        </div>
      </ha-card>

      <div class="delete-dialog-overlay" id="delete-dialog">
        <div class="delete-dialog-box">
          <div class="delete-dialog-title">Remove logger</div>
          <div class="delete-dialog-message"></div>
          <div class="delete-dialog-actions">
            <button class="btn-cancel" id="delete-cancel-btn">Cancel</button>
            <button class="btn-danger" id="delete-confirm-btn">Remove</button>
          </div>
        </div>
      </div>

      <div class="dialog-overlay" id="recording-setup-dialog">
        <div class="dialog-box recording-setup-box">
          <div class="dialog-title">Select loggers to record</div>
          <div class="profile-row" id="recording-profile-row">
            <label class="profile-label" for="recording-profile-select">Profile:</label>
            <select id="recording-profile-select" title="Load a saved recording profile"></select>
            <button class="btn-secondary profile-btn" id="recording-profile-save" title="Save the current selection as a profile">Save profile</button>
            <button class="btn-secondary profile-btn" id="recording-profile-delete" title="Delete the selected profile" disabled>✕</button>
          </div>
          <div class="profile-save-row" id="recording-profile-save-row" style="display: none;">
            <input type="text" id="recording-profile-name" placeholder="Profile name" maxlength="64">
            <button class="btn-primary profile-btn" id="recording-profile-confirm">Save</button>
            <button class="btn-secondary profile-btn" id="recording-profile-abort">Cancel</button>
          </div>
          <div id="logger-checklist" class="logger-checklist"></div>
          <div class="dialog-actions">
            <button class="btn-secondary" id="recording-setup-cancel">Cancel</button>
            <button class="btn-primary" id="recording-setup-start" disabled>Start recording</button>
          </div>
        </div>
      </div>

      <div class="dialog-overlay" id="history-dialog">
        <div class="dialog-box history-dialog-box">
          <div class="dialog-title">Level-change history</div>
          <div id="history-logger-name" style="color: var(--secondary-text-color); font-size: 13px; word-break: break-all;"></div>
          <table class="history-table">
            <thead>
              <tr><th>When</th><th>Source</th><th>From</th><th>To</th></tr>
            </thead>
            <tbody id="history-table-body"></tbody>
          </table>
          <div class="dialog-actions">
            <button class="btn-secondary" id="history-close-btn">Close</button>
          </div>
        </div>
      </div>

      <div class="dialog-overlay" id="recording-live-dialog">
        <div class="dialog-box dialog-box-wide">
          <div class="dialog-title" id="live-dialog-title">Live recording</div>
          <div id="live-top-bar" style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <span class="recording-dot" id="live-status-dot"></span>
            <span id="live-status-text" style="font-weight: 500;">Recording</span>
            <span id="live-timer" style="font-family: monospace; font-size: 14px;"></span>
            <span style="flex: 1;"></span>
            <button class="btn-secondary" id="live-pause-btn" title="Pause viewer update" style="padding: 4px 12px; font-size: 13px;">Pause</button>
            <button class="btn-danger" id="live-stop-btn" title="Stop recording" style="padding: 4px 12px; font-size: 13px;">Stop</button>
          </div>

          <label class="dedup-row" title="Fold runs of identical entries into one expandable row">
            <input type="checkbox" id="recording-dedup-toggle"> Group identical entries
          </label>
          <div id="live-filter-bar" style="display: flex; gap: 8px; margin-bottom: 8px;">
            <select id="live-logger-filter" title="Filter the live view by logger" style="flex: 1; padding: 4px 6px; border-radius: 4px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); font-size: 13px;"></select>
            <select id="live-level-filter" title="Filter the live view by minimum level" style="padding: 4px 6px; border-radius: 4px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); font-size: 13px;">
              <option value="ALL">All levels</option>
              <option value="DEBUG">DEBUG+</option>
              <option value="INFO">INFO+</option>
              <option value="WARNING">WARNING+</option>
              <option value="ERROR">ERROR+</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
          </div>

          <div class="selection-hint" style="margin-bottom: 6px;" title="Plain click selects one entry; Ctrl/Cmd-click or drag extends the selection.">Click to select &middot; Ctrl/Cmd-click or drag to select more</div>

          <div id="live-log-preview" class="log-preview"></div>

          <div id="live-summary" class="recording-summary" style="margin-top: 8px; margin-bottom: 0;"></div>

          <div class="dialog-actions" id="live-export-actions">
            <button class="btn-secondary" id="live-clear-btn" title="Clear all captured entries without stopping the recording">Clear</button>
            <button class="btn-secondary" id="live-save-plain-btn" disabled>Save as .log</button>
            <button class="btn-secondary" id="live-save-jsonl-btn" disabled title="JSON Lines — one JSON object per line (timestamp, level, logger, message, source); easy to process programmatically.">Save as JSONL</button>
            <button class="btn-secondary" id="live-copy-btn" disabled style="margin-right: auto;">Copy to clipboard</button>
            <button class="btn-danger" id="live-discard-btn" style="display: none;">Discard recording</button>
            <button class="btn-secondary" id="live-close-btn" title="Close this window; the recording continues in the background.">Close &amp; keep recording</button>
          </div>
        </div>
      </div>

      <div class="context-menu" id="context-menu" style="display: none;"></div>
    `;

    this._activeList = this.shadowRoot.getElementById("active-list");
    this._setAllLevel = this.shadowRoot.getElementById("set-all-level");
    this._setAllApply = this.shadowRoot.getElementById("set-all-apply");
    this._pathInput = this.shadowRoot.getElementById("path-input");
    this._optionsList = this.shadowRoot.getElementById("options-list");
    this._friendlyNameInput = this.shadowRoot.getElementById("friendly-name-input");
    this._addBtn = this.shadowRoot.getElementById("add-btn");
    this._toggleAddBtn = this.shadowRoot.getElementById("toggle-add-btn");
    this._toggleIcon = this.shadowRoot.getElementById("toggle-icon");
    this._toggleText = this.shadowRoot.getElementById("toggle-text");
    this._addSectionWrapper = this.shadowRoot.getElementById("add-section-wrapper");
    this._deleteDialog = this.shadowRoot.getElementById("delete-dialog");
    this._recordBtn = this.shadowRoot.getElementById("record-btn");
    this._recordIcon = this.shadowRoot.getElementById("record-icon");
    this._recordText = this.shadowRoot.getElementById("record-text");
    this._discardRecordBtn = this.shadowRoot.getElementById("discard-record-btn");
    this._recordingSetupDialog = this.shadowRoot.getElementById("recording-setup-dialog");
    this._loggerChecklist = this.shadowRoot.getElementById("logger-checklist");
    this._recordingSetupStart = this.shadowRoot.getElementById("recording-setup-start");
    this._recordingSetupCancel = this.shadowRoot.getElementById("recording-setup-cancel");
    this._recordingDedupToggle = this.shadowRoot.getElementById("recording-dedup-toggle");
    this._recordingDedupToggle.checked = this._isDedupEnabled();
    this._profileSelect = this.shadowRoot.getElementById("recording-profile-select");
    this._profileRow = this.shadowRoot.getElementById("recording-profile-row");
    this._profileSaveBtn = this.shadowRoot.getElementById("recording-profile-save");
    this._profileDeleteBtn = this.shadowRoot.getElementById("recording-profile-delete");
    this._profileSaveRow = this.shadowRoot.getElementById("recording-profile-save-row");
    this._profileNameInput = this.shadowRoot.getElementById("recording-profile-name");
    this._profileConfirmBtn = this.shadowRoot.getElementById("recording-profile-confirm");
    this._profileAbortBtn = this.shadowRoot.getElementById("recording-profile-abort");
    this._recordingLiveDialog = this.shadowRoot.getElementById("recording-live-dialog");
    this._liveTimer = this.shadowRoot.getElementById("live-timer");
    this._liveStatusText = this.shadowRoot.getElementById("live-status-text");
    this._liveStatusDot = this.shadowRoot.getElementById("live-status-dot");
    this._livePauseBtn = this.shadowRoot.getElementById("live-pause-btn");
    this._liveStopBtn = this.shadowRoot.getElementById("live-stop-btn");
    this._liveLoggerFilter = this.shadowRoot.getElementById("live-logger-filter");
    this._liveLevelFilter = this.shadowRoot.getElementById("live-level-filter");
    this._livePreview = this.shadowRoot.getElementById("live-log-preview");
    this._liveSummary = this.shadowRoot.getElementById("live-summary");
    this._liveSavePlainBtn = this.shadowRoot.getElementById("live-save-plain-btn");
    this._liveSaveJsonlBtn = this.shadowRoot.getElementById("live-save-jsonl-btn");
    this._liveCopyBtn = this.shadowRoot.getElementById("live-copy-btn");
    this._liveCloseBtn = this.shadowRoot.getElementById("live-close-btn");
    this._liveClearBtn = this.shadowRoot.getElementById("live-clear-btn");
    this._liveDiscardBtn = this.shadowRoot.getElementById("live-discard-btn");
    this._contextMenu = this.shadowRoot.getElementById("context-menu");
    this._previewContextMenu = this._contextMenu;
    this._liveBtn = this.shadowRoot.getElementById("live-btn");
    this._liveDialogTitle = this.shadowRoot.getElementById("live-dialog-title");
    this._historyDialog = this.shadowRoot.getElementById("history-dialog");
    this._historyLoggerName = this.shadowRoot.getElementById("history-logger-name");
    this._historyTableBody = this.shadowRoot.getElementById("history-table-body");
    this._historyCloseBtn = this.shadowRoot.getElementById("history-close-btn");

    this._pathInput.value = this._savedPath;
    this._friendlyNameInput.value = this._savedName;
    // Preserve a name restored from sessionStorage so auto-fill never clobbers it.
    this._friendlyNameDirty = this._savedName !== "";

    // Delete dialog handlers.
    const closeDelete = () => {
      this._deleteDialog.style.display = "none";
      const target = this._deleteConfirmTarget;
      this._deleteConfirmTarget = null;
      if (target && typeof target.onCancel === "function") target.onCancel();
    };
    this.shadowRoot.getElementById("delete-cancel-btn").addEventListener("click", closeDelete);
    this._deleteDialog.addEventListener("click", (e) => {
      if (e.target === this._deleteDialog) closeDelete();
    });

    this.shadowRoot.getElementById("delete-confirm-btn").addEventListener("click", () => {
      // Close first so an onConfirm that opens another dialog is not immediately hidden.
      this._deleteDialog.style.display = "none";
      const target = this._deleteConfirmTarget;
      this._deleteConfirmTarget = null;
      if (target) target.onConfirm();
    });

    // Level-change history dialog.
    const closeHistory = () => {
      this._historyDialog.classList.remove("visible");
      this._historyDialog.style.display = "none";
    };
    this._historyCloseBtn.addEventListener("click", closeHistory);
    this._historyDialog.addEventListener("click", (e) => {
      if (e.target === this._historyDialog) closeHistory();
    });

    // Recording button: stop recording, fetch saved results, or open setup.
    this._recordBtn.addEventListener("click", () => {
      if (this._recordingState === "recording") {
        this._showDeleteConfirm(
          "Stop recording and keep the captured entries?",
          () => this._stopRecording(),
          "Stop recording",
          "Stop"
        );
      } else if (this._recordingState === "stopping") {
        // Ignore clicks while stopping is in-flight.
      } else if (this._recordingState === "completed") {
        this._fetchResults();
      } else {
        this._openRecordingSetup();
      }
    });

    // Recording setup dialog handlers.
    const closeSetup = () => {
      this._recordingSetupDialog.classList.remove("visible");
      this._recordingSetupDialog.style.display = "none";
    };
    this._recordingSetupCancel.addEventListener("click", closeSetup);
    this._recordingSetupDialog.addEventListener("click", (e) => {
      if (e.target === this._recordingSetupDialog) closeSetup();
    });

    // Recording profile handlers.
    this._profileSelect.addEventListener("change", () => this._onProfileSelectChange());
    this._profileSaveBtn.addEventListener("click", () => {
      // Replace the selection row with the save controls, not a new row below.
      this._profileRow.style.display = "none";
      this._profileNameInput.value = this._profileSelect.value || "";
      this._profileSaveRow.style.display = "flex";
      this._profileNameInput.focus();
    });
    this._profileAbortBtn.addEventListener("click", () => {
      this._profileSaveRow.style.display = "none";
      this._profileRow.style.display = "flex";
      this._profileNameInput.value = "";
    });
    this._profileConfirmBtn.addEventListener("click", () => {
      this._saveProfile();
    });
    this._profileNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._saveProfile();
    });
    this._recordingDedupToggle.addEventListener("change", () => {
      this._liveDedupOverride = this._recordingDedupToggle.checked;
      if (this._resultsShown) {
        this._rebuildResultsPreview();
        this._renderResultsSummary();
      } else if (this._liveViewOpen) {
        this._rebuildLivePreview();
      }
    });

    this._profileDeleteBtn.addEventListener("click", () => {
      const name = this._profileSelect.value;
      if (!name) return;
      this._showDeleteConfirm(`Delete recording profile "${name}"?`, () => {
        this._hass.connection.sendMessagePromise({
          type: "log_manager/profile_delete",
          name: name,
        }).then(res => {
          this._renderProfileOptions((res && res.profiles) || []);
        }).catch(err => console.error("Failed to delete profile:", err));
      }, "Delete profile", "Delete");
    });

    this._recordingSetupStart.addEventListener("click", () => {
      const checkboxes = this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
      const selected = [];
      const levelOverrides = {};
      // Loggers whose configured level is stricter than the recording level were
      // raised at selection time; those intents are applied on start.
      checkboxes.forEach(cb => {
        if (cb.checked) {
          const loggerName = cb.dataset.logger;
          selected.push(loggerName);
          const levelSelect = cb.closest(".checklist-item").querySelector(".recording-level-select");
          const level = levelSelect ? levelSelect.value : null;
          if (level) levelOverrides[loggerName] = level;
        }
      });
      const excludes = this._collectRecordingExcludes();
      this._recordingSetupDialog.classList.remove("visible");
      this._recordingSetupDialog.style.display = "none";
      this._startRecording(selected, levelOverrides, excludes);
    });

    // Live view button.
    this._liveBtn.addEventListener("click", () => {
      if (this._recordingState === "recording") {
        this._openLiveView();
      }
    });

    // Live view dialog handlers.
    const closeLive = () => {
      this._closeLiveView();
    };
    this._liveCloseBtn.addEventListener("click", closeLive);
    this._recordingLiveDialog.addEventListener("click", (e) => {
      if (e.target === this._recordingLiveDialog) closeLive();
    });

    this._livePauseBtn.addEventListener("click", () => {
      this._togglePauseLive();
    });

    this._liveStopBtn.addEventListener("click", () => {
      this._showDeleteConfirm(
        "Stop recording and keep the captured entries?",
        () => { this._closeLiveView(); this._stopRecording(); },
        "Stop recording",
        "Stop"
      );
    });

    this._liveLoggerFilter.addEventListener("change", () => {
      this._applyLiveFilters();
    });

    this._liveLevelFilter.addEventListener("change", () => {
      this._applyLiveFilters();
    });

    this._liveSavePlainBtn.addEventListener("click", () => {
      this._downloadLogs("plain");
    });

    this._liveSaveJsonlBtn.addEventListener("click", () => {
      this._downloadLogs("jsonl");
    });

    this._liveCopyBtn.addEventListener("click", () => {
      this._copyLogsToClipboard();
    });

    this._liveClearBtn.addEventListener("click", () => {
      this._showDeleteConfirm(
        "Clear all captured entries? Recording continues.",
        () => this._clearRecordingBuffer(),
        "Clear recording",
        "Clear"
      );
    });

    this._liveDiscardBtn.addEventListener("click", () => {
      this._showDeleteConfirm(
        "Discard the recorded logs? This cannot be undone.",
        () => this._discardRecording(),
        "Discard recording",
        "Discard"
      );
    });

    this._discardRecordBtn.addEventListener("click", () => {
      this._showDeleteConfirm(
        "Discard the recorded logs? This cannot be undone.",
        () => this._discardRecording(),
        "Discard recording",
        "Discard"
      );
    });

    // Right-click context menu, shared by every non-text surface. Text inputs
    // keep the browser's cut/copy/paste menu.
    this._livePreview.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this._showContextMenu(this._previewMenuItems(), e.clientX, e.clientY);
    });
    this._livePreview.addEventListener("scroll", () => this._hideContextMenu());
    this._activeList.addEventListener("contextmenu", (e) => this._handleListContextMenu(e));
    this._loggerChecklist.addEventListener("contextmenu", (e) => this._handleChecklistContextMenu(e));
    this._historyTableBody.addEventListener("contextmenu", (e) => this._handleHistoryContextMenu(e));
    window.addEventListener("click", () => this._hideContextMenu());

    // Format selected rows nicely when copying from the preview.
    this._livePreview.addEventListener("copy", (e) => this._handlePreviewCopy(e));

    // Clicking empty space or the header clears any text selection.
    this._livePreview.addEventListener("click", (e) => {
      if (e.target === this._livePreview || e.target.closest(".log-preview-header")) {
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
      }
    });

    const toggleSection = () => {
      if (this._isAddSectionVisible) {
        this._closeAddSection();
      } else {
        this._openAddSection();
      }
    };

    this._toggleAddBtn.addEventListener("click", toggleSection);

    // "Set all" bulk level control.
    this._setAllLevel.innerHTML = ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
      .map(l => `<option value="${l}">${l}</option>`).join("");
    const paintSetAll = () => {
      const colors = this._levelColors(this._setAllLevel.value);
      this._setAllLevel.style.color = colors.color;
      this._setAllLevel.style.borderColor = colors.color;
    };
    paintSetAll();
    this._setAllLevel.addEventListener("change", paintSetAll);
    this._setAllApply.addEventListener("click", () => this._applySetAll());

    const debouncedFilter = this._debounce((val) => {
      this._filterDropdown(val);
    }, 200).bind(this);

    this._pathInput.addEventListener("input", (e) => {
      const val = e.target.value;
      debouncedFilter(val);
      this._persistState();
      this._validateAddButton();
    });

    this._pathInput.addEventListener("focus", () => {
      this._optionsList.style.display = "block";
      this._filterDropdown(this._pathInput.value);
    });

    this._pathInput.addEventListener("blur", () => {
      setTimeout(() => { this._optionsList.style.display = "none"; }, 150);
    });

    const handleEscKey = (e) => {
      if (e.key === "Escape") {
        if (this._optionsList.style.display === "block") {
          this._optionsList.style.display = "none";
        } else if (this._isAddSectionVisible) {
          this._closeAddSection();
        }
      }
    };

    // Enter moves to the friendly name field; Escape closes the dropdown.
    this._pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this._optionsList.style.display = "none";
        this._applyAutoFriendlyName();
        this._friendlyNameInput.focus();
      } else if (e.key === "Escape") {
        handleEscKey(e);
      }
    });

    // Enter in the friendly name field saves the logger.
    this._friendlyNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!this._addBtn.disabled) {
          this._addBtn.click();
        }
      } else if (e.key === "Escape") {
        handleEscKey(e);
      }
    });

    this._friendlyNameInput.addEventListener("input", () => {
      this._friendlyNameDirty = true;
      this._persistState();
      this._validateAddButton();
    });

    this._addBtn.addEventListener("click", () => {
      const loggerPath = this._pathInput.value.trim();
      const friendlyName = this._friendlyNameInput.value.trim() || loggerPath;

      if (this._editingPath) {
        this._hass.callService("log_manager", "remove_logger", {
          logger_name: this._editingPath
        });

        setTimeout(() => {
          this._hass.callService("log_manager", "add_logger", {
            logger_name: loggerPath,
            friendly_name: friendlyName
          });
        }, 250);
      } else {
        this._hass.callService("log_manager", "add_logger", {
          logger_name: loggerPath,
          friendly_name: friendlyName
        });
        this._clearState();
        this._closeAddSection();
      }
    });

    // Re-render after focus leaves a control so a deferred commit is reflected,
    // coalesced through the same rAF scheduler the state updates use so routine
    // tabbing does not trigger a full list rebuild per focus change.
    this.shadowRoot.addEventListener("focusout", () => {
      this._scheduleUpdate();
    });

    // Explicit row-selection model for the logger panel and the live/results views.
    this._activeList.addEventListener("mousedown", (e) => this._onSelectionMouseDown(this._activeList, e));
    this._livePreview.addEventListener("mousedown", (e) => this._onSelectionMouseDown(this._livePreview, e));

    // ESC key closes any open dialog.
    this.shadowRoot.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this._contextMenu && this._contextMenu.style.display === "block") {
        this._hideContextMenu();
        return;
      }
      if (this._deleteDialog.style.display === "flex") {
        this._deleteDialog.style.display = "none";
        this._deleteConfirmTarget = null;
      } else if (this._historyDialog.style.display === "flex") {
        this._historyDialog.classList.remove("visible");
        this._historyDialog.style.display = "none";
      } else if (this._recordingSetupDialog.style.display === "flex") {
        this._recordingSetupDialog.classList.remove("visible");
        this._recordingSetupDialog.style.display = "none";
      } else if (this._recordingLiveDialog.style.display === "flex") {
        this._closeLiveView();
      }
    });
  }

  _fetchLoggers() {
    this._hass.connection.sendMessagePromise({ type: "log_manager/get_loggers" }).then(res => {
      this._availableLoggers = res.sort();
      this._renderDropdown();
    });
  }

  _renderDropdown() {
    this._optionsList.innerHTML = "";

    const highlights = ["homeassistant.", "custom_components.", "pyscript."];

    const activePaths = Object.values(this._hass.states)
      .filter(s => s.entity_id.startsWith("select.") && s.attributes.logger_name)
      .map(s => s.attributes.logger_name);

    this._availableLoggers.forEach(opt => {
      if (activePaths.includes(opt) && opt !== this._editingPath) return;

      const item = document.createElement("div");
      item.className = "option-item";

      item.dataset.path = opt;
      const isHighlight = highlights.some(prefix => opt.startsWith(prefix));
      if (isHighlight) item.classList.add("highlight");
      item.dataset.star = isHighlight ? "1" : "";
      this._renderOptionLabel(item, "");

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._pathInput.value = opt;
        // A newly chosen logger recomputes the suggested name even if the
        // user had edited the previous one.
        this._applyAutoFriendlyName(true);
        this._persistState();
        this._validateAddButton();
        this._optionsList.style.display = "none";
        this._friendlyNameInput.focus();
      });

      this._optionsList.appendChild(item);
    });
  }

  // Rank a candidate against the query: exact substring wins, otherwise a
  // gap-penalised subsequence match (so "pyscriptfile" finds "pyscript.file").
  _fuzzyScore(text, query) {
    const t = String(text || "").toLowerCase();
    const q = String(query || "").toLowerCase().replace(/[\s_]+/g, "");
    if (!q) return 1;
    const idx = t.indexOf(q);
    if (idx !== -1) return 10000 - idx - Math.max(0, t.length - q.length);
    let ti = 0;
    let score = 0;
    let streak = 0;
    for (const ch of q) {
      const found = t.indexOf(ch, ti);
      if (found === -1) return 0;
      streak = found === ti ? streak + 1 : 0;
      score += 10 + streak;
      ti = found + 1;
    }
    return score;
  }

  // Wrap the fuzzy-matched characters in <b> so the match is visible.
  _highlightMatch(text, query) {
    const raw = String(text || "");
    const q = String(query || "").toLowerCase().replace(/[\s_]+/g, "");
    if (!q) return this._escapeHtml(raw);
    const chars = Array.from(raw);
    const lower = chars.map(c => c.toLowerCase());
    const hit = new Array(chars.length).fill(false);
    let qi = 0;
    for (let i = 0; i < chars.length && qi < q.length; i++) {
      if (lower[i] === q[qi]) {
        hit[i] = true;
        qi++;
      }
    }
    return chars.map((c, i) =>
      hit[i] ? `<b class="fuzzy-hit">${this._escapeHtml(c)}</b>` : this._escapeHtml(c)
    ).join("");
  }

  _renderOptionLabel(item, query) {
    const path = item.dataset.path || "";
    const star = item.dataset.star ? `<span class="option-star">★ </span>` : "";
    item.innerHTML = star + this._highlightMatch(path, query);
  }

  _filterDropdown(filterText) {
    const entries = Array.from(this._optionsList.children).map(child => {
      const text = child.dataset.path || child.textContent.replace("★ ", "");
      return { child, score: this._fuzzyScore(text, filterText) };
    });
    entries.sort((a, b) => b.score - a.score);
    entries.forEach(({ child, score }) => {
      child.style.display = score > 0 ? "block" : "none";
      this._renderOptionLabel(child, filterText);
      this._optionsList.appendChild(child);
    });
  }

  _updateActiveList() {
    const rawActiveEntities = Object.keys(this._hass.states).filter(eid => {
      return eid.startsWith("select.") && this._hass.states[eid].attributes.logger_name;
    });

    // "Set all" only makes sense when there is at least one managed logger.
    if (this._setAllApply) this._setAllApply.disabled = rawActiveEntities.length === 0;

    if (rawActiveEntities.length === 0) {
      this._activeList.innerHTML = `
        <div class="empty-state"
          style="color: var(--secondary-text-color); font-style: italic;
          font-size: 14px; text-align: center; padding: 16px;">
          No loggers currently managed.
        </div>`;

      if (this._isAddSectionVisible) {
        this._renderDropdown();
        this._filterDropdown(this._pathInput.value);
      }
      return;
    }

    const emptyState = this._activeList.querySelector(".empty-state");
    if (emptyState) emptyState.remove();

    this._activeList.style.display = "flex";
    this._activeList.style.flexDirection = "column";
    this._activeList.style.gap = "8px";

    const mappedEntities = rawActiveEntities.map(eid => {
      const stateObj = this._hass.states[eid];
      const friendlyName = stateObj.attributes.friendly_name || eid;
      return { eid, friendlyName };
    });

    mappedEntities.sort((a, b) => {
      return a.friendlyName.localeCompare(b.friendlyName, undefined, { sensitivity: "base" });
    });

    const activeEntities = mappedEntities.map(item => item.eid);

    const grouping = this._isGroupingEnabled();
    const collapsedMap = this._getCollapsedGroups();
    const rowByEid = {};
    let model = [];
    let collapsibleByLogger = {};
    let loggerToEid = {};
    if (grouping) {
      activeEntities.forEach(eid => {
        const name = this._hass.states[eid].attributes.logger_name || "";
        if (name) loggerToEid[name] = eid;
      });
      model = this._buildLoggerTree(Object.keys(loggerToEid));
      model.forEach(item => {
        if (item.kind === "row") collapsibleByLogger[item.logger] = item.collapsible;
      });
    }
    // Drop headers no longer in the model (or all of them in flat mode).
    const desiredHeaderKeys = new Set(
      model.filter(item => item.kind === "group").map(item => item.key)
    );
    Array.from(this._activeList.querySelectorAll(".log-group-header")).forEach(header => {
      if (!grouping || !desiredHeaderKeys.has(header.dataset.group)) header.remove();
    });

    const existingRows = Array.from(this._activeList.querySelectorAll(".log-row"));
    existingRows.forEach(row => {
      if (!activeEntities.includes(row.dataset.entityId)) row.remove();
    });

    activeEntities.forEach((eid) => {
      const stateObj = this._hass.states[eid];
      let row = this._activeList.querySelector(`.log-row[data-entity-id="${eid}"]`);

      const options = stateObj.attributes.options || [];
      const isUnavailable = stateObj.state === "unavailable" ||
                            stateObj.state === "unknown" ||
                            options.length === 0;
      const actualLoggerName = stateObj.attributes.logger_name || "Unknown";
      const displayName = stateObj.attributes.friendly_name || eid;
      const currentLevel = stateObj.state;
      const isPinned = !!stateObj.attributes.core_pinned;
      const pinnedTitle = "Managed by Home Assistant — set via YAML logger:, the integration's debug toggle, or the logger.set_level service.";
      const chipInfo = this._effectiveChipInfo(stateObj, currentLevel, isUnavailable);
      const chipSig = chipInfo ? `${chipInfo.effectiveLevel}|${chipInfo.sourceText}` : "";
      const raisedChipHtml = this._renderRaisedChipHtml(
        actualLoggerName,
        this._recordingState === "recording" && this._recordingLoggers.includes(actualLoggerName)
      );
      const levelTitleSig = this._levelSelectTooltip(
        actualLoggerName, currentLevel, isPinned,
        this._recordingState === "recording" && this._recordingLoggers.includes(actualLoggerName)
      );
      // NOTSET rows take the effective level's colour, with a dashed border to
      // signal the level is inherited rather than set here.
      const inherited = currentLevel === "NOTSET" && !!chipInfo;
      const colorLevel = inherited ? chipInfo.effectiveLevel : currentLevel;
      const colors = this._levelColors(colorLevel);
      const badgeStats = this._counters[actualLoggerName];
      const curWarn = badgeStats ? (badgeStats.warning || 0) : 0;
      const curErr = badgeStats ? (badgeStats.error || 0) : 0;
      // A logger being recorded has a locked level until the session ends.
      const recordedNow = this._recordingState === "recording" && this._recordingLoggers.includes(actualLoggerName);
      // Managed loggers with managed children get an inline collapse chevron.
      const hasChildren = grouping && !!collapsibleByLogger[actualLoggerName];

      if (
        !row ||
        row.dataset.isUnavailable !== String(isUnavailable) ||
        row.dataset.hasChildren !== String(hasChildren)
      ) {
        if (row) row.remove();

        row = document.createElement("div");
        row.className = "log-row";
        row.dataset.entityId = eid;
        row.dataset.loggerName = actualLoggerName;
        row.dataset.isUnavailable = String(isUnavailable);
        row.dataset.hasChildren = String(hasChildren);

        // Apply level-based row tint (effective level when inherited).
        row.style.background = colors.rowBg;
        row.style.borderStyle = inherited ? "dashed" : "";

        const selectOptions = options.map(opt => `<option value="${opt}">${opt}</option>`).join("");

        // The selector tooltip shows lock reasons plus the current level/source;
        // the full level-change history lives in the history dialog.
        const selectTitle = this._levelSelectTooltip(actualLoggerName, currentLevel, isPinned, recordedNow);
        const selectHtml = isUnavailable
          ? `<select class="level-select" disabled><option>Unavailable</option></select>`
          : `<select class="level-select"${selectTitle ? ` title="${this._escapeAttr(selectTitle)}"` : ""}${isPinned || recordedNow ? " disabled" : ""}>${selectOptions}</select>`;

        const counterBadgeHtml = this._renderCounterBadgeHtml(actualLoggerName);
        const counterBadgesDiv = counterBadgeHtml ? `<div class="counter-badges">${counterBadgeHtml}</div>` : "";

        const isExpanded = this._expandedLogger === actualLoggerName;
        const logPanelHtml = isExpanded ? this._renderLogPanelHtml(actualLoggerName) : "";

        const isRecording = this._recordingState === "recording" && this._recordingLoggers.includes(actualLoggerName);
        const recordingLevel = this._recordingLevelOverrides[actualLoggerName] || currentLevel;
        const recordingTag = isRecording
          ? `<span class="recording-tag" title="Recording at ${this._escapeAttr(recordingLevel)}">${recordingLevel.charAt(0)}</span>`
          : "";
        const pinnedTag = isPinned
          ? `<span class="pinned-tag" title="${this._escapeAttr(pinnedTitle)}">Pinned</span>`
          : "";
        const effectiveChip = this._renderEffectiveChip(stateObj, currentLevel, isUnavailable);
        const raisedChip = this._renderRaisedChipHtml(actualLoggerName, isRecording);
        const rowChevron = hasChildren
          ? `<button type="button" class="row-group-chevron" title="Collapse or expand child loggers">${this._getCollapsedGroups()[actualLoggerName] ? "\u25B8" : "\u25BE"}</button>`
          : "";

        row.innerHTML = `
          <div class="log-name ${isUnavailable ? "unavailable" : ""}" title="Click to expand or collapse the log panel">
            <div style="font-weight: 500;">${recordingTag}${pinnedTag}${rowChevron}${this._escapeHtml(displayName)}</div>
            <div style="color: var(--secondary-text-color); font-size: 12px; margin-top: 2px;">
              ${this._escapeHtml(actualLoggerName)}
              ${effectiveChip}
              ${raisedChip}
            </div>
          </div>
          <div class="log-controls-wrapper">
            ${counterBadgesDiv}
            <div class="log-controls">
              ${selectHtml}
              <button class="icon-btn action-btn edit-btn" title="Edit">
                <ha-icon icon="mdi:pencil"></ha-icon>
              </button>
              <button class="icon-btn action-btn remove-btn" title="Remove">
                <ha-icon icon="mdi:delete"></ha-icon>
              </button>
            </div>
          </div>
          ${logPanelHtml}
        `;

        if (!isUnavailable) {
          const selectEl = row.querySelector(".level-select");
          selectEl.value = currentLevel;
          selectEl.style.backgroundColor = colors.bg;
          selectEl.style.color = colors.color;
          selectEl.style.borderStyle = inherited ? "dashed" : "";

          selectEl.addEventListener("change", (e) => {
            this._hass.callService("select", "select_option", {
              entity_id: eid,
              option: e.target.value
            });
          });

          // Prevent select change from toggling expand.
          selectEl.addEventListener("click", (e) => e.stopPropagation());

          row.querySelector(".edit-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            this._pathInput.value = actualLoggerName;
            this._friendlyNameInput.value = displayName;
            this._editingPath = actualLoggerName;
            // Start from the current name; a different selection recomputes it.
            this._friendlyNameDirty = true;

            // Expand in place, directly beneath the row being edited.
            this._insertAddSectionAfter(row);
            if (!this._isAddSectionVisible) {
              this._openAddSection("name");
            } else {
              this._addSectionWrapper.classList.add("visible");
              setTimeout(() => {
                this._friendlyNameInput.focus();
                this._friendlyNameInput.select();
              }, 0);
              this._validateAddButton();
            }
          });
        } else {
          row.querySelector(".edit-btn").disabled = true;
          row.querySelector(".edit-btn").style.opacity = "0.3";
          row.querySelector(".edit-btn").style.cursor = "not-allowed";
          row.querySelector(".remove-btn").style.opacity = "0.3";
        }

        if (hasChildren) {
          const chevronBtn = row.querySelector(".row-group-chevron");
          if (chevronBtn) {
            chevronBtn.addEventListener("click", (ev) => {
              ev.stopPropagation();
              this._setGroupCollapsed(actualLoggerName, !this._getCollapsedGroups()[actualLoggerName]);
              this._updateActiveList();
            });
          }
        }

        // Click on the logger name area to toggle expand panel.
        row.querySelector(".log-name").addEventListener("click", () => {
          this._toggleExpand(actualLoggerName);
        });

        // Click on empty space in the row also toggles expand.
        row.addEventListener("click", (e) => {
          if (e.target.closest(".log-controls") || e.target.closest(".counter-badge") || e.target.closest(".log-panel") || e.target.closest(".log-name")) return;
          this._toggleExpand(actualLoggerName);
        });

        row.querySelector(".remove-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          this._showDeleteConfirm(`Remove logger "${displayName}"?`, () => {
            if (!isUnavailable) {
              this._hass.callService("log_manager", "remove_logger", {
                logger_name: actualLoggerName,
                friendly_name: displayName
              });
            } else {
              this._hass.connection.sendMessagePromise({
                type: "config/entity_registry/remove",
                entity_id: eid
              }).catch(() => { });
            }
          });
        });

        if (recordedNow && !isUnavailable) {
          [["remove-btn", "Stop the recording to remove this logger"],
           ["edit-btn", "Stop the recording to edit this logger"]].forEach(([cls, title]) => {
            const b = row.querySelector(`.${cls}`);
            if (b) {
              b.disabled = true;
              b.style.opacity = "0.3";
              b.style.cursor = "not-allowed";
              b.title = title;
            }
          });
        }

        this._attachBadgeHandlers(row);
        this._attachResetHandler(row);
        this._attachCopyPanelHandler(row);
        this._attachAlertHandler(row);
        this._attachHistoryHandler(row);
        this._updateRecordingCountBadge(
          row, actualLoggerName,
          this._recordingCounts[actualLoggerName] || 0,
          this._recordingState === "recording" && this._recordingLoggers.includes(actualLoggerName)
        );

      } else {
        // Update existing row — only touch DOM when values actually changed.
        const prev = this._prevRowStates[eid] || {};

        if (!isUnavailable) {
          const select = row.querySelector(".level-select");
          if (
            document.activeElement !== select &&
            (prev.level !== currentLevel || prev.colorLevel !== colorLevel)
          ) {
            select.value = currentLevel;
            select.style.backgroundColor = colors.bg;
            select.style.color = colors.color;
            select.style.borderStyle = inherited ? "dashed" : "";
          }
        }

        // Update row background tint when the level or its effective colour changes.
        if (prev.level !== currentLevel || prev.colorLevel !== colorLevel) {
          row.style.background = colors.rowBg;
          row.style.borderStyle = inherited ? "dashed" : "";
        }

        // Update counter badges in-place — never destroy badge DOM, so title tooltips survive.
        if (prev.warningCount !== curWarn || prev.errorCount !== curErr) {
          this._updateBadgesInPlace(row, actualLoggerName);
        }

        // Update or toggle the expand panel — only replace when content changed.
        let panel = row.querySelector(".log-panel");
        const isExpanded = this._expandedLogger === actualLoggerName;
        if (isExpanded) {
          const panelHtml = this._renderLogPanelHtml(actualLoggerName);
          // A committed control change requests a rebuild even while its control
          // still has focus; otherwise never rebuild while a control inside the
          // panel has focus (an incoming entry would close an open dropdown and
          // revert the value). The forced request is held until the rendered
          // content actually changes, so it lands when the fresh state arrives
          // rather than repainting stale content first. The explicit selection
          // survives rebuilds via stored entry keys.
          const forceRefresh = this._panelRefreshRequested === actualLoggerName;
          const panelFocused = !!panel && panel.contains(this.shadowRoot.activeElement);
          const contentChanged = this._prevPanelHtml[actualLoggerName] !== panelHtml;
          if (panel) {
            if (contentChanged && (forceRefresh || !panelFocused)) {
              panel.outerHTML = panelHtml;
              this._prevPanelHtml[actualLoggerName] = panelHtml;
              if (forceRefresh) this._panelRefreshRequested = null;
              this._attachResetHandler(row);
              this._attachCopyPanelHandler(row);
              this._attachAlertHandler(row);
              this._attachHistoryHandler(row);
            }
          } else {
            row.insertAdjacentHTML("beforeend", panelHtml);
            this._prevPanelHtml[actualLoggerName] = panelHtml;
            if (forceRefresh) this._panelRefreshRequested = null;
            this._attachResetHandler(row);
            this._attachCopyPanelHandler(row);
            this._attachAlertHandler(row);
            this._attachHistoryHandler(row);
          }
        } else if (panel) {
          panel.remove();
          delete this._prevPanelHtml[actualLoggerName];
        }

        // Update recording tag when recording state changes.
        const isRecording = this._recordingState === "recording" && this._recordingLoggers.includes(actualLoggerName);
        if (prev.recording !== isRecording) {          const nameDivFirst = row.querySelector(".log-name > div:first-child");
          if (nameDivFirst) {
            const existingTag = nameDivFirst.querySelector(".recording-tag");
            if (isRecording && !existingTag) {
              const tag = document.createElement("span");
              tag.className = "recording-tag";
              const recordingLevel = this._recordingLevelOverrides[actualLoggerName] || currentLevel;
              tag.textContent = recordingLevel.charAt(0);
              tag.title = `Recording at ${recordingLevel}`;
              nameDivFirst.insertBefore(tag, nameDivFirst.firstChild);
            } else if (!isRecording && existingTag) {
              existingTag.remove();
            }
          }
          if (!isUnavailable) {
            const select = row.querySelector(".level-select");
            if (select) select.disabled = isPinned || isRecording;
            [["remove-btn", "Remove", "Stop the recording to remove this logger"],
             ["edit-btn", "Edit", "Stop the recording to edit this logger"]].forEach(([cls, normal, locked]) => {
              const b = row.querySelector(`.${cls}`);
              if (b) {
                b.disabled = isRecording;
                b.style.opacity = isRecording ? "0.3" : "";
                b.style.cursor = isRecording ? "not-allowed" : "";
                b.title = isRecording ? locked : normal;
              }
            });
          }
        }

        // Update pinned tag and selector state when core pinning changes.
        if (prev.pinned !== isPinned) {          const nameDivFirst = row.querySelector(".log-name > div:first-child");
          if (nameDivFirst) {
            const existingPin = nameDivFirst.querySelector(".pinned-tag");
            if (isPinned && !existingPin) {
              const tag = document.createElement("span");
              tag.className = "pinned-tag";
              tag.textContent = "Pinned";
              tag.title = pinnedTitle;
              nameDivFirst.insertBefore(tag, nameDivFirst.firstChild);
            } else if (!isPinned && existingPin) {
              existingPin.remove();
            }
          }
          if (!isUnavailable) {
            const select = row.querySelector(".level-select");
            if (select) select.disabled = isPinned || isRecording;
          }
        }

        // Refresh the selector tooltip when the current level/source or lock changes.
        if (prev.levelTitleSig !== levelTitleSig) {
          const select = row.querySelector(".level-select");
          if (select) this._setSelectTitle(select, levelTitleSig);
        }

        // Update the effective-level chip when its content changes.
        if (prev.effective !== chipSig) {
          const pathDiv = row.querySelector(".log-name > div:last-child");
          if (pathDiv) {
            this._updateEffectiveChipInPlace(pathDiv, stateObj, currentLevel, isUnavailable);
          }
        }

        // Update the "Raised to X" chip when the recording raise state changes.
        if (prev.raised !== raisedChipHtml) {
          const pathDiv = row.querySelector(".log-name > div:last-child");
          if (pathDiv) this._updateRaisedChipInPlace(pathDiv, raisedChipHtml);
        }

        // Keep a terminal row's collapse chevron in sync with stored state.
        const chevronBtn = row.querySelector(".row-group-chevron");
        if (chevronBtn) {
          chevronBtn.textContent = this._getCollapsedGroups()[actualLoggerName]
            ? "\u25B8"
            : "\u25BE";
        }

        // Update recording count badge when count or recording state changes.
        const recordingCount = this._recordingCounts[actualLoggerName] || 0;
        if (prev.recording !== isRecording || prev.recordingCount !== recordingCount) {
          this._updateRecordingCountBadge(row, actualLoggerName, recordingCount, isRecording);
        }
      }

      // Cache state for next update to avoid unnecessary DOM touches.
      this._prevRowStates[eid] = {
        level: currentLevel,
        colorLevel,
        warningCount: curWarn,
        errorCount: curErr,
        pinned: isPinned,
        effective: chipSig,
        raised: raisedChipHtml,
        levelTitleSig,
        recording: this._recordingState === "recording" && this._recordingLoggers.includes(actualLoggerName),
        recordingCount: this._recordingCounts[actualLoggerName] || 0,
      };

      rowByEid[eid] = row;
    });

    // Lay out the flat list (headers and rows) in model order, applying the
    // depth indent and hiding anything under a collapsed ancestor.
    const orderedEls = [];
    if (grouping) {
      model.forEach(item => {
        if (item.kind === "group") {
          orderedEls.push({ el: this._ensureGroupHeader(item), item });
        } else {
          const eid = loggerToEid[item.logger];
          const row = eid ? rowByEid[eid] : null;
          if (row) orderedEls.push({ el: row, item });
        }
      });
    } else {
      activeEntities.forEach(eid => {
        const row = rowByEid[eid];
        if (row) orderedEls.push({ el: row, item: { depth: 0, ancestors: [] } });
      });
    }
    orderedEls.forEach((entry, index) => {
      const expected = this._activeList.children[index] || null;
      if (expected !== entry.el) this._activeList.insertBefore(entry.el, expected);
      // Cap the indent so deep trees never starve the logger name of width.
      const depth = Math.min(entry.item.depth || 0, 3);
      entry.el.style.marginLeft = `${depth * 12}px`;
      entry.el.style.borderLeft = depth > 0 ? "2px solid var(--divider-color)" : "";
      const hidden = (entry.item.ancestors || []).some(key => collapsedMap[key]);
      entry.el.style.display = hidden ? "none" : "";
    });

    if (this._isAddSectionVisible) {
      this._renderDropdown();
      this._filterDropdown(this._pathInput.value);
    }

    // Keep an open edit form directly beneath its logger after re-layout; the
    // ordered layout loop above reorders rows around it.
    if (this._editingPath && this._addSectionWrapper) {
      const editedRow = Array.from(this._activeList.querySelectorAll(".log-row"))
        .find(r => r.dataset.loggerName === this._editingPath);
      if (editedRow) this._insertAddSectionAfter(editedRow);
    }

    // Re-apply the explicit selection after any panel rebuild.
    this._refreshSelection(this._activeList);
  }

  _validateAddButton() {
    const loggerPath = this._pathInput.value.trim();
    const friendlyName = this._friendlyNameInput.value.trim();

    const activeStates = Object.values(this._hass.states).filter(s => {
      return s.entity_id.startsWith("select.") &&
             s.attributes.logger_name &&
             s.attributes.logger_name !== this._editingPath;
    });

    const isDuplicatePath = activeStates.some(s => s.attributes.logger_name === loggerPath);
    const isDuplicateName = activeStates.some(s => s.attributes.friendly_name === friendlyName && friendlyName !== "");
    const isUnknownPath = loggerPath.length > 0 &&
                          !this._availableLoggers.includes(loggerPath) &&
                          loggerPath !== this._editingPath;

    if (isDuplicatePath || isDuplicateName || isUnknownPath) {
      this._addBtn.disabled = true;
      if (isDuplicatePath) this._addBtn.innerText = "Path managed";
      else if (isDuplicateName) this._addBtn.innerText = "Name taken";
      else if (isUnknownPath) this._addBtn.innerText = "Unknown path";
      this._addBtn.style.background = "var(--error-color)";
    } else {
      this._addBtn.disabled = loggerPath.length === 0;
      this._addBtn.innerText = this._editingPath ? "Update" : "Save";
      this._addBtn.style.background = "var(--primary-color)";
    }
  }

  // --- Recording methods ---

  _openRecordingSetup() {
    // A fresh selection: drop any raise intents confirmed for a prior session.
    this._recordingRaiseIntents = {};
    const LOG_LEVELS = ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
    const managed = Object.entries(this._hass.states)
      .filter(([eid]) => eid.startsWith("select."))
      .filter(([, s]) => s.attributes.logger_name)
      .sort(([, a], [, b]) => (a.attributes.friendly_name || "").localeCompare(b.attributes.friendly_name || ""));

    let html = `<label class="select-all-row" for="select-all-checkbox">
      <input type="checkbox" id="select-all-checkbox">
      <span>Select all</span>
    </label>`;

    managed.forEach(([, stateObj]) => {
      const loggerName = stateObj.attributes.logger_name;
      const friendlyName = stateObj.attributes.friendly_name || loggerName;
      const currentLevel = stateObj.state;
      const colors = this._levelColors(currentLevel);
      const levelOpts = LOG_LEVELS.map(l => {
        const moreVerbose = this._isMoreVerbose(l, currentLevel);
        const label = l === "NOTSET" ? "All levels" : l;
        return `<option value="${l}"${l === currentLevel ? " selected" : ""}${moreVerbose ? ' data-more-verbose="1"' : ""}>${moreVerbose ? "\u2193 " : ""}${label}</option>`;
      }).join("");
      html += `<label class="checklist-item" style="background: ${colors.rowBg};">
        <input type="checkbox" data-logger="${this._escapeAttr(loggerName)}">
        <span class="logger-label">${this._escapeHtml(friendlyName)}</span>
        <select class="recording-level-select" data-prev-level="${this._escapeAttr(currentLevel)}" title="Recording level for ${this._escapeAttr(friendlyName)} (${this._escapeAttr(loggerName)})" disabled style="color: ${colors.color}; background: ${colors.bg};">${levelOpts}</select>
        <button type="button" class="exclude-toggle" data-logger="${this._escapeAttr(loggerName)}" title="Exclude child loggers of ${this._escapeAttr(loggerName)} from this recording" disabled>+ exclusions</button>
        <div class="exclude-area" data-logger="${this._escapeAttr(loggerName)}" style="display: none;">
          <div class="exclude-chips"></div>
          <div class="exclude-input-wrapper">
            <input type="text" class="exclude-input" data-logger="${this._escapeAttr(loggerName)}" placeholder="Search child logger to exclude — Enter to add">
            <div class="exclude-options options-list"></div>
          </div>
        </div>
      </label>`;
    });

    this._loggerChecklist.innerHTML = html;

    // A per-logger confirm is shown when a change raises the level; the prompt
    // records the intent instead of changing the level immediately.
    this._loggerChecklist.querySelectorAll(".recording-level-select").forEach(sel => {
      sel.addEventListener("change", () => this._handleRecordingLevelChange(sel));
    });

    const selectAll = this._loggerChecklist.querySelector("#select-all-checkbox");
    selectAll.addEventListener("change", () => {
      const checks = this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
      checks.forEach(cb => {
        cb.checked = selectAll.checked;
        // Also enable/disable level selects and the exclusions control.
        const item = cb.closest(".checklist-item");
        const levelSelect = item.querySelector(".recording-level-select");
        if (levelSelect) levelSelect.disabled = !selectAll.checked;
        const excludeToggle = item.querySelector(".exclude-toggle");
        if (excludeToggle) excludeToggle.disabled = !selectAll.checked;
      });
      this._markProfileDirty();
      this._validateRecordingSetup();
    });

    this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)").forEach(cb => {
      cb.addEventListener("change", () => {
        // Uncheck select-all if one is unchecked.
        const allChecks = this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
        const allChecked = Array.from(allChecks).every(c => c.checked);
        selectAll.checked = allChecked;

        // Enable/disable level select and the exclusions control.
        const item = cb.closest(".checklist-item");
        const levelSelect = item.querySelector(".recording-level-select");
        if (levelSelect) levelSelect.disabled = !cb.checked;
        const excludeToggle = item.querySelector(".exclude-toggle");
        if (excludeToggle) excludeToggle.disabled = !cb.checked;

        this._markProfileDirty();
        this._validateRecordingSetup();
      });
    });

    this._loggerChecklist.querySelectorAll(".exclude-toggle").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const item = btn.closest(".checklist-item");
        if (!item) return;
        const area = item.querySelector(".exclude-area");
        if (!area) return;
        const willOpen = area.style.display === "none";
        // Only one logger's exclusions stay open at a time.
        if (willOpen) {
          this._loggerChecklist.querySelectorAll(".exclude-area").forEach(other => {
            if (other === area) return;
            other.style.display = "none";
            const otherItem = other.closest(".checklist-item");
            const otherBtn = otherItem && otherItem.querySelector(".exclude-toggle");
            if (otherBtn) otherBtn.textContent = "+ exclusions";
          });
        }
        area.style.display = willOpen ? "block" : "none";
        btn.textContent = willOpen ? "− exclusions" : "+ exclusions";
        if (willOpen) {
          const inp = area.querySelector(".exclude-input");
          if (inp) inp.focus();
        }
      });
      // Keep the label from toggling its checkbox.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    this._loggerChecklist.querySelectorAll(".exclude-input").forEach(inp => {
      // Keep the label from toggling its checkbox; focus manually.
      inp.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        inp.focus();
      });
      inp.addEventListener("click", (e) => e.stopPropagation());
      inp.addEventListener("focus", () => this._showExcludeSuggestions(inp));
      inp.addEventListener("input", () => {
        // Clear a stale invalid flag as soon as the user edits the text.
        inp.classList.remove("exclude-invalid");
        inp.title = "";
        this._showExcludeSuggestions(inp);
      });
      inp.addEventListener("blur", () => {
        setTimeout(() => this._hideExcludeSuggestions(inp), 150);
      });
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key !== "Enter") return;
        e.preventDefault();
        const path = inp.value.trim();
        if (!path) return;
        const loggerName = inp.dataset.logger;
        if (!path.startsWith(loggerName + ".") || path.split(".").some(s => !s)) {
          inp.classList.add("exclude-invalid");
          inp.title = `Must be a child path of ${loggerName} without empty segments`;
          return;
        }
        inp.classList.remove("exclude-invalid");
        inp.title = "";
        this._addExcludeChip(inp, path);
        this._hideExcludeSuggestions(inp);
      });
    });

    this._validateRecordingSetup();
    this._loadProfiles();
    this._recordingSetupDialog.style.display = "flex";
    requestAnimationFrame(() => {
      this._recordingSetupDialog.classList.add("visible");
    });
  }

  _addExcludeChip(inp, path) {
    const loggerName = inp.dataset.logger;
    if (!path || !path.startsWith(loggerName + ".") || path.split(".").some(s => !s)) return;
    const chips = inp.closest(".exclude-area").querySelector(".exclude-chips");
    const duplicate = Array.from(chips.querySelectorAll(".exclude-chip"))
      .some(chip => chip.dataset.path === path);
    if (duplicate) {
      inp.value = "";
      return;
    }
    const chip = document.createElement("span");
    chip.className = "exclude-chip";
    chip.dataset.path = path;
    const label = document.createElement("span");
    label.textContent = path;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "exclude-chip-remove";
    rm.textContent = "\u2715";
    rm.title = "Remove exclusion";
    rm.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      chip.remove();
      this._markProfileDirty();
    });
    rm.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    chip.append(label, rm);
    chips.appendChild(chip);
    this._markProfileDirty();
    inp.value = "";
  }

  // Replace a logger item's exclusion chips with a stored profile's set.
  _setExcludeChips(item, loggerName, paths) {
    const area = item.querySelector(".exclude-area");
    const chips = area && area.querySelector(".exclude-chips");
    if (!chips) return;
    chips.innerHTML = "";
    (paths || []).forEach(path => {
      if (!path || !path.startsWith(loggerName + ".") || path.split(".").some(s => !s)) return;
      const chip = document.createElement("span");
      chip.className = "exclude-chip";
      chip.dataset.path = path;
      const label = document.createElement("span");
      label.textContent = path;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "exclude-chip-remove";
      rm.textContent = "\u2715";
      rm.title = "Remove exclusion";
      rm.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        chip.remove();
        this._markProfileDirty();
      });
      rm.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      chip.append(label, rm);
      chips.appendChild(chip);
    });
  }

  _showExcludeSuggestions(inp) {
    const box = inp.parentElement && inp.parentElement.querySelector(".exclude-options");
    if (!box) return;
    const loggerName = inp.dataset.logger;
    const query = inp.value.trim();
    const taken = new Set(
      Array.from(inp.closest(".exclude-area").querySelectorAll(".exclude-chip"))
        .map(chip => chip.dataset.path)
    );
    const matches = (this._availableLoggers || [])
      .filter(p => p.startsWith(loggerName + ".") && !taken.has(p))
      .map(p => ({ p, score: this._fuzzyScore(p, query) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    if (matches.length === 0) {
      box.style.display = "none";
      box.innerHTML = "";
      return;
    }
    box.innerHTML = matches.map(({ p }) =>
      `<div class="option-item" data-path="${this._escapeAttr(p)}">${this._highlightMatch(p, query)}</div>`
    ).join("");
    box.style.display = "block";
    box.querySelectorAll(".option-item").forEach(el => {
      el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._addExcludeChip(inp, el.dataset.path);
        this._hideExcludeSuggestions(inp);
      });
    });
  }

  _hideExcludeSuggestions(inp) {
    const box = inp.parentElement && inp.parentElement.querySelector(".exclude-options");
    if (box) {
      box.style.display = "none";
      box.innerHTML = "";
    }
  }

  _collectRecordingExcludes() {
    const excludes = {};
    const checked = this._loggerChecklist.querySelectorAll("input[type='checkbox']:checked:not(#select-all-checkbox)");
    checked.forEach(cb => {
      const loggerName = cb.dataset.logger;
      const item = cb.closest(".checklist-item");
      if (!item) return;
      const paths = Array.from(item.querySelectorAll(".exclude-chip"))
        .map(chip => chip.dataset.path)
        .filter(Boolean);
      if (paths.length > 0) excludes[loggerName] = paths;
    });
    return excludes;
  }

  _loadProfiles() {
    if (!this._hass || !this._hass.connection) {
      this._renderProfileOptions([]);
      return;
    }
    this._hass.connection.sendMessagePromise({
      type: "log_manager/profiles_get",
    }).then(res => {
      this._renderProfileOptions((res && res.profiles) || []);
    }).catch(() => {
      this._renderProfileOptions([]);
    });
  }

  // React to a profile selection. Re-choosing a modified profile reloads it,
  // after confirming that the unsaved selection changes will be replaced.
  _onProfileSelectChange() {
    const name = this._profileSelect ? this._profileSelect.value : "";
    if (name === "__modified__") return;
    this._profileDeleteBtn.disabled = !name;
    if (!name) return;
    const reload = () => {
      this._clearProfileDirty();
      this._applyProfile(name);
    };
    if (this._profileDirty) {
      this._showDeleteConfirm(
        "Reload this profile? Your current selection changes will be replaced.",
        reload,
        "Reload profile",
        "Reload",
        () => { this._profileSelect.value = "__modified__"; }
      );
    } else {
      reload();
    }
  }

  // Mark the shown profile as modified: insert a sentinel option so choosing
  // the real profile again is a value change that triggers a reload.
  _markProfileDirty() {
    if (this._profileDirty || !this._profileSelect) return;
    const current = this._profileSelect.value;
    if (!current || current === "__modified__") return;
    this._modifiedBaseName = current;
    this._profileDirty = true;
    const opt = document.createElement("option");
    opt.value = "__modified__";
    opt.textContent = `${current} *`;
    opt.title = "Settings changed since this profile was loaded";
    this._profileSelect.insertBefore(opt, this._profileSelect.firstChild);
    this._profileSelect.value = "__modified__";
    this._profileDeleteBtn.disabled = true;
  }

  _clearProfileDirty() {
    this._profileDirty = false;
    this._modifiedBaseName = "";
    if (!this._profileSelect) return;
    const opt = this._profileSelect.querySelector('option[value="__modified__"]');
    if (opt) opt.remove();
  }

  _renderProfileOptions(profiles, selectName = null) {
    if (!this._profileSelect) return;
    this._profiles = profiles;
    // A fresh render always drops the modified marker.
    this._profileDirty = false;
    this._modifiedBaseName = "";
    const hasProfiles = profiles.length > 0;
    const current = selectName != null ? selectName : this._profileSelect.value;
    const retained = profiles.some(p => p.name === current) ? current : (hasProfiles ? profiles[0].name : "");
    this._profileSelect.disabled = !hasProfiles;
    this._profileSelect.innerHTML = hasProfiles
      ? profiles.map(p =>
          `<option value="${this._escapeAttr(p.name)}">${this._escapeHtml(p.name)}</option>`
        ).join("")
      : `<option value="">No profiles yet</option>`;
    this._profileSelect.value = retained;
    this._profileDeleteBtn.disabled = !hasProfiles;
    this._profileSaveRow.style.display = "none";
    if (this._profileRow) this._profileRow.style.display = "flex";
    this._profileNameInput.value = "";
    // Whatever profile is shown must actually enable its loggers.
    if (this._profileSelect.value) {
      this._applyProfile(this._profileSelect.value);
    }
  }

  _applyProfile(name) {
    this._hass.connection.sendMessagePromise({
      type: "log_manager/profiles_get",
    }).then(res => {
      const profile = ((res && res.profiles) || []).find(p => p.name === name);
      if (!profile) return;
      const wanted = new Set(profile.loggers || []);
      const overrides = profile.level_overrides || {};
      const excludes = profile.excludes || {};
      const raises = [];
      this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)").forEach(cb => {
        const loggerName = cb.dataset.logger;
        cb.checked = wanted.has(loggerName);
        const item = cb.closest(".checklist-item");
        if (!item) return;
        const levelSelect = item.querySelector(".recording-level-select");
        if (levelSelect) {
          levelSelect.disabled = !cb.checked;
          if (cb.checked && overrides[loggerName]) {
            levelSelect.value = overrides[loggerName];
            levelSelect.dataset.prevLevel = overrides[loggerName];
            this._applyRecordingLevelStyle(levelSelect, overrides[loggerName]);
            const stateObj = this._recordingLoggerState(loggerName);
            const current = stateObj ? stateObj.state : null;
            if (stateObj && this._isMoreVerbose(overrides[loggerName], current)) {
              raises.push({
                loggerName,
                friendlyName: stateObj.attributes.friendly_name || loggerName,
                entityId: stateObj.entity_id,
                from: current,
                to: overrides[loggerName],
                selectEl: levelSelect,
              });
            }
          }
        }
        // Restore the profile's exclusion chips for this logger.
        this._setExcludeChips(item, loggerName, excludes[loggerName] || []);
        const excludeToggle = item.querySelector(".exclude-toggle");
        if (excludeToggle) excludeToggle.disabled = !cb.checked;
      });
      const selectAll = this._loggerChecklist.querySelector("#select-all-checkbox");
      if (selectAll) {
        const allChecks = this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
        selectAll.checked = allChecks.length > 0 && Array.from(allChecks).every(c => c.checked);
      }
      this._validateRecordingSetup();
      // A profile may raise several loggers: prompt per affected logger.
      this._promptRaiseSequence(raises);
    }).catch(err => console.error("Failed to load profile:", err));
  }

  _saveProfile() {
    const name = this._profileNameInput.value.trim();
    if (!name) {
      this._profileNameInput.focus();
      return;
    }
    const checkboxes = this._loggerChecklist.querySelectorAll("input[type='checkbox']:checked:not(#select-all-checkbox)");
    const loggers = [];
    const levelOverrides = {};
    checkboxes.forEach(cb => {
      const loggerName = cb.dataset.logger;
      loggers.push(loggerName);
      const levelSelect = cb.closest(".checklist-item").querySelector(".recording-level-select");
      if (levelSelect) levelOverrides[loggerName] = levelSelect.value;
    });
    if (loggers.length === 0) return;
    const excludes = this._collectRecordingExcludes();
    const proceed = () => this._sendProfileSave(name, loggers, levelOverrides, excludes);
    const existing = (this._profiles || []).some(pr => pr.name === name);
    if (existing) {
      this._showDeleteConfirm(
        `Overwrite the existing profile "${name}"?`,
        proceed,
        "Overwrite profile",
        "Overwrite"
      );
    } else {
      proceed();
    }
  }

  _sendProfileSave(name, loggers, levelOverrides, excludes) {
    this._hass.connection.sendMessagePromise({
      type: "log_manager/profile_save",
      name: name,
      loggers: loggers,
      level_overrides: levelOverrides,
      excludes: excludes || {},
      max_duration: this._recordingMaxDuration || 300,
    }).then(res => {
      // Select the saved name before rendering so the shown profile is applied,
      // keeping the checklist in sync (no stale profile re-applied).
      this._renderProfileOptions((res && res.profiles) || [], name);
      this._profileDeleteBtn.disabled = false;
    }).catch(err => console.error("Failed to save profile:", err));
  }

  _validateRecordingSetup() {
    const checked = this._loggerChecklist.querySelectorAll("input[type='checkbox']:checked:not(#select-all-checkbox)");
    this._recordingSetupStart.disabled = checked.length === 0;
  }

  // Confirm, then set every managed logger's level through the batched command.
  _applySetAll() {
    const level = this._setAllLevel.value;
    if (!level) return;
    this._showDeleteConfirm(
      `Set every managed logger to ${this._levelPillHtml(level)}? Core-pinned loggers are left untouched.`,
      () => {
        this._hass.connection.sendMessagePromise({
          type: "log_manager/set_levels",
          level: level,
        }).then(res => {
          const changed = (res && res.changed) || 0;
          const skipped = (res && res.skipped) || 0;
          if (skipped > 0) {
            this._showDeleteConfirm(
              `${changed} logger${changed === 1 ? "" : "s"} updated; ${skipped} core-pinned ${skipped === 1 ? "logger was" : "loggers were"} left untouched.`,
              () => {},
              "Set all levels",
              "OK"
            );
          }
          this._updateActiveList();
        }).catch(err => console.error("Failed to set all levels:", err));
      },
      "Set all levels",
      "Apply",
      null,
      true
    );
  }

  _startRecording(loggers, levelOverrides, excludes) {
    this._recordingState = "recording";
    this._recordingStartTime = Date.now();
    this._recordingLoggers = loggers;
    this._recordingLevelOverrides = levelOverrides || {};
    this._recordingBuffer = [];
    this._recordingDuration = 0;
    this._recordingLogCount = 0;
    this._recordingCounts = {};
    this._recordingBackendCount = 0;
    this._liveLastId = 0;
    this._resetDedupState();
    this._resultsShown = false;
    this._hideResultsSummary();
    this._selectedKeys.clear();
    this._selectionAnchorRow = null;
    if (this._livePreview) this._livePreview.innerHTML = "";

    // Apply raise intents recorded at selection/profile-load time and remember
    // the original levels so the session end can restore them. The same intents
    // are sent to the backend, which owns the revert if the card disappears.
    this._recordingRestoreLevels = {};
    const raiseIntents = this._recordingRaiseIntents || {};
    const raiseLevels = {};
    Object.keys(raiseIntents).forEach(loggerName => {
      if (!loggers.includes(loggerName)) return;
      const intent = raiseIntents[loggerName];
      this._recordingRestoreLevels[loggerName] = {
        entityId: intent.entityId,
        level: intent.from,
        raisedTo: intent.to,
      };
      raiseLevels[loggerName] = {
        entity_id: intent.entityId,
        from: intent.from,
        to: intent.to,
      };
      this._hass.callService("select", "select_option", {
        entity_id: intent.entityId,
        option: intent.to,
      });
    });
    this._recordingRaiseIntents = {};
    if (this._liveLoggerFilter) this._liveLoggerFilter.value = "";
    if (this._liveLevelFilter) this._liveLevelFilter.value = "ALL";

    this._updateRecordingUI();

    this._recordingTimerInterval = setInterval(() => {
      this._updateRecordingUI();
      this._pollRecordingStatus();
    }, 1000);

    this._hass.connection.sendMessagePromise({
      type: "log_manager/start_recording",
      loggers: loggers,
      max_duration: 300,
      level_overrides: levelOverrides || {},
      excludes: excludes || {},
      raise_levels: raiseLevels,
    }).then(res => {
      this._recordingMaxDuration = (res && res.max_duration) || 300;
      this._openLiveView();
    }).catch(err => {
      console.error("Failed to start recording:", err);
      this._recordingState = null;
      this._cleanupRecordingIntervals();
      this._restoreRecordingLevels();
      this._recordingCounts = {};
      this._updateRecordingUI();
    });
  }

  _stopRecording() {
    this._cleanupRecordingIntervals();
    this._cleanupLivePolling();
    this._recordingState = "stopping";
    this._updateRecordingUI();

    this._hass.connection.sendMessagePromise({
      type: "log_manager/stop_recording",
    }).then(res => {
      if (res && res.logs) {
        this._recordingBuffer = res.logs;
        this._recordingDuration = res.duration || 0;
        this._recordingLogCount = res.log_count || 0;
        this._recordingBackendCount = res.log_count || 0;
        this._recordingState = "results";
        this._recordingCounts = {};
        this._restoreRecordingLevels();
        this._showRecordingResults();
      }
    }).catch(err => {
      console.error("Failed to stop recording:", err);
      this._restoreRecordingLevels();
      this._recordingState = null;
      this._recordingCounts = {};
      this._updateRecordingUI();
    });
  }

  _pollRecordingStatus() {
    if (this._recordingState !== "recording") return;
    this._hass.connection.sendMessagePromise({
      type: "log_manager/recording_status"
    }).then(status => {
      this._recordingCounts = status.logger_counts || {};
      this._recordingBackendCount = status.log_count || 0;
      if (status.max_duration) {
        this._recordingMaxDuration = status.max_duration;
      }
      if (status.status === "completed") {
        this._cleanupRecordingIntervals();
        this._cleanupLivePolling();
        this._recordingState = "completed";
        this._recordingLogCount = status.log_count || 0;
        this._recordingBackendCount = status.log_count || 0;
        this._recordingDuration = Math.round(status.elapsed || 0);
        this._restoreRecordingLevels();
        if (this._liveViewOpen) {
          this._fetchResults();
        }
        this._updateRecordingUI();
      }
    }).catch(() => {});
  }

  _groupConsecutiveDedup(ordered) {
    const runs = [];
    let run = null;
    const flush = () => {
      if (run) {
        runs.push(run);
        run = null;
      }
    };
    for (const entry of ordered) {
      const key = this._dedupKey(entry);
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

  _resultsLineHtml(entry) {
    const time = new Date(entry.timestamp * 1000).toLocaleTimeString(
      this._locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    );
    const level = entry.level;
    const colors = this._levelColors(level);
    const logger = this._loggerCellHtml(entry.logger);
    const msg = this._escapeHtml(entry.message);
    return `<div class="log-preview-line selectable-entry" data-id="${entry.id}" data-sel-keys="${this._escapeAttr(JSON.stringify([this._entryKey(entry)]))}" draggable="false" data-logger="${this._escapeAttr(entry.logger)}" data-level="${this._escapeAttr(level)}" data-key="${this._escapeAttr(this._dedupKey(entry))}" style="background: ${colors.rowBg};">
      <span class="log-preview-col idx-col">${entry.id + 1}</span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${this._escapeHtml(level)}</span>
      <span class="log-preview-col time-col">${time}</span>
      <span class="log-preview-col logger-col" title="${this._escapeAttr(entry.logger)}">${logger}</span>
      <span class="log-preview-col msg-col">${msg}</span>
    </div>`;
  }

  _resultsGroupHtml(run) {
    const colors = this._levelColors(run.level);
    // Results groups start collapsed; live expansions don't transfer.
    const expanded = this._expandedDedupKeys.has(run.key);
    return `<div class="log-preview-group selectable-entry" data-sel-keys="${this._escapeAttr(JSON.stringify(this._runKeys(run)))}" draggable="false" data-logger="${this._escapeAttr(run.logger)}" data-level="${this._escapeAttr(run.level)}" data-key="${this._escapeAttr(run.key)}" data-first-id="${run.firstId}" data-count="${run.count}" data-ids="${this._escapeAttr(run.ids.join(","))}" style="background: ${colors.rowBg};" title="Identical entries grouped — expand to see each occurrence">
      ${this._dedupRowInnerHtml(run, colors)}
    </div><div class="log-preview-group-items" style="display: ${expanded ? "" : "none"};">${this._dedupItemsInnerHtml(run)}</div>`;
  }

  _rebuildResultsPreview() {
    const container = this._livePreview;
    if (!container) return;
    if (this._recordingBuffer.length === 0) {
      // The summary owns the single empty-state message; leave the table blank.
      container.innerHTML = "";
      return;
    }
    const levelFilter = this._liveLevelFilter.value;
    const loggerFilter = this._liveLoggerFilter.value;
    let html = this._previewHeaderHtml();
    // Results render oldest-first, matching the live view, so a group's first
    // id is its first chronological entry in both views.
    const ordered = this._recordingBuffer.slice();
    if (!this._isDedupEnabled()) {
      ordered.forEach(entry => {
        html += this._resultsLineHtml(entry);
      });
    } else {
      // Filters apply so the visible stream groups the same way it does live.
      for (const run of this._groupConsecutiveDedup(ordered)) {
        if (!this._entryMatchesFilter({ logger: run.logger, level: run.level }, levelFilter, loggerFilter)) continue;
        html += run.count === 1 ? this._resultsLineHtml(run.first) : this._resultsGroupHtml(run);
      }
    }
    container.innerHTML = html;
    this._applyColumnWidths();
    this._wireColumnResize();
    // The preview DOM was replaced: live trackers reference detached nodes.
    this._liveLastGroup = null;
    this._liveLastSingle = null;
    container.querySelectorAll(".log-preview-group").forEach(row => {
      const items = row.nextElementSibling;
      if (!items || !items.classList.contains("log-preview-group-items")) return;
      this._wireDedupToggle(row, items, row.dataset.key);
    });
    this._refreshSelection(container);
    container.scrollTop = 0;
  }

  _summarizeResults(logs) {
    const severityOrder = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
    const severity = {};
    const loggers = {};
    const repeats = {};
    for (const entry of logs) {
      severity[entry.level] = (severity[entry.level] || 0) + 1;
      const root = this._managedRootFor(entry.logger);
      loggers[root] = (loggers[root] || 0) + 1;
      const key = this._dedupKey(entry);
      if (!repeats[key]) {
        repeats[key] = {
          key,
          logger: root,
          level: entry.level,
          message: entry.message,
          count: 0,
        };
      }
      repeats[key].count += 1;
    }
    const top = (rows, limit) => {
      // Code-unit tie-break: locale-independent so top-5 picks are stable.
      const sorted = rows.slice().sort((a, b) => b.count - a.count || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
      return { top: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) };
    };
    const loggerRows = Object.entries(loggers).map(([name, count]) => (
      { label: name, logger: name, count, sortKey: name }
    ));
    const repeatRows = Object.values(repeats).map(row => ({ ...row, sortKey: row.key }));
    return {
      total: logs.length,
      severity: severityOrder
        .filter(level => severity[level] > 0)
        .map(level => ({ level, count: severity[level] }))
        // Non-standard levels (e.g. NOTSET) trail after the ordered ones.
        .concat(Object.keys(severity).filter(level => !severityOrder.includes(level)).sort().map(level => ({ level, count: severity[level] }))),
      loggers: top(loggerRows, 5),
      repeats: top(repeatRows, 5),
    };
  }

  _ensureResultsSummaryEl() {
    const host = this._livePreview && this._livePreview.parentElement;
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
    if (this._liveSummary && this._liveSummary.parentElement === host) {
      host.insertBefore(el, this._liveSummary.nextSibling);
    }
    return el;
  }

  _hideResultsSummary() {
    const host = this._livePreview && this._livePreview.parentElement;
    const el = host && host.querySelector("#results-summary");
    if (el) el.style.display = "none";
  }

  // Read-only summary rendered as a table-like block below the results.
  _renderResultsSummary() {
    const el = this._ensureResultsSummaryEl();
    if (!el) return;
    // The summary follows the active results filter, matching the table.
    const levelFilter = this._liveLevelFilter ? this._liveLevelFilter.value : "ALL";
    const loggerFilter = this._liveLoggerFilter ? this._liveLoggerFilter.value : "";
    const visible = this._recordingBuffer.filter(entry =>
      this._entryMatchesFilter(entry, levelFilter, loggerFilter)
    );
    const summary = this._summarizeResults(visible);
    if (summary.total === 0) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    const esc = (s) => this._escapeHtml(String(s == null ? "" : s));
    const escAttr = (s) => this._escapeAttr(String(s == null ? "" : s));
    const friendly = (name) => {
      const stateObj = Object.values((this._hass && this._hass.states) || {}).find(
        s => s.attributes.logger_name === name
      );
      return stateObj ? (stateObj.attributes.friendly_name || name) : name;
    };
    const sevLine = summary.severity.map(({ level, count }) => {
      const colors = this._levelColors(level);
      return `<span style="color: ${colors.color};">${esc(level)} ${count}</span>`;
    }).join(" · ");
    const loggerRows = summary.loggers.top.map(({ logger, count }) =>
      `<div class="summary-row"><span class="summary-label" title="${escAttr(logger)}">${esc(friendly(logger))}</span><span class="summary-count">${count}</span></div>`
    ).join("") + (summary.loggers.more > 0 ? `<div class="results-summary-more">+${summary.loggers.more} more</div>` : "");
    const repeatRows = summary.repeats.top.map(({ logger, level, message, count }) => {
      const text = String(message == null ? "" : message);
      const short = text.length > 80 ? text.slice(0, 80) + "…" : text;
      return `<div class="summary-row" title="${escAttr(text)}"><span class="summary-label">${esc(friendly(logger))} ${esc(level)}</span><span class="summary-message">${esc(short)}</span><span class="summary-count">×${count}</span></div>`;
    }).join("") + (summary.repeats.more > 0 ? `<div class="results-summary-more">+${summary.repeats.more} more</div>` : "");
    el.innerHTML = `
      <div class="summary-title">Summary</div>
      <div class="summary-sev-line">${sevLine}</div>
      <div class="summary-section-title">Loggers</div>
      ${loggerRows}
      <div class="summary-section-title">Most repeated messages</div>
      ${repeatRows}`;
    el.style.display = "";
  }

  _showRecordingResults() {
    const logs = this._recordingBuffer;
    const duration = this._recordingDuration;
    const count = this._recordingLogCount;
    const hasEntries = count > 0;

    // Hide live top bar, show completed state.
    if (this._liveDialogTitle) this._liveDialogTitle.textContent = "Recording results";
    this._liveStatusText.parentElement.style.display = "none";
    this._livePauseBtn.style.display = "none";
    this._liveStopBtn.style.display = "none";
    this._liveCloseBtn.textContent = "Close";
    this._liveCloseBtn.title = "The recorded data stays available until you discard it.";
    this._liveClearBtn.style.display = "none";
    this._liveDiscardBtn.style.display = "";
    // Keep the grouping toggle visible and synced with the results setting.
    if (this._recordingDedupToggle) this._recordingDedupToggle.checked = this._isDedupEnabled();

    this._updateExportButtonState();
    this._liveSummary.textContent = hasEntries
      ? `Recorded ${count} log entr${count === 1 ? "y" : "ies"} over ${duration} second${duration === 1 ? "" : "s"}.`
      : `No log events matched the configured levels during this session.`;

    if (hasEntries) {
      // Live expansions don't transfer: results groups start collapsed.
      this._expandedDedupKeys.clear();
      this._rebuildResultsPreview();
      this._renderResultsSummary();
    } else {
      this._hideResultsSummary();
      // The summary owns the single empty-state message; leave the table blank.
      this._livePreview.innerHTML = "";
    }
    this._resultsShown = true;
    this._livePreview.scrollTop = 0;
    this._liveViewOpen = false;
    this._recordingLiveDialog.style.display = "flex";
    requestAnimationFrame(() => {
      this._recordingLiveDialog.classList.add("visible");
    });
  }

  _closeLiveView() {
    this._cleanupLivePolling();
    this._liveViewOpen = false;
    this._resultsShown = false;
    this._hideResultsSummary();
    this._recordingLiveDialog.classList.remove("visible");
    this._recordingLiveDialog.style.display = "none";
    // Restore live top bar state for next open. Filter, entries, and scroll
    // position are preserved so reopening the view restores the same state.
    this._liveStatusText.parentElement.style.display = "flex";
    this._livePauseBtn.style.display = "";
    this._liveStopBtn.style.display = "";
    this._livePaused = false;
    this._pausedEntries = [];
    // A completed recording stays available until explicitly discarded.
    if (this._recordingState === "results") {
      this._recordingState = "completed";
    }
    this._updateRecordingUI();
  }

  _downloadLogs(format) {
    const logs = this._recordingBuffer;
    const dateStr = this._formatFileTimestamp(new Date());

    let content, filename, mimeType;

    if (format === "plain") {
      const lines = logs.map(entry => {
        const time = this._formatDateTime(entry.timestamp);
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

  _copyLogsToClipboard() {
    const logs = this._recordingBuffer;
    if (!logs || logs.length === 0) return;
    const selected = logs.filter(entry => this._selectedKeys.has(this._entryKey(entry)));
    const toCopy = selected.length > 0 ? selected : logs;
    const text = toCopy.map(entry => {
      const time = this._formatDateTime(entry.timestamp);
      const level = entry.level.padEnd(8);
      const src = entry.source ? ` (${entry.source})` : "";
      return `[${time}] ${level} ${entry.logger}  ${entry.message}${src}`;
    }).join("\n") + "\n";

    navigator.clipboard.writeText(text).then(() => {
      const original = this._liveCopyBtn.textContent;
      this._liveCopyBtn.textContent = "Copied!";
      setTimeout(() => { this._liveCopyBtn.textContent = original; }, 2000);
    }).catch(err => {
      console.error("Failed to copy:", err);
    });
  }

  _checkExistingRecording() {
    if (!this._hass) return;
    this._hass.connection.sendMessagePromise({
      type: "log_manager/recording_status"
    }).then(status => {
      if (status.status === "recording") {
        this._recordingState = "recording";
        this._recordingStartTime = Date.now() - Math.round((status.elapsed || 0) * 1000);
        this._recordingLoggers = status.loggers || [];
        this._recordingMaxDuration = status.max_duration || 300;
        this._recordingCounts = status.logger_counts || {};
        // Adopt the session's pending level reverts so a reloaded card keeps
        // showing "Raised to X" and can restore the levels when the session ends.
        this._recordingRestoreLevels = {};
        Object.entries(status.level_restore || {}).forEach(([loggerName, intent]) => {
          this._recordingRestoreLevels[loggerName] = {
            entityId: intent.entity_id,
            level: intent.from,
            raisedTo: intent.to,
          };
        });
        this._recordingTimerInterval = setInterval(() => {
          this._updateRecordingUI();
          this._pollRecordingStatus();
        }, 1000);
        this._updateRecordingUI();
      } else if (status.status === "completed") {
        this._recordingState = "completed";
        this._recordingLogCount = status.log_count || 0;
        this._recordingBackendCount = status.log_count || 0;
        this._recordingDuration = Math.round(status.elapsed || 0);
        this._recordingCounts = status.logger_counts || {};
        this._updateRecordingUI();
      }
    }).catch(() => {});
  }

  _fetchResults() {
    this._hass.connection.sendMessagePromise({
      type: "log_manager/stop_recording",
    }).then(res => {
      if (res && res.logs) {
        this._recordingBuffer = res.logs;
        this._recordingDuration = res.duration || 0;
        this._recordingLogCount = res.log_count || 0;
        this._recordingBackendCount = res.log_count || 0;
        this._recordingState = "results";
        this._showRecordingResults();
      }
    }).catch(err => {
      console.error("Failed to fetch recording results:", err);
      this._recordingState = null;
      this._updateRecordingUI();
    });
  }

  _cleanupRecordingIntervals() {
    if (this._recordingTimerInterval) {
      clearInterval(this._recordingTimerInterval);
      this._recordingTimerInterval = null;
    }
  }

  _updateRecordingCountBadge(row, loggerName, count, isRecording) {
    let container = row.querySelector(".counter-badges");
    let badge = container ? container.querySelector(".recording-count-badge") : null;

    if (isRecording && count > 0) {
      const stateObj = this._hass && Object.values(this._hass.states).find(
        s => s.attributes.logger_name === loggerName
      );
      const friendlyName = stateObj ? (stateObj.attributes.friendly_name || loggerName) : loggerName;
      const title = `${count} entries recorded for ${friendlyName}`;
      const attachClickListener = (el) => {
        if (el.dataset.recBadgeHandler) return;
        el.dataset.recBadgeHandler = "true";
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          this._openLiveView(loggerName);
        });
      };
      if (badge) {
        badge.textContent = `\u{1F4DD} ${count}`;
        badge.title = title;
        attachClickListener(badge);
      } else {
        if (!container) {
          container = document.createElement("div");
          container.className = "counter-badges";
          const wrapper = row.querySelector(".log-controls-wrapper");
          wrapper.insertBefore(container, wrapper.querySelector(".log-controls"));
        }
        badge = document.createElement("span");
        badge.className = "counter-badge recording-count-badge";
        badge.title = title;
        badge.textContent = `\u{1F4DD} ${count}`;
        attachClickListener(badge);
        container.appendChild(badge);
      }
    } else if (badge) {
      badge.remove();
      if (container && container.children.length === 0) {
        container.remove();
      }
    }
  }

  _cleanupLivePolling() {
    if (this._livePollInterval) {
      clearInterval(this._livePollInterval);
      this._livePollInterval = null;
    }
  }

  _openLiveView(initialLogger) {
    this._liveViewOpen = true;
    this._livePaused = false;
    this._pausedEntries = [];
    this._resultsShown = false;
    this._hideResultsSummary();
    if (this._liveDialogTitle) this._liveDialogTitle.textContent = "Live recording";
    if (this._recordingDedupToggle) this._recordingDedupToggle.checked = this._isDedupEnabled();

    // Preserve the previous filter selection unless a specific logger was
    // requested (e.g. from the recording-count badge).
    const prevLoggerFilter = this._liveLoggerFilter.value;
    const prevLevelFilter = this._liveLevelFilter.value;

    // Build logger filter dropdown.
    let filterHtml = '<option value="">All loggers</option>';
    this._recordingLoggers.forEach(name => {
      const stateObj = Object.values(this._hass.states).find(
        s => s.attributes.logger_name === name
      );
      const label = stateObj ? (stateObj.attributes.friendly_name || name) : name;
      filterHtml += `<option value="${this._escapeAttr(name)}">${this._escapeHtml(label)}</option>`;
    });
    this._liveLoggerFilter.innerHTML = filterHtml;
    this._liveLoggerFilter.value = initialLogger || prevLoggerFilter;
    this._liveLevelFilter.value = initialLogger ? "ALL" : prevLevelFilter;

    // Show top bar with live controls.
    this._liveStatusText.parentElement.style.display = "flex";
    this._livePauseBtn.style.display = "";
    this._livePauseBtn.textContent = "Pause";
    this._livePauseBtn.classList.remove("paused");
    this._livePauseBtn.title = "Pause viewer update";
    this._liveStopBtn.style.display = "";
    this._liveCloseBtn.textContent = "Close & keep recording";
    this._liveCloseBtn.title = "Close this window; the recording continues in the background.";
    this._liveClearBtn.style.display = "";
    this._liveDiscardBtn.style.display = "none";
    this._updateExportButtonState();

    this._updateLiveTimer();

    if (initialLogger) {
      this._applyLiveFilters();
      this._livePreview.scrollTop = 0;
    }
    this._updateLiveSummary();

    this._recordingLiveDialog.style.display = "flex";
    requestAnimationFrame(() => {
      this._recordingLiveDialog.classList.add("visible");
    });

    // Poll continuously; a paused view still refreshes the summary but skips
    // rebuilding the row list until it resumes.
    this._pollRecordingEntries();
    this._livePollInterval = setInterval(() => {
      this._pollRecordingEntries();
      this._updateLiveTimer();
    }, 1000);
  }

  _updateLiveTimer() {
    if (!this._recordingLiveDialog) return;
    if (this._recordingState === "recording") {
      const elapsed = Math.floor((Date.now() - this._recordingStartTime) / 1000);
      const remaining = Math.max(0, this._recordingMaxDuration - elapsed);
      const mins = String(Math.floor(remaining / 60)).padStart(2, "0");
      const secs = String(remaining % 60).padStart(2, "0");
      this._liveTimer.textContent = `${mins}:${secs} remaining`;
      this._liveStatusText.textContent = this._livePaused ? "Recording · view paused" : "Recording";
      this._liveStatusDot.style.display = "";
    } else {
      this._liveTimer.textContent = "";
      this._liveStatusText.textContent = "Recording complete";
      this._liveStatusDot.style.display = "none";
    }
  }

  _pollRecordingEntries() {
    if (this._recordingState !== "recording" && this._recordingState !== "completed") return;
    this._hass.connection.sendMessagePromise({
      type: "log_manager/recording_entries",
      after_id: this._liveLastId,
    }).then(res => {
      if (!res || !res.entries) return;
      const entries = res.entries;
      if (entries.length === 0) {
        this._updateLiveSummary();
        return;
      }

      // Store in recordingBuffer for export.
      for (const entry of entries) {
        this._recordingBuffer.push(entry);
      }

      this._liveLastId = res.next_id || 0;
      // While paused the summary (entry count, buffer fill) stays live but the
      // row list does not; the skipped rows replay on resume.
      if (this._livePaused) {
        this._pausedEntries.push(...entries);
      } else {
        this._appendLiveEntries(entries);
      }
      this._updateLiveSummary();
    }).catch(() => {});
  }

  _dedupKey(entry) {
    return `${entry.logger}${entry.level}${entry.message}${entry.source || ""}`;
  }

  _isDedupEnabled() {
    if (this._liveDedupOverride !== null && this._liveDedupOverride !== undefined) {
      return this._liveDedupOverride;
    }
    return !this.config || this.config.live_dedup !== false;
  }

  _dedupMinute(ts) {
    return new Date(ts * 1000).toLocaleTimeString(
      this._locale(), { hour: "2-digit", minute: "2-digit", hour12: false }
    );
  }

  _dedupRangeText(firstTs, lastTs) {
    const first = this._dedupMinute(firstTs);
    const last = this._dedupMinute(lastTs);
    return first === last ? first : `${first}–${last}`;
  }

  _dedupRowInnerHtml(run, colors) {
    const logger = this._loggerCellHtml(run.logger);
    const msg = this._escapeHtml(run.message);
    const chevron = this._expandedDedupKeys.has(run.key) ? "\u25BE" : "\u25B8";
    return `<span class="log-preview-col idx-col"><button type="button" class="dedup-toggle" title="Expand or collapse this group">${chevron}</button><span class="dedup-count">×${run.count}</span><span class="dedup-first-id">#${run.firstId + 1}</span></span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${this._escapeHtml(run.level)}</span>
      <span class="log-preview-col time-col">${this._dedupRangeText(run.firstTs, run.lastTs)}</span>
      <span class="log-preview-col logger-col" title="${this._escapeAttr(run.logger)}">${logger}</span>
      <span class="log-preview-col msg-col">${msg}</span>`;
  }

  // Expanded group rows repeat the full row so each occurrence stays readable
  // and severity-coloured (identical fields included). Indented and dimmed
  // relative to the group header.
  _dedupItemsInnerHtml(run) {
    const colors = this._levelColors(run.level);
    const logger = this._loggerCellHtml(run.logger);
    const msg = this._escapeHtml(run.message);
    const keys = this._runKeys(run);
    return run.times.map((ts, i) => {
      const time = new Date(ts * 1000).toLocaleTimeString(
        this._locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
      );
      const id = run.ids && run.ids[i] != null ? run.ids[i] + 1 : "";
      return `<div class="log-preview-group-item selectable-entry" data-sel-keys="${this._escapeAttr(JSON.stringify(keys[i] ? [keys[i]] : []))}" draggable="false" style="background: ${colors.rowBg}; border-left: 2px solid ${colors.color}; margin-left: 24px;">
        <span class="log-preview-col idx-col">${id}</span>
        <span class="log-preview-col level-col" style="color: ${colors.color};">${this._escapeHtml(run.level)}</span>
        <span class="log-preview-col time-col">${time}</span>
        <span class="log-preview-col logger-col" title="${this._escapeAttr(run.logger)}">${logger}</span>
        <span class="log-preview-col msg-col">${msg}</span>
      </div>`;
    }).join("");
  }

  // Only the chevron toggles a group, so the row text stays selectable.
  _wireDedupToggle(row, items, key) {
    const btn = row.querySelector(".dedup-toggle");
    if (!btn) return;
    const toggle = () => {
      const expanded = items.style.display === "none";
      items.style.display = expanded ? "" : "none";
      const chevron = row.querySelector(".dedup-toggle");
      if (chevron) chevron.textContent = expanded ? "\u25BE" : "\u25B8";
      if (expanded) {
        this._expandedDedupKeys.add(key);
      } else {
        this._expandedDedupKeys.delete(key);
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

  _startDedupGroup(container, firstEntry, secondEntry) {
    const run = {
      key: this._dedupKey(firstEntry),
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
    const colors = this._levelColors(run.level);
    const row = document.createElement("div");
    row.className = "log-preview-group selectable-entry";
    row.draggable = false;
    row.dataset.selKeys = JSON.stringify(this._runKeys(run));
    row.dataset.logger = run.logger;
    row.dataset.level = run.level;
    row.dataset.key = run.key;
    row.dataset.firstId = String(run.firstId);
    row.dataset.count = String(run.count);
    row.dataset.ids = run.ids.join(",");
    row.style.background = colors.rowBg;
    row.title = "Identical entries grouped — expand to see each occurrence";
    row.innerHTML = this._dedupRowInnerHtml(run, colors);
    const items = document.createElement("div");
    items.className = "log-preview-group-items";
    items.style.display = this._expandedDedupKeys.has(run.key) ? "" : "none";
    items.innerHTML = this._dedupItemsInnerHtml(run);
    this._wireDedupToggle(row, items, run.key);
    container.appendChild(row);
    container.appendChild(items);
    return { key: run.key, row, items, run };
  }

  _bumpDedupGroup(group, entry) {
    const run = group.run;
    run.count += 1;
    run.lastTs = entry.timestamp;
    run.ids.push(entry.id);
    run.times.push(entry.timestamp);
    const colors = this._levelColors(run.level);
    group.row.dataset.count = String(run.count);
    group.row.dataset.ids = run.ids.join(",");
    group.row.dataset.selKeys = JSON.stringify(this._runKeys(run));
    group.row.innerHTML = this._dedupRowInnerHtml(run, colors);
    // innerHTML replaced the toggle button, so re-wire it and keep state.
    this._wireDedupToggle(group.row, group.items, run.key);
    group.items.innerHTML = this._dedupItemsInnerHtml(run);
    group.items.style.display = this._expandedDedupKeys.has(run.key) ? "" : "none";
    this._refreshSelection(group.row.parentElement || this._livePreview);
  }

  // Render one flat (ungrouped) preview row. Selection keys are stored on the
  // element so the explicit selection survives rebuilds.
  _appendFlatEntry(container, entry) {
    const time = new Date(entry.timestamp * 1000).toLocaleTimeString(
      this._locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    );
    const level = entry.level;
    const colors = this._levelColors(level);
    const logger = this._loggerCellHtml(entry.logger);
    const msg = this._escapeHtml(entry.message);
    const div = document.createElement("div");
    div.className = "log-preview-line selectable-entry";
    div.draggable = false;
    div.dataset.selKeys = JSON.stringify([this._entryKey(entry)]);
    div.dataset.logger = entry.logger;
    div.dataset.level = level;
    div.dataset.key = this._dedupKey(entry);
    div.dataset.id = entry.id;
    div.style.background = colors.rowBg;
    div.innerHTML = `<span class="log-preview-col idx-col">${entry.id + 1}</span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${level}</span>
      <span class="log-preview-col time-col">${time}</span>
      <span class="log-preview-col logger-col" title="${this._escapeAttr(entry.logger)}">${logger}</span>
      <span class="log-preview-col msg-col">${msg}</span>`;
    container.appendChild(div);
    return div;
  }

  _appendDedupEntry(container, entry) {
    const key = this._dedupKey(entry);
    if (this._liveLastGroup && this._liveLastGroup.key === key) {
      this._bumpDedupGroup(this._liveLastGroup, entry);
      this._liveLastSingle = null;
      return;
    }
    if (this._liveLastSingle && this._liveLastSingle.key === key) {
      const first = this._liveLastSingle;
      const group = this._startDedupGroup(container, first.entry, entry);
      first.el.remove();
      this._liveLastGroup = group;
      this._liveLastSingle = null;
      return;
    }
    const div = this._appendFlatEntry(container, entry);
    this._liveLastSingle = { key, el: div, entry };
    this._liveLastGroup = null;
  }

  _rebuildLivePreview() {
    const container = this._livePreview;
    if (!container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 20;
    const prevTop = container.scrollTop;
    const levelFilter = this._liveLevelFilter.value;
    const loggerFilter = this._liveLoggerFilter.value;
    container.innerHTML = "";
    this._ensurePreviewHeader();
    this._liveLastGroup = null;
    this._liveLastSingle = null;
    if (this._isDedupEnabled()) {
      for (const entry of this._recordingBuffer) {
        if (!this._entryMatchesFilter(entry, levelFilter, loggerFilter)) continue;
        this._appendDedupEntry(container, entry);
      }
    } else {
      for (const entry of this._recordingBuffer) {
        const div = this._appendFlatEntry(container, entry);
        div.style.display = this._entryMatchesFilter(entry, levelFilter, loggerFilter) ? "" : "none";
      }
    }
    this._refreshSelection(container);
    if (atBottom) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTop = Math.min(prevTop, container.scrollHeight);
    }
  }

  _resetDedupState() {
    this._liveLastGroup = null;
    this._liveLastSingle = null;
    this._expandedDedupKeys.clear();
    this._selectedKeys.clear();
    this._selectionAnchorRow = null;
  }

  _appendLiveEntries(entries) {
    const container = this._livePreview;
    this._ensurePreviewHeader();
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 20;

    const levelFilter = this._liveLevelFilter.value;
    const loggerFilter = this._liveLoggerFilter.value;
    const dedup = this._isDedupEnabled();

    for (const entry of entries) {
      if (dedup) {
        // Filter-hidden entries skip the DOM entirely: they neither render
        // nor break visible runs, so groups reflect the visible stream.
        if (!this._entryMatchesFilter(entry, levelFilter, loggerFilter)) continue;
        this._appendDedupEntry(container, entry);
        continue;
      }
      const div = this._appendFlatEntry(container, entry);
      // Apply current filters so the filter controls can re-show rows in place.
      div.style.display = this._entryMatchesFilter(entry, levelFilter, loggerFilter) ? "" : "none";
    }
    this._refreshSelection(container);

    if (atBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  _loadColumnWidths() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem("log_manager_col_widths") || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Corrupt/unavailable storage: fall back to the CSS defaults.
    }
    return {};
  }

  _persistColumnWidths() {
    try {
      window.localStorage.setItem("log_manager_col_widths", JSON.stringify(this._colWidths || {}));
    } catch {
      // Storage unavailable: widths just won't persist.
    }
  }

  _applyColumnWidths() {
    if (!this._livePreview || !this._livePreview.style || !this._livePreview.style.setProperty) return;
    const w = this._colWidths || {};
    const set = (name, value) => {
      if (value) this._livePreview.style.setProperty(`--col-${name}`, `${value}px`);
    };
    set("idx", w.idx);
    set("level", w.level);
    set("time", w.time);
    set("logger", w.logger);
  }

  _wireColumnResize() {
    if (!this._livePreview || typeof this._livePreview.querySelectorAll !== "function") return;
    const kinds = ["idx", "level", "time", "logger"];
    this._livePreview.querySelectorAll(".log-preview-header .log-preview-col").forEach(cell => {
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
          this._colWidths[kind] = Math.max(40, Math.round(startW + (ev.clientX - startX)));
          this._applyColumnWidths();
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          this._persistColumnWidths();
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

  _previewHeaderHtml() {
    return `<div class="log-preview-header">
      <span class="log-preview-col idx-col">#</span>
      <span class="log-preview-col level-col">Level</span>
      <span class="log-preview-col time-col">Time</span>
      <span class="log-preview-col logger-col">Logger</span>
      <span class="log-preview-col msg-col">Message</span>
    </div>`;
  }

  _ensurePreviewHeader() {
    if (!this._livePreview.querySelector(".log-preview-header")) {
      this._livePreview.insertAdjacentHTML("afterbegin", this._previewHeaderHtml());
    }
    this._applyColumnWidths();
    this._wireColumnResize();
  }

  _entryMatchesFilter(entry, levelFilter, loggerFilter) {
    // Exact match only: selecting a logger must not also show its children's
    // entries. Child loggers are reachable via "All loggers".
    if (loggerFilter && entry.logger !== loggerFilter) {
      return false;
    }
    if (levelFilter && levelFilter !== "ALL") {
      const levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
      const minIdx = levels.indexOf(levelFilter);
      const entryIdx = levels.indexOf(entry.level);
      if (entryIdx < minIdx) return false;
    }
    return true;
  }

  _applyLiveFilters() {
    if (this._isDedupEnabled()) {
      // Visible-stream grouping: regroup so hidden entries no longer split
      // identical visible runs. Results render newest-first, live oldest-first.
      if (this._resultsShown) {
        this._rebuildResultsPreview();
      } else {
        this._rebuildLivePreview();
      }
      if (this._resultsShown) this._renderResultsSummary();
      return;
    }
    const levelFilter = this._liveLevelFilter.value;
    const loggerFilter = this._liveLoggerFilter.value;
    this._livePreview.querySelectorAll(".log-preview-line").forEach(el => {
      el.style.display = this._entryMatchesFilter(
        { logger: el.dataset.logger, level: el.dataset.level },
        levelFilter,
        loggerFilter
      ) ? "" : "none";
    });
    // The summary follows the filter on the flat path too.
    if (this._resultsShown) this._renderResultsSummary();
  }

  _togglePauseLive() {
    this._livePaused = !this._livePaused;
    this._livePauseBtn.textContent = this._livePaused ? "Resume" : "Pause";
    this._livePauseBtn.classList.toggle("paused", this._livePaused);
    this._livePauseBtn.title = this._livePaused ? "View paused — click to resume" : "Pause viewer update";
    if (this._recordingState === "recording") {
      this._liveStatusText.textContent = this._livePaused ? "Recording · view paused" : "Recording";
    }
    if (this._livePaused) {
      return;
    }
    // Replay rows captured while paused, then poll for anything newer.
    if (this._pausedEntries.length > 0) {
      const pending = this._pausedEntries;
      this._pausedEntries = [];
      this._appendLiveEntries(pending);
    }
    this._pollRecordingEntries();
  }

  _locale() {
    return (this._hass && this._hass.locale && this._hass.locale.language) || undefined;
  }

  // Display position of a level token in a selector. ALL is the catch-all
  // floor and sits before DEBUG, so it is always "more verbose" and never -1.
  _levelIndex(level) {
    return ["ALL", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"].indexOf(level);
  }

  // Severity position of an emitted entry. Entries carry their numeric level;
  // older buffers without one fall back to the level name. Never use
  // _levelIndex for entries: it is a display mapping, not a severity ranking.
  _entrySeverity(level, levelno) {
    if (typeof levelno === "number" && !Number.isNaN(levelno)) return levelno;
    const byName = {
      DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50,
    };
    return byName[level] != null ? byName[level] : -1;
  }

  // Numeric comparator for captured entries, ascending by severity.
  _compareEntriesBySeverity(a, b) {
    return this._entrySeverity(a.level, a.levelno) - this._entrySeverity(b.level, b.levelno);
  }

  // Numeric floor for a level-filter token. ALL means no additional floor.
  _levelFilterFloor(levelFilter) {
    if (!levelFilter || levelFilter === "ALL") return -Infinity;
    const byName = {
      DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50,
    };
    return byName[levelFilter] != null ? byName[levelFilter] : -Infinity;
  }

  // The level the logger itself enforces. Records below it are discarded by
  // the logger before the counter handler ever sees them.
  _effectiveGateLevel(loggerName) {
    const eid = this._findEntityIdByLogger(loggerName);
    if (!eid) return null;
    const attrs = this._hass.states[eid].attributes || {};
    return attrs.effective_level || null;
  }

  // HA date/time format configuration with safe fallbacks.
  _localeSettings() {
    const locale = (this._hass && this._hass.locale) || {};
    return {
      dateFormat: locale.date_format || "language",
      timeFormat: locale.time_format || "24",
    };
  }

  // Ordered date parts for an explicit HA date format; null means the locale
  // decides its own ordering.
  _datePartOrder(dateFormat) {
    if (dateFormat === "DMY") return ["day", "month", "year"];
    if (dateFormat === "MDY") return ["month", "day", "year"];
    if (dateFormat === "YMD") return ["year", "month", "day"];
    return null;
  }

  // Locale-aware date and time, honouring the region's date ordering and its
  // 12/24-hour convention.
  _formatDateTime(ts) {
    const date = new Date((ts || 0) * 1000);
    const { dateFormat, timeFormat } = this._localeSettings();
    const hour12 = timeFormat === "12" ? true : timeFormat === "24" ? false : undefined;
    const order = this._datePartOrder(dateFormat);

    let dateText;
    if (order) {
      const parts = new Intl.DateTimeFormat(this._locale(), {
        day: "2-digit", month: "2-digit", year: "numeric",
      }).formatToParts(date);
      const byType = {};
      let separator = "/";
      parts.forEach(part => {
        if (part.type === "day" || part.type === "month" || part.type === "year") {
          byType[part.type] = part.value;
        } else if (part.type === "literal" && separator === "/") {
          const trimmed = part.value.trim();
          if (trimmed) separator = trimmed;
        }
      });
      dateText = order.map(k => byType[k]).join(separator);
    } else {
      dateText = new Intl.DateTimeFormat(this._locale(), {
        day: "2-digit", month: "2-digit", year: "numeric",
      }).format(date);
    }

    const timeOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };
    if (hour12 !== undefined) timeOptions.hour12 = hour12;
    const timeText = new Intl.DateTimeFormat(this._locale(), timeOptions).format(date);

    return `${dateText} ${timeText}`;
  }

  // Sanitized timestamp for download filenames: no path separators or other
  // unsafe characters, whitespace collapsed to a single underscore.
  _formatFileTimestamp(date) {
    const pad = (n) => String(n).padStart(2, "0");
    const raw =
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
      `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    return raw.replace(/[^0-9A-Za-z_-]+/g, "_").replace(/\s+/g, "_");
  }

  // Human-readable duration, e.g. 300 -> "5 minutes", 270 -> "4 minutes and 30 seconds".
  _formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
    const parts = [];
    if (minutes > 0) parts.push(plural(minutes, "minute"));
    if (secs > 0 || minutes === 0) parts.push(plural(secs, "second"));
    if (parts.length === 1) return parts[0];
    return `${parts[0]} and ${parts[1]}`;
  }

  // True when `to` is a strictly more verbose level than `current`.
  _isMoreVerbose(to, current) {
    if (!to || !current) return false;
    // ALL is the catch-all floor: always more verbose than any named level.
    if (to === "ALL") return true;
    if (current === "ALL") return false;
    if (to === "NOTSET" || current === "NOTSET") return false;
    const ti = this._levelIndex(to);
    const ci = this._levelIndex(current);
    return ti !== -1 && ci !== -1 && ti < ci;
  }

  _recordingLoggerState(loggerName) {
    return Object.values((this._hass && this._hass.states) || {}).find(
      s => s.attributes && s.attributes.logger_name === loggerName
    ) || null;
  }

  // Coloured level token for confirm-dialog messages (level names are fixed).
  _levelPillHtml(level) {
    const colors = this._levelColors(level);
    return `<span style="color: ${colors.color}; font-weight: 600;">${this._escapeHtml(level)}</span>`;
  }

  // Apply the recording-level row styling (background and selector colours).
  _applyRecordingLevelStyle(sel, level) {
    const item = sel.closest(".checklist-item");
    const colors = this._levelColors(level);
    if (item) item.style.background = colors.rowBg;
    sel.style.color = colors.color;
    sel.style.background = colors.bg;
  }

  // Selection-time raise prompt: record the raise intent for later application.
  _handleRecordingLevelChange(sel) {
    const loggerName = sel.dataset.logger;
    const to = sel.value;
    const stateObj = this._recordingLoggerState(loggerName);
    const current = stateObj ? stateObj.state : null;
    const prev = sel.dataset.prevLevel || current;
    const friendly = (stateObj && stateObj.attributes.friendly_name) || loggerName;
    if (this._isMoreVerbose(to, current)) {
      // Revert now; the prompt restores the verbose value on confirm.
      sel.value = prev;
      this._applyRecordingLevelStyle(sel, prev);
      this._showDeleteConfirm(
        `${this._escapeHtml(friendly)} is set to ${this._levelPillHtml(current)}. Raise it to ${this._levelPillHtml(to)} for this recording and restore it afterwards?`,
        () => {
          sel.value = to;
          sel.dataset.prevLevel = to;
          this._applyRecordingLevelStyle(sel, to);
          this._recordingRaiseIntents[loggerName] = { entityId: stateObj.entity_id, from: current, to };
        },
        "Raise logger level",
        "Raise for recording",
        null,
        true
      );
      return;
    }
    // Any change (including less verbose) recolours the row to the selection.
    sel.dataset.prevLevel = to;
    this._applyRecordingLevelStyle(sel, to);
    const intent = this._recordingRaiseIntents[loggerName];
    if (intent && intent.to !== to) {
      delete this._recordingRaiseIntents[loggerName];
    }
    this._markProfileDirty();
  }

  // Prompt per logger and record raise intents, one dialog at a time.
  _promptRaiseSequence(items) {
    if (!items || items.length === 0) return;
    const head = items[0];
    const rest = items.slice(1);
    const friendly = head.friendlyName || head.loggerName;
    this._showDeleteConfirm(
      `${this._escapeHtml(friendly)} is set to ${this._levelPillHtml(head.from)}. Raise it to ${this._levelPillHtml(head.to)} for this recording and restore it afterwards?`,
      () => {
        this._recordingRaiseIntents[head.loggerName] = {
          entityId: head.entityId,
          from: head.from,
          to: head.to,
        };
        this._promptRaiseSequence(rest);
      },
      "Raise logger level",
      "Raise for recording",
      () => {
        // Cancelling skips this raise and restores the logger's configured level.
        if (head.selectEl) {
          head.selectEl.value = head.from;
          head.selectEl.dataset.prevLevel = head.from;
          this._applyRecordingLevelStyle(head.selectEl, head.from);
        }
        delete this._recordingRaiseIntents[head.loggerName];
        this._promptRaiseSequence(rest);
      },
      true
    );
  }

  // "Raised to X" indicator shown while recording on raised loggers.
  _renderRaisedChipHtml(loggerName, isRecording) {
    if (!isRecording) return "";
    const restore = (this._recordingRestoreLevels || {})[loggerName];
    if (!restore || !restore.raisedTo) return "";
    const title = `Restored to ${restore.level} when the recording ends`;
    return `<div class="raised-line" title="${this._escapeAttr(title)}">Raised to ${this._escapeHtml(restore.raisedTo)}</div>`;
  }

  // Source attribution for the current level, derived from the audit trail.
  _levelSourceLabel(loggerName, level) {
    const entries = this._getAuditEntries(loggerName);
    const match = entries.find(a => a.new_level === level);
    if (match) return this._auditSourceLabel(match.source);
    if (level === "NOTSET") return "inherited";
    return "";
  }

  _levelSelectTooltip(loggerName, currentLevel, isPinned, isRecording) {
    const parts = [];
    if (isPinned) {
      parts.push("Managed by Home Assistant — set via YAML logger:, the integration's debug toggle, or the logger.set_level service.");
    }
    if (isRecording) {
      parts.push("Level is locked while this logger is recording. Stop the recording to change it.");
    }
    if (currentLevel) {
      const source = this._levelSourceLabel(loggerName, currentLevel);
      parts.push(`Current level: ${currentLevel}${source ? ` (${source})` : ""}`);
    }
    return parts.join("\n\n");
  }

  // Restore logger levels changed to make a recording more verbose.
  _restoreRecordingLevels() {
    const restore = this._recordingRestoreLevels || {};
    Object.values(restore).forEach(({ entityId, level }) => {
      this._hass.callService("select", "select_option", { entity_id: entityId, option: level });
    });
    this._recordingRestoreLevels = {};
  }

  _managedRootFor(loggerName) {
    // Resolve an emitting logger to its managed root (longest matching prefix),
    // preferring the active recording set, else all managed loggers.
    const candidates = (this._recordingLoggers && this._recordingLoggers.length)
      ? this._recordingLoggers
      : Object.values((this._hass && this._hass.states) || {})
          .map(s => s.attributes && s.attributes.logger_name)
          .filter(Boolean);
    let best = null;
    for (const name of candidates) {
      if (loggerName === name || loggerName.startsWith(name + ".")) {
        if (!best || name.length > best.length) best = name;
      }
    }
    return best || loggerName;
  }

  _loggerDisplay(loggerName) {
    const root = this._managedRootFor(loggerName);
    const stateObj = Object.values((this._hass && this._hass.states) || {}).find(
      s => s.attributes && s.attributes.logger_name === root
    );
    const friendly = stateObj ? (stateObj.attributes.friendly_name || root) : root;
    const child = loggerName.length > root.length ? loggerName.slice(root.length + 1) : "";
    return { friendly, child, path: loggerName };
  }

  _loggerCellHtml(loggerName) {
    const info = this._loggerDisplay(loggerName);
    const child = info.child
      ? ` <span class="logger-child">${this._escapeHtml(info.child)}</span>`
      : "";
    return `${this._escapeHtml(info.friendly)}${child}`;
  }

  _managedRoot(loggerName) {
    // Map an emitting (possibly child) logger back to its managed root so
    // "with entries" counts loggers, not distinct child logger names.
    let best = null;
    for (const name of this._recordingLoggers) {
      if (loggerName === name || loggerName.startsWith(name + ".")) {
        if (!best || name.length > best.length) best = name;
      }
    }
    return best || loggerName;
  }

  _updateLiveSummary() {
    const seen = this._recordingBuffer.length;
    const hidden = Math.max(0, this._recordingBackendCount - seen);
    const bufferPct = Math.round((seen / 10000) * 100);
    const recordingCount = this._recordingLoggers.length;
    const withEntries = new Set(this._recordingBuffer.map(entry => this._managedRoot(entry.logger))).size;
    const seenText = `${seen} entr${seen === 1 ? "y" : "ies"}${hidden > 0 ? ` (${hidden} hidden)` : ""}`;
    this._liveSummary.textContent =
      `${seenText} \u00B7 buffer at ${bufferPct}% \u00B7 ` +
      `${recordingCount} logger${recordingCount === 1 ? "" : "s"} recording \u00B7 ` +
      `${withEntries} with entr${withEntries === 1 ? "y" : "ies"}`;
    this._updateExportButtonState();
  }

  // Selection keys that resolve to entries actually present in the recording
  // buffer. Selections made in the counting panel belong to a different list
  // and must not inflate the export scope.
  _selectedBufferKeys() {
    const bufferKeys = new Set(this._recordingBuffer.map(entry => this._entryKey(entry)));
    return [...this._selectedKeys].filter(key => bufferKeys.has(key));
  }

  _updateExportButtonState() {
    if (!this._liveSavePlainBtn) return;
    const hasEntries = this._recordingBuffer.length > 0;
    const scope = this._recordingState === "recording" ? "captured so far" : "all recorded";
    const selectedCount = this._selectedBufferKeys().length;
    const scopeLabel = selectedCount > 0 ? `${selectedCount} selected` : "all";
    this._liveSavePlainBtn.disabled = !hasEntries;
    this._liveSaveJsonlBtn.disabled = !hasEntries;
    this._liveCopyBtn.disabled = !hasEntries;
    this._liveSavePlainBtn.textContent = `Save ${scopeLabel} as .log`;
    this._liveSaveJsonlBtn.textContent = `Save ${scopeLabel} as JSONL`;
    this._liveCopyBtn.textContent = selectedCount > 0
      ? `Copy ${selectedCount} selected`
      : "Copy all";
    this._liveSavePlainBtn.title = `Save ${scope} entries as a plain-text .log file`;
    this._liveSaveJsonlBtn.title = `Save ${scope} entries as JSON Lines (.jsonl).`;
    this._liveCopyBtn.title = selectedCount > 0
      ? `Copy ${selectedCount} selected entr${selectedCount === 1 ? "y" : "ies"} to clipboard`
      : `Copy ${scope} entries to clipboard`;
  }

  _updateRecordingUI() {
    if (this._recordingState === "stopping") {
      this._recordIcon.setAttribute("icon", "mdi:stop-circle");
      this._recordBtn.classList.add("btn-record");
      this._recordBtn.classList.remove("btn-view-recording");
      this._recordBtn.title = "Stopping recording...";
      this._recordText.textContent = "Stopping...";
      this._liveBtn.style.display = "none";
      this._discardRecordBtn.style.display = "none";
    } else if (this._recordingState === "recording") {
      this._recordIcon.setAttribute("icon", "mdi:stop-circle");
      this._recordBtn.classList.add("btn-record");
      this._recordBtn.classList.remove("btn-view-recording");
      this._recordBtn.title = "Stop recording";
      const elapsed = Math.floor((Date.now() - this._recordingStartTime) / 1000);
      const remaining = Math.max(0, this._recordingMaxDuration - elapsed);
      const mins = String(Math.floor(remaining / 60)).padStart(2, "0");
      const secs = String(remaining % 60).padStart(2, "0");
      this._recordText.textContent = `Stop (${mins}:${secs})`;
      this._liveBtn.style.display = "";
      this._discardRecordBtn.style.display = "none";
    } else if (this._recordingState === "completed") {
      this._recordIcon.setAttribute("icon", "mdi:file-eye-outline");
      this._recordBtn.classList.remove("btn-record");
      this._recordBtn.classList.add("btn-view-recording");
      this._recordBtn.title = "View recorded logs";
      this._recordText.textContent = `View Recording (${this._recordingLogCount})`;
      this._liveBtn.style.display = "none";
      this._discardRecordBtn.style.display = "";
    } else if (this._recordingState === "results") {
      this._recordIcon.setAttribute("icon", "mdi:eye-check");
      this._recordBtn.classList.remove("btn-record");
      this._recordBtn.classList.add("btn-view-recording");
      this._recordBtn.title = "Viewing recording results";
      this._recordText.textContent = "Viewing";
      this._liveBtn.style.display = "none";
      this._discardRecordBtn.style.display = "";
    } else {
      this._recordIcon.setAttribute("icon", "mdi:record-circle");
      this._recordBtn.classList.remove("btn-record");
      this._recordBtn.classList.remove("btn-view-recording");
      this._recordBtn.title = "Record log events for export";
      this._recordText.textContent = "Record";
      this._liveBtn.style.display = "none";
      this._discardRecordBtn.style.display = "none";
    }
  }

  _discardRecording() {
    this._hass.connection.sendMessagePromise({ type: "log_manager/discard_recording" })
      .then(() => {
        this._restoreRecordingLevels();
        this._cleanupRecordingIntervals();
        this._cleanupLivePolling();
        this._recordingBuffer = [];
        this._recordingCounts = {};
        this._recordingBackendCount = 0;
        this._recordingLogCount = 0;
        this._recordingState = null;
        this._liveLastId = 0;
        this._resetDedupState();
        this._resultsShown = false;
        this._hideResultsSummary();
        this._liveViewOpen = false;
        if (this._livePreview) this._livePreview.innerHTML = "";
        if (this._recordingLiveDialog) {
          this._recordingLiveDialog.classList.remove("visible");
          this._recordingLiveDialog.style.display = "none";
        }
        this._updateRecordingUI();
        this._updateActiveList();
      })
      .catch(err => console.error("Failed to discard recording:", err));
  }

  _clearRecordingBuffer() {
    this._hass.connection.sendMessagePromise({ type: "log_manager/clear_recording" })
      .then(() => {
        this._recordingBuffer = [];
        this._recordingCounts = {};
        this._recordingBackendCount = 0;
        this._liveLastId = 0;
        this._resetDedupState();
        this._resultsShown = false;
        this._hideResultsSummary();
        if (this._livePreview) this._livePreview.innerHTML = "";
        this._updateLiveSummary();
        this._updateActiveList();
      })
      .catch(err => console.error("Failed to clear recording:", err));
  }

  _previewMenuItems() {
    const hasEntries = this._recordingBuffer.length > 0;
    const selected = this._selectedBufferKeys().length;
    return [
      { label: "Save as .log", disabled: !hasEntries, action: () => this._downloadLogs("plain") },
      { label: "Save as JSONL", disabled: !hasEntries, action: () => this._downloadLogs("jsonl") },
      {
        label: selected > 0 ? `Copy ${selected} selected` : "Copy to clipboard",
        disabled: !hasEntries,
        action: () => this._copyLogsToClipboard(),
      },
    ];
  }

  _showContextMenu(items, x, y) {
    const menu = this._contextMenu || this._previewContextMenu;
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
        this._hideContextMenu();
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

  _hideContextMenu() {
    const menu = this._contextMenu || this._previewContextMenu;
    if (menu) menu.style.display = "none";
  }

  _copyText(text) {
    if (text == null || text === "") return;
    navigator.clipboard.writeText(String(text)).catch(err => console.error("Failed to copy:", err));
  }

  // Plain-text rendering shared by the context-menu copy actions. Matches the
  // Copy button's format, including its fixed 24-hour time.
  _entriesToText(entries) {
    return entries.map(entry => {
      const time = this._formatDateTime(entry.timestamp);
      const level = entry.level.padEnd(8);
      const src = entry.source ? ` (${entry.source})` : "";
      return `[${time}] ${level} ${entry.logger}  ${entry.message}${src}`;
    }).join("\n") + "\n";
  }

  _handleListContextMenu(e) {
    // Text-editing surfaces keep the browser's native menu.
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    const row = e.target.closest ? e.target.closest(".log-row") : null;
    const loggerName = row && row.dataset.loggerName;
    if (!loggerName) return;
    e.preventDefault();
    const items = [];
    if (e.target.closest(".counter-badge")) {
      items.push({ label: "Expand or collapse panel", action: () => this._toggleExpand(loggerName) });
    }
    const eid = this._findEntityIdByLogger(loggerName);
    const friendly = eid ? (this._hass.states[eid].attributes.friendly_name || loggerName) : loggerName;
    items.push({ label: "Copy logger path", action: () => this._copyText(loggerName) });
    items.push({ label: "Copy friendly name", action: () => this._copyText(friendly) });
    const entry = e.target.closest(".selectable-entry");
    if (entry) {
      const keys = this._rowSelectionKeys(entry) || [];
      const all = (this._counters[loggerName] || {}).recent_logs || [];
      const one = all.find(en => this._entryKey(en) === keys[0]);
      const selected = all.filter(en => this._selectedKeys.has(this._entryKey(en)));
      items.push({ label: "Copy entry", disabled: !one, action: () => this._copyText(this._entriesToText(one ? [one] : [])) });
      items.push({
        label: `Copy selected entries (${selected.length})`,
        disabled: selected.length === 0,
        action: () => this._copyText(this._entriesToText(selected)),
      });
      items.push({ label: "Copy all captured entries", disabled: all.length === 0, action: () => this._copyText(this._entriesToText(all)) });
    } else {
      const editBtn = row.querySelector(".edit-btn");
      const removeBtn = row.querySelector(".remove-btn");
      items.push({ label: "Edit logger", disabled: !editBtn || editBtn.disabled, action: () => editBtn && editBtn.click() });
      items.push({ label: "Remove logger", disabled: !removeBtn || removeBtn.disabled, action: () => removeBtn && removeBtn.click() });
    }
    this._showContextMenu(items, e.clientX, e.clientY);
  }

  _handleChecklistContextMenu(e) {
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    const item = e.target.closest ? e.target.closest(".checklist-item") : null;
    if (!item) return;
    const cb = item.querySelector("input[type='checkbox']");
    const loggerName = cb && cb.dataset.logger;
    if (!loggerName) return;
    e.preventDefault();
    this._showContextMenu([
      { label: "Copy logger path", action: () => this._copyText(loggerName) },
    ], e.clientX, e.clientY);
  }

  _handleHistoryContextMenu(e) {
    const tr = e.target.closest ? e.target.closest("tr") : null;
    if (!tr || !tr.closest("tbody")) return;
    e.preventDefault();
    const rowText = Array.from(tr.children).map(td => td.textContent).join("\t");
    const allText = this._historyLoggerPath ? this._historyRowsText(this._historyLoggerPath) : "";
    this._showContextMenu([
      { label: "Copy row", action: () => this._copyText(rowText) },
      { label: "Copy all history", disabled: !allText, action: () => this._copyText(allText) },
    ], e.clientX, e.clientY);
  }

  _historyRowsText(loggerName) {
    return this._getAuditEntries(loggerName).slice(0, LogManagerCard.AUDIT_SHOW).map(a => (
      `${this._formatDateTime(a.ts)}\t${this._auditSourceLabel(a.source)}\t${a.old_level || "?"}\t${a.new_level || "?"}`
    )).join("\n");
  }

  // TODO: Remove this handler and the "copy" listener at line ~2723 — the
  // preview's user-select: none styling makes both unreachable outside tests.
  _handlePreviewCopy(e) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!range || !this._livePreview.contains(range.startContainer)) return;

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

    const allRows = Array.from(this._livePreview.querySelectorAll(".log-preview-line, .log-preview-group"));
    const startIdx = allRows.indexOf(startRow);
    const endIdx = allRows.indexOf(endRow);
    if (startIdx === -1 || endIdx === -1) return;
    const from = Math.min(startIdx, endIdx);
    const to = Math.max(startIdx, endIdx);

    const formatEntry = (entry) => {
      const time = this._formatDateTime(entry.timestamp);
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
          const entry = this._recordingBuffer.find(rec => rec.id === id);
          if (entry) lines.push(formatEntry(entry));
        }
        continue;
      }
      const entry = this._recordingBuffer.find(rec => String(rec.id) === String(row.dataset.id));
      if (!entry) continue;
      lines.push(formatEntry(entry));
    }
    if (lines.length > 0) {
      e.preventDefault();
      e.clipboardData.setData("text/plain", lines.join("\n") + "\n");
    }
  }

  setConfig(config) {
    this.config = config;
  }
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "log-manager-card",
  name: "Log Manager",
  description: "A control panel for managing loggers.",
});

customElements.define("log-manager-card", LogManagerCard);
