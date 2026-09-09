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

    this._recordingState = null; // null | "recording" | "stopping" | "completed" | "results"
    this._recordingStartTime = 0;
    this._recordingLoggers = [];
    this._recordingLevelOverrides = {};
    this._recordingBuffer = [];
    this._recordingDuration = 0;
    this._recordingLogCount = 0;
    this._recordingTimerInterval = null;
    this._recordingMaxDuration = 300;
    this._recordingCounts = {};
    this._recordingBackendCount = 0;
    this._liveViewOpen = false;
    this._livePaused = false;
    this._liveLastId = 0;
    this._liveLastGroup = null;
    this._liveLastSingle = null;
    // Plain dedup keys: two distant runs of the same message share one
    // expansion flag, so expanding one expands both after a rebuild.
    this._expandedDedupKeys = new Set();
    this._resultsShown = false;
    this._resultsSummaryFilter = null;

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

  _applyAutoFriendlyName() {
    if (this._friendlyNameDirty) return;
    const path = this._pathInput.value.trim();
    if (!path) return;
    const derived = this._deriveFriendlyName(path);
    if (!derived) return;
    this._friendlyNameInput.value = derived;
    this._persistState();
    this._validateAddButton();
  }

  _fetchCounters() {
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
      ? "Root default"
      : `Inherited from ${effectiveSource}`;
    return { effectiveLevel, sourceText };
  }

  _renderEffectiveChip(stateObj, currentLevel, isUnavailable) {
    const info = this._effectiveChipInfo(stateObj, currentLevel, isUnavailable);
    if (!info) return "";
    const colors = this._levelColors(info.effectiveLevel);
    return `<div class="effective-line" title="${this._escapeAttr(info.sourceText)}">effective: <span class="effective-level" style="color: ${colors.color};">${this._escapeHtml(info.effectiveLevel)}</span></div>`;
  }

  _updateEffectiveChipInPlace(pathDiv, stateObj, currentLevel, isUnavailable) {
    const existing = pathDiv.querySelector(".effective-line");
    const html = this._renderEffectiveChip(stateObj, currentLevel, isUnavailable);
    if (!html) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      pathDiv.insertAdjacentHTML("beforeend", html);
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
    existing.setAttribute("title", freshLine.getAttribute("title") || "");
  }

  _findEntityIdByLogger(loggerName) {
    if (!this._hass) return null;
    const eid = Object.keys(this._hass.states).find(id => {
      if (!id.startsWith("select.")) return false;
      return this._hass.states[id].attributes.logger_name === loggerName;
    });
    return eid || null;
  }

  _groupKey(loggerName) {
    const parts = String(loggerName || "").split(".");
    return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : String(loggerName || "");
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

  _ensureGroupSection(prefix, count) {
    // Compare dataset values directly: prefix characters are HTML-safe here
    // via _escapeHtml below, but they are not valid CSS-selector escapes.
    let section = Array.from(this._activeList.children).find(
      el => el.classList && el.classList.contains("log-group") && el.dataset.group === prefix
    ) || null;
    const collapsed = !!this._getCollapsedGroups()[prefix];
    const chevron = collapsed ? "\u25B8" : "\u25BE";
    if (!section) {
      section = document.createElement("div");
      section.className = "log-group";
      section.dataset.group = prefix;
      section.innerHTML = `
        <div class="log-group-header" title="Toggle section">
          <span class="log-group-chevron">${chevron}</span>
          <span class="log-group-name">${this._escapeHtml(prefix)}</span>
          <span class="log-group-count">(${count})</span>
        </div>
        <div class="log-group-rows"></div>`;
      section.querySelector(".log-group-header").addEventListener("click", (e) => {
        e.stopPropagation();
        const nowCollapsed = section.querySelector(".log-group-rows").style.display !== "none";
        section.querySelector(".log-group-rows").style.display = nowCollapsed ? "none" : "";
        section.querySelector(".log-group-chevron").textContent = nowCollapsed ? "\u25B8" : "\u25BE";
        this._setGroupCollapsed(prefix, nowCollapsed);
      });
      if (collapsed) {
        section.querySelector(".log-group-rows").style.display = "none";
      }
    } else {
      section.querySelector(".log-group-chevron").textContent = chevron;
      section.querySelector(".log-group-count").textContent = `(${count})`;
      section.querySelector(".log-group-rows").style.display = collapsed ? "none" : "";
    }
    return section;
  }

  _getCountLevelInfo(loggerName) {
    const eid = this._findEntityIdByLogger(loggerName);
    if (!eid) return { countLevel: "WARNING", disabled: true };
    const stateObj = this._hass.states[eid];
    const unavailable = stateObj.state === "unavailable" || stateObj.state === "unknown";
    return {
      countLevel: stateObj.attributes.count_level || "WARNING",
      disabled: unavailable,
    };
  }

  _getAlertInfo(loggerName) {
    const eid = this._findEntityIdByLogger(loggerName);
    if (!eid) return { threshold: 0, level: "ERROR", disabled: true };
    const stateObj = this._hass.states[eid];
    const unavailable = stateObj.state === "unavailable" || stateObj.state === "unknown";
    return {
      threshold: stateObj.attributes.alert_threshold || 0,
      level: stateObj.attributes.alert_level || "ERROR",
      disabled: unavailable,
    };
  }

  _getSensorInfo(loggerName) {
    const eid = this._findEntityIdByLogger(loggerName);
    if (!eid) return { enabled: false, disabled: true };
    const stateObj = this._hass.states[eid];
    const unavailable = stateObj.state === "unavailable" || stateObj.state === "unknown";
    return {
      enabled: !!stateObj.attributes.sensor_enabled,
      disabled: unavailable,
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

  _renderAuditLine(entries) {
    if (!entries || entries.length === 0) return "";
    const sourceLabels = { ui: "UI", core: "Home Assistant" };
    const items = entries.slice(0, LogManagerCard.AUDIT_SHOW).map(a => {
      const at = new Date((a.ts || 0) * 1000);
      const timeOpts = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
      const when = at.toLocaleTimeString(undefined, timeOpts);
      const whenFull = at.toLocaleString(undefined, {
        year: "numeric", month: "2-digit", day: "2-digit",
        ...timeOpts,
      });
      const who = sourceLabels[a.source] || a.source || "unknown";
      const from = this._escapeHtml(a.old_level || "");
      const to = this._escapeHtml(a.new_level || "");
      return `<span title="${this._escapeAttr(`Changed by ${who} at ${whenFull}`)}">by ${this._escapeHtml(who)} ${from} \u2192 ${to}</span>`;
    });
    return `<div class="audit-line"><span class="audit-label">Level changes:</span> ${items.join(" · ")}</div>`;
  }

  _renderSeverityLine(levels) {
    const order = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
    const parts = [];
    for (const level of order) {
      const count = (levels || {})[level] || 0;
      if (count > 0) {
        const colors = this._levelColors(level);
        parts.push(`<span style="color: ${colors.color};">${level} ${count}</span>`);
      }
    }
    if (parts.length === 0) return "";
    return `<div class="severity-line" title="Events counted per severity since the last reset">${parts.join(" · ")}</div>`;
  }

  _renderLogPanelHtml(loggerName) {
    const stats = this._counters[loggerName] || {"warning": 0, "error": 0, "recent_logs": [], "levels": {}};
    const hasCounters = (stats.warning || 0) > 0 || (stats.error || 0) > 0 || (stats.recent_logs || []).length > 0;

    const { countLevel, disabled } = this._getCountLevelInfo(loggerName);
    const countLabel = countLevel === "NOTSET" ? "all levels" : `${countLevel} and above`;
    const alertInfo = this._getAlertInfo(loggerName);
    const sensorInfo = this._getSensorInfo(loggerName);

    const recentLogs = stats.recent_logs || [];
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
      recentLogs.forEach(entry => {
        const time = new Date(entry.timestamp * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
        const chip = levelChips[entry.level] || [entry.level.charAt(0), "log-level-debug"];
        const msg = this._escapeHtml(entry.message);
        const src = entry.source ? this._escapeHtml(entry.source.split("/").pop()) : "";
        entriesHtml += `
          <div class="log-entry">
            <span class="log-time">${time}</span>
            <span class="log-level ${chip[1]}">${chip[0]}</span>
            <span class="log-msg">${msg}</span>
            ${src ? `<span class="log-src">${src}</span>` : ""}
          </div>`;
      });
    }

    const countOptions = ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
      .map(l => `<option value="${l}"${l === countLevel ? " selected" : ""}>${l}</option>`).join("");

    const alertLevels = ["WARNING", "ERROR", "CRITICAL"];
    const alertOptions = alertLevels
      .map(l => `<option value="${l}"${l === alertInfo.level ? " selected" : ""}>${l}</option>`).join("");

    return `
      <div class="log-panel">
        <div class="severity-line-row">
          ${this._renderSeverityLine(stats.levels)}
          <label class="count-level-row" title="Only events at or above this level are counted for the badges and this panel">
            Count from:
            <select class="count-level-select" data-logger="${this._escapeAttr(loggerName)}"${disabled ? " disabled" : ""}>${countOptions}</select>
          </label>
        </div>
        <div class="alert-line-row">
          <label class="alert-row" title="Notify once when this many counted events at or above the alert severity arrive (0 disables). Only events counted for this row qualify.">
            Alert:
            <select class="alert-level-select" data-logger="${this._escapeAttr(loggerName)}"${disabled ? " disabled" : ""}>${alertOptions}</select>
            <span>&ge;</span>
            <input class="alert-threshold-input" type="number" min="0" max="100000" step="1" value="${alertInfo.threshold}" data-logger="${this._escapeAttr(loggerName)}"${disabled ? " disabled" : ""}>
          </label>
        </div>
        <div class="sensor-line-row">
          <label class="sensor-row" title="Expose this logger's warning/error counts as sensor entities for automations and history. Off by default to avoid entity clutter.">
            Sensors:
            <input class="sensor-enabled-toggle" type="checkbox" data-logger="${this._escapeAttr(loggerName)}"${sensorInfo.enabled ? " checked" : ""}${sensorInfo.disabled ? " disabled" : ""}>
          </label>
        </div>
        ${this._renderAuditLine(this._getAuditEntries(loggerName))}
        <div class="log-entries">${entriesHtml}</div>
        <div class="log-disclaimer" title="This panel is fed by the counter badges, which capture events at or above the counting level for every logger regardless of its configured level. It does not affect or reflect recording.">This panel shows ${this._escapeHtml(countLabel)}, independent of the configured level.</div>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <button class="reset-btn" data-logger="${this._escapeAttr(loggerName)}"${hasCounters ? "" : " disabled"}>
            <ha-icon icon="mdi:refresh" style="--mdi-icon-size: 14px;"></ha-icon>
            Reset counters
          </button>
          <button class="copy-panel-btn" data-logger="${this._escapeAttr(loggerName)}"${recentLogs.length === 0 ? " disabled" : ""}>
            <ha-icon icon="mdi:content-copy" style="--mdi-icon-size: 14px;"></ha-icon>
            Copy
          </button>
        </div>
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
    this._toggleText.innerText = "Add Logger";
    this._clearState();
  }

  // Open the add/edit section. Closes any expanded log panel.
  _openAddSection() {
    if (this._expandedLogger) {
      this._expandedLogger = null;
    }
    this._isAddSectionVisible = true;
    this._addSectionWrapper.classList.add("visible");
    this._toggleIcon.setAttribute("icon", "mdi:chevron-up");
    this._toggleText.innerText = "Cancel";
    setTimeout(() => {
      if (this._isAddSectionVisible) {
        this._addSectionWrapper.style.overflow = "visible";
        this._pathInput.focus();
        this._pathInput.select();
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
      // Reset counters but keep the panel open.
      if (this._counters[loggerName]) {
        this._counters[loggerName] = {"warning": 0, "error": 0, "last_warning": "", "last_error": "", "recent_logs": [], "levels": {}};
      }
      this._updateActiveList();
    });
  }

  _attachCountLevelHandler(row) {
    const sel = row.querySelector(".count-level-select");
    if (!sel) return;
    // Remove stale listeners to prevent duplicate handler accumulation.
    const clone = sel.cloneNode(true);
    sel.replaceWith(clone);
    clone.addEventListener("change", () => {
      const loggerName = clone.dataset.logger;
      if (!loggerName) return;
      this._hass.callService("log_manager", "set_count_level", {
        logger_name: loggerName,
        level: clone.value
      });
    });
    // Prevent select interaction from toggling expand.
    clone.addEventListener("click", (e) => e.stopPropagation());
  }

  _attachAlertHandler(row) {
    const send = () => {
      const sel = row.querySelector(".alert-level-select");
      const num = row.querySelector(".alert-threshold-input");
      if (!sel || !num) return;
      const loggerName = sel.dataset.logger;
      if (!loggerName) return;
      const count = Math.max(0, parseInt(num.value, 10) || 0);
      this._hass.callService("log_manager", "set_alert_threshold", {
        logger_name: loggerName,
        events: count,
        level: sel.value
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
    }
  }

  _attachSensorHandler(row) {
    const toggle = row.querySelector(".sensor-enabled-toggle");
    if (!toggle) return;
    // Remove stale listeners to prevent duplicate handler accumulation.
    const clone = toggle.cloneNode(true);
    toggle.replaceWith(clone);
    clone.addEventListener("change", () => {
      const loggerName = clone.dataset.logger;
      if (!loggerName) return;
      this._hass.callService("log_manager", "set_sensor_enabled", {
        logger_name: loggerName,
        enabled: clone.checked
      });
    });
    clone.addEventListener("click", (e) => e.stopPropagation());
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
      const logs = stats.recent_logs || [];
      if (logs.length === 0) return;
      const text = logs.map(entry => {
        const time = new Date(entry.timestamp * 1000).toLocaleString(undefined, {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        });
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
  _showDeleteConfirm(message, onConfirm, title = "Remove Logger", confirmLabel = "Remove") {
    this._deleteConfirmTarget = { onConfirm };
    this._deleteDialog.querySelector(".delete-dialog-title").textContent = title;
    this._deleteDialog.querySelector(".delete-dialog-message").textContent = message;
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

    // Debounce via rAF so we never do redundant DOM work within a single frame.
    if (!this._updateScheduled) {
      this._updateScheduled = true;
      requestAnimationFrame(() => {
        try {
          this._updateActiveList();
          this._updateRecordingUI();
        }
        finally { this._updateScheduled = false; }
      });
    }

    this._fetchCounters();
  }

  _buildUI() {
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px 16px 8px 16px; display: flex; flex-direction: column; }
        .header { margin-bottom: 12px; }
        .section-title { font-size: 18px; font-weight: 500; margin: 0; }
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

        .log-group { display: flex; flex-direction: column; gap: 8px; }
        .log-group-header {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          font-weight: 500;
          color: var(--secondary-text-color);
          cursor: pointer;
          user-select: none;
        }
        .log-group-chevron { display: inline-block; width: 16px; }
        .log-group-rows { display: flex; flex-direction: column; gap: 8px; }

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
          user-select: text;
          -webkit-user-select: text;
        }

        .log-entry {
          display: flex;
          align-items: baseline;
          gap: 6px;
          font-size: 12px;
          line-height: 1.4;
          padding: 2px 0;
          word-break: normal;
          overflow-wrap: break-word;
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

        .severity-line-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
          min-height: 22px;
        }

        .severity-line {
          font-size: 11px;
          color: var(--secondary-text-color);
        }

        .count-level-row {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--secondary-text-color);
          margin-left: auto;
        }

        select.count-level-select {
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          font-size: 11px;
          cursor: pointer;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }

        select.count-level-select:disabled {
          opacity: 0.5;
          cursor: default;
        }

        .alert-line-row {
          display: flex;
          align-items: center;
          gap: 6px;
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
          width: 64px;
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

        .copy-panel-btn:hover {
          color: var(--primary-text-color);
          border-color: var(--primary-text-color);
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

        .input-wrapper { position: relative; margin-bottom: 12px; margin-top: 12px; }

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
        .option-item.highlight { font-weight: bold; color: var(--primary-color); }

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
          z-index: 10000;
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

        .btn-secondary:disabled,
        .btn-secondary:disabled:hover {
          opacity: 0.5;
          cursor: not-allowed;
          background: none;
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
        }

        .logger-checklist {
          max-height: 260px;
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
          background: rgba(0, 0, 0, 0.06);
          border-radius: 6px;
          padding: 4px 0;
          font-family: monospace;
          font-size: 12px;
          line-height: 1.5;
          user-select: text;
          -webkit-user-select: text;
        }

        .log-preview-line {
          display: flex;
          gap: 8px;
          padding: 2px 10px;
          user-select: all;
          -webkit-user-select: all;
        }

        .log-preview-line:hover {
          filter: brightness(1.2);
        }

        .log-preview-group {
          display: flex;
          gap: 8px;
          padding: 2px 10px;
          cursor: pointer;
        }

        .log-preview-group:hover {
          filter: brightness(1.2);
        }

        .dedup-count {
          display: inline-block;
          margin-left: 8px;
          padding: 0 7px;
          border-radius: 11px;
          font-size: 11px;
          font-weight: 600;
          background: rgba(var(--rgb-primary-text-color), 0.12);
        }

        .log-preview-group-items {
          display: flex;
          flex-direction: column;
          /* Align occurrence times under time-col: 10 + 44 + 8 + 64 + 8. */
          padding: 2px 10px 2px 134px;
        }

        .results-summary {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 8px;
          font-size: 13px;
        }

        .results-summary-row {
          display: flex;
          align-items: baseline;
          gap: 6px;
          cursor: pointer;
          border-radius: 4px;
          padding: 1px 6px;
        }

        .results-summary-row:hover {
          background: rgba(var(--rgb-primary-text-color), 0.06);
        }

        .results-summary-row.active {
          background: rgba(var(--rgb-primary-text-color), 0.12);
        }

        .results-summary-label {
          color: var(--secondary-text-color);
          min-width: 110px;
        }

        .results-summary-more {
          color: var(--secondary-text-color);
          font-style: italic;
          padding: 1px 6px;
        }

        .log-preview-header {
          display: flex;
          gap: 8px;
          padding: 4px 10px;
          font-weight: 600;
          color: var(--secondary-text-color);
          position: sticky;
          top: 0;
          background: var(--card-background-color);
          border-bottom: 1px solid var(--divider-color);
          user-select: none;
          -webkit-user-select: none;
        }

        .log-preview-col {
          flex-shrink: 0;
        }

        .log-preview-col.idx-col {
          width: 44px;
          color: var(--secondary-text-color);
        }

        .log-preview-col.level-col {
          width: 64px;
          font-weight: 600;
        }

        .log-preview-col.time-col {
          width: 80px;
        }

        .log-preview-col.logger-col {
          width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
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
        </div>

        <div id="active-list" class="active-list"></div>

        <div class="add-section-wrapper" id="add-section-wrapper">
          <div class="add-section">
            <div class="add-section-header">
              <div class="add-section-title">Configure Logger</div>
              <button id="add-btn" disabled>Save</button>
            </div>

            <div class="input-wrapper">
              <input type="text" id="path-input" placeholder="Search or enter logger path..." />
              <div id="options-list" class="options-list"></div>
            </div>

            <input type="text" id="friendly-name-input" class="friendly-input"
                   placeholder="Friendly Name (Optional)" />
          </div>
        </div>

        <div class="card-actions">
          <button class="toggle-add-btn" id="toggle-add-btn" title="Add a new logger to manage">
            <ha-icon icon="mdi:plus" id="toggle-icon"></ha-icon>
            <span id="toggle-text">Add Logger</span>
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
            View Core Logs
          </button>
        </div>
      </ha-card>

      <div class="delete-dialog-overlay" id="delete-dialog">
        <div class="delete-dialog-box">
          <div class="delete-dialog-title">Remove Logger</div>
          <div class="delete-dialog-message"></div>
          <div class="delete-dialog-actions">
            <button class="btn-cancel" id="delete-cancel-btn">Cancel</button>
            <button class="btn-danger" id="delete-confirm-btn">Remove</button>
          </div>
        </div>
      </div>

      <div class="dialog-overlay" id="recording-setup-dialog">
        <div class="dialog-box">
          <div class="dialog-title">Select Loggers to Record</div>
          <div class="profile-row">
            <label class="profile-label" for="recording-profile-select">Profile:</label>
            <select id="recording-profile-select" title="Load a saved recording profile"></select>
            <button class="btn-secondary profile-btn" id="recording-profile-save" title="Save the current selection as a profile">Save…</button>
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
            <button class="btn-primary" id="recording-setup-start" disabled>Start Recording</button>
          </div>
        </div>
      </div>

      <div class="dialog-overlay" id="recording-live-dialog">
        <div class="dialog-box dialog-box-wide">
          <div id="live-top-bar" style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <span class="recording-dot" id="live-status-dot"></span>
            <span id="live-status-text" style="font-weight: 500;">Recording</span>
            <span id="live-timer" style="font-family: monospace; font-size: 14px;"></span>
            <span style="flex: 1;"></span>
            <button class="btn-secondary" id="live-pause-btn" title="Pause viewer update" style="padding: 4px 12px; font-size: 13px;">Pause</button>
            <button class="btn-danger" id="live-stop-btn" title="Stop recording" style="padding: 4px 12px; font-size: 13px;">Stop</button>
          </div>

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

          <div id="live-log-preview" class="log-preview"></div>

          <div id="live-summary" class="recording-summary" style="margin-top: 8px; margin-bottom: 0;"></div>

          <div class="dialog-actions" id="live-export-actions">
            <button class="btn-secondary" id="live-clear-btn" title="Clear all captured entries and start fresh, without stopping the recording">Clear</button>
            <button class="btn-secondary" id="live-save-plain-btn" disabled>Save as .log</button>
            <button class="btn-secondary" id="live-save-jsonl-btn" disabled title="JSON Lines — one JSON object per line (timestamp, level, logger, message, source); easy to process programmatically.">Save as JSONL</button>
            <button class="btn-secondary" id="live-copy-btn" disabled style="margin-right: auto;">Copy to clipboard</button>
            <button class="btn-danger" id="live-discard-btn" style="display: none;">Discard recording</button>
            <button class="btn-secondary" id="live-close-btn" title="Close this window; the recording continues in the background.">Close &amp; Keep Recording</button>
          </div>
        </div>
      </div>

      <div class="context-menu" id="preview-context-menu" style="display: none;">
        <button data-action="plain">Save as .log</button>
        <button data-action="jsonl">Save as JSONL</button>
        <button data-action="copy">Copy to clipboard</button>
      </div>
    `;

    this._activeList = this.shadowRoot.getElementById("active-list");
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
    this._profileSelect = this.shadowRoot.getElementById("recording-profile-select");
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
    this._previewContextMenu = this.shadowRoot.getElementById("preview-context-menu");
    this._liveBtn = this.shadowRoot.getElementById("live-btn");

    this._pathInput.value = this._savedPath;
    this._friendlyNameInput.value = this._savedName;
    // Preserve a name restored from sessionStorage so auto-fill never clobbers it.
    this._friendlyNameDirty = this._savedName !== "";

    // Delete dialog handlers.
    const closeDelete = () => {
      this._deleteDialog.style.display = "none";
      this._deleteConfirmTarget = null;
    };
    this.shadowRoot.getElementById("delete-cancel-btn").addEventListener("click", closeDelete);
    this._deleteDialog.addEventListener("click", (e) => {
      if (e.target === this._deleteDialog) closeDelete();
    });

    this.shadowRoot.getElementById("delete-confirm-btn").addEventListener("click", () => {
      if (this._deleteConfirmTarget) {
        this._deleteConfirmTarget.onConfirm();
        this._deleteConfirmTarget = null;
      }
      this._deleteDialog.style.display = "none";
    });

    // Recording button: stop recording, fetch saved results, or open setup.
    this._recordBtn.addEventListener("click", () => {
      if (this._recordingState === "recording") {
        this._stopRecording();
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
    this._profileSelect.addEventListener("change", () => {
      const name = this._profileSelect.value;
      this._profileDeleteBtn.disabled = !name;
      if (name) this._applyProfile(name);
    });
    this._profileSaveBtn.addEventListener("click", () => {
      this._profileNameInput.value = this._profileSelect.value || "";
      this._profileSaveRow.style.display = "flex";
      this._profileNameInput.focus();
    });
    this._profileAbortBtn.addEventListener("click", () => {
      this._profileSaveRow.style.display = "none";
      this._profileNameInput.value = "";
    });
    this._profileConfirmBtn.addEventListener("click", () => {
      this._saveProfile();
    });
    this._profileNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._saveProfile();
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
      }, "Delete Profile", "Delete");
    });

    this._recordingSetupStart.addEventListener("click", () => {
      const checkboxes = this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
      const selected = [];
      const levelOverrides = {};
      checkboxes.forEach(cb => {
        if (cb.checked) {
          const loggerName = cb.dataset.logger;
          selected.push(loggerName);
          const levelSelect = cb.closest(".checklist-item").querySelector(".recording-level-select");
          if (levelSelect) levelOverrides[loggerName] = levelSelect.value;
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
      this._closeLiveView();
      this._stopRecording();
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
        "Clear Recording",
        "Clear"
      );
    });

    this._liveDiscardBtn.addEventListener("click", () => {
      this._showDeleteConfirm(
        "Discard the recorded logs? This cannot be undone.",
        () => this._discardRecording(),
        "Discard Recording",
        "Discard"
      );
    });

    this._discardRecordBtn.addEventListener("click", () => {
      this._showDeleteConfirm(
        "Discard the recorded logs? This cannot be undone.",
        () => this._discardRecording(),
        "Discard Recording",
        "Discard"
      );
    });

    // Right-click context menu on the preview.
    this._livePreview.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this._showPreviewContextMenu(e);
    });
    this._livePreview.addEventListener("scroll", () => {
      this._hidePreviewContextMenu();
    });
    this._previewContextMenu.querySelector('[data-action="plain"]').addEventListener("click", () => {
      this._downloadLogs("plain");
      this._hidePreviewContextMenu();
    });
    this._previewContextMenu.querySelector('[data-action="jsonl"]').addEventListener("click", () => {
      this._downloadLogs("jsonl");
      this._hidePreviewContextMenu();
    });
    this._previewContextMenu.querySelector('[data-action="copy"]').addEventListener("click", () => {
      this._copyLogsToClipboard();
      this._hidePreviewContextMenu();
    });
    window.addEventListener("click", () => this._hidePreviewContextMenu());

    // Format selected rows nicely when copying from the preview.
    this._livePreview.addEventListener("copy", (e) => this._handlePreviewCopy(e));

    const toggleSection = () => {
      if (this._isAddSectionVisible) {
        this._closeAddSection();
      } else {
        this._openAddSection();
      }
    };

    this._toggleAddBtn.addEventListener("click", toggleSection);

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

    // ESC key closes any open dialog.
    this.shadowRoot.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this._deleteDialog.style.display === "flex") {
        this._deleteDialog.style.display = "none";
        this._deleteConfirmTarget = null;
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

      const isHighlight = highlights.some(prefix => opt.startsWith(prefix));
      if (isHighlight) {
        item.classList.add("highlight");
        item.textContent = `★ ${opt}`;
      } else {
        item.textContent = opt;
      }

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._pathInput.value = opt;
        this._applyAutoFriendlyName();
        this._persistState();
        this._validateAddButton();
        this._optionsList.style.display = "none";
        this._friendlyNameInput.focus();
      });

      this._optionsList.appendChild(item);
    });
  }

  _filterDropdown(filterText) {
    const normalizedFilter = filterText.toLowerCase().replace(/[\s_]+/g, "");

    Array.from(this._optionsList.children).forEach(child => {
      const rawText = child.textContent.replace("★ ", "").toLowerCase();
      const normalizedText = rawText.replace(/[\s_]+/g, "");
      child.style.display = normalizedText.includes(normalizedFilter) ? "block" : "none";
    });
  }

  _updateActiveList() {
    const rawActiveEntities = Object.keys(this._hass.states).filter(eid => {
      return eid.startsWith("select.") && this._hass.states[eid].attributes.logger_name;
    });

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
    let groupOfEid = {};
    let groupIndexOfEid = {};
    let groupOrder = [];
    let itemsByGroup = {};
    if (grouping) {
      activeEntities.forEach(eid => {
        const prefix = this._groupKey(this._hass.states[eid].attributes.logger_name || "");
        groupOfEid[eid] = prefix;
        (itemsByGroup[prefix] = itemsByGroup[prefix] || []).push(eid);
      });
      Object.keys(itemsByGroup).sort().forEach(prefix => {
        groupOrder.push(prefix);
        itemsByGroup[prefix].forEach((eid, groupIndex) => { groupIndexOfEid[eid] = groupIndex; });
      });
      // Drop sections for prefixes that no longer exist.
      Array.from(this._activeList.querySelectorAll(".log-group")).forEach(section => {
        if (!itemsByGroup[section.dataset.group]) section.remove();
      });
    } else {
      // Flat mode: unwrap any leftover sections from a previous grouped render.
      Array.from(this._activeList.querySelectorAll(".log-group")).forEach(section => {
        const container = section.querySelector(".log-group-rows");
        while (container && container.firstChild) {
          this._activeList.insertBefore(container.firstChild, section);
        }
        section.remove();
      });
    }

    const existingRows = Array.from(this._activeList.querySelectorAll(".log-row"));
    existingRows.forEach(row => {
      if (!activeEntities.includes(row.dataset.entityId)) row.remove();
    });

    activeEntities.forEach((eid, index) => {
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
      const colors = this._levelColors(currentLevel);
      const badgeStats = this._counters[actualLoggerName];
      const curWarn = badgeStats ? (badgeStats.warning || 0) : 0;
      const curErr = badgeStats ? (badgeStats.error || 0) : 0;

      if (!row || row.dataset.isUnavailable !== String(isUnavailable)) {
        if (row) row.remove();

        row = document.createElement("div");
        row.className = "log-row";
        row.dataset.entityId = eid;
        row.dataset.isUnavailable = String(isUnavailable);

        // Apply level-based row tint.
        row.style.background = colors.rowBg;

        const selectOptions = options.map(opt => `<option value="${opt}">${opt}</option>`).join("");

        const selectHtml = isUnavailable
          ? `<select class="level-select" disabled><option>Unavailable</option></select>`
          : isPinned
          ? `<select class="level-select" disabled title="${this._escapeAttr(pinnedTitle)}">${selectOptions}</select>`
          : `<select class="level-select">${selectOptions}</select>`;

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

        row.innerHTML = `
          <div class="log-name ${isUnavailable ? "unavailable" : ""}">
            <div style="font-weight: 500;">${recordingTag}${pinnedTag}${this._escapeHtml(displayName)}</div>
            <div style="color: var(--secondary-text-color); font-size: 12px; margin-top: 2px;">
              ${this._escapeHtml(actualLoggerName)}
              ${effectiveChip}
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
            this._friendlyNameDirty = true;

            if (!this._isAddSectionVisible) {
              this._openAddSection();
            } else {
              this._validateAddButton();
            }
          });
        } else {
          row.querySelector(".edit-btn").disabled = true;
          row.querySelector(".edit-btn").style.opacity = "0.3";
          row.querySelector(".edit-btn").style.cursor = "not-allowed";
          row.querySelector(".remove-btn").style.opacity = "0.3";
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

        this._attachBadgeHandlers(row);
        this._attachResetHandler(row);
        this._attachCopyPanelHandler(row);
        this._attachCountLevelHandler(row);
        this._attachAlertHandler(row);
        this._attachSensorHandler(row);
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
          if (document.activeElement !== select && prev.level !== currentLevel) {
            select.value = currentLevel;
            select.style.backgroundColor = colors.bg;
            select.style.color = colors.color;
          }
        }

        // Update row background tint only if level changed.
        if (prev.level !== currentLevel) {
          row.style.background = colors.rowBg;
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
          if (panel) {
            if (this._prevPanelHtml[actualLoggerName] !== panelHtml) {
              panel.outerHTML = panelHtml;
              this._prevPanelHtml[actualLoggerName] = panelHtml;
              this._attachResetHandler(row);
              this._attachCopyPanelHandler(row);
              this._attachCountLevelHandler(row);
              this._attachAlertHandler(row);
              this._attachSensorHandler(row);
            }
          } else {
            row.insertAdjacentHTML("beforeend", panelHtml);
            this._prevPanelHtml[actualLoggerName] = panelHtml;
            this._attachResetHandler(row);
            this._attachCopyPanelHandler(row);
            this._attachCountLevelHandler(row);
            this._attachAlertHandler(row);
            this._attachSensorHandler(row);
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
            if (select) {
              select.disabled = isPinned;
              if (isPinned) {
                select.setAttribute("title", pinnedTitle);
              } else {
                select.removeAttribute("title");
              }
            }
          }
        }

        // Update the effective-level chip when its content changes.
        if (prev.effective !== chipSig) {
          const pathDiv = row.querySelector(".log-name > div:last-child");
          if (pathDiv) {
            this._updateEffectiveChipInPlace(pathDiv, stateObj, currentLevel, isUnavailable);
          }
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
        warningCount: curWarn,
        errorCount: curErr,
        pinned: isPinned,
        effective: chipSig,
        recording: this._recordingState === "recording" && this._recordingLoggers.includes(actualLoggerName),
        recordingCount: this._recordingCounts[actualLoggerName] || 0,
      };

      if (grouping) {
        const prefix = groupOfEid[eid];
        const section = this._ensureGroupSection(prefix, itemsByGroup[prefix].length);
        const sections = Array.from(this._activeList.children).filter(
          el => el.classList && el.classList.contains("log-group")
        );
        const expectedSection = sections[groupOrder.indexOf(prefix)] || null;
        if (expectedSection !== section) {
          this._activeList.insertBefore(section, expectedSection);
        }
        const container = section.querySelector(".log-group-rows");
        const expectedRow = container.children[groupIndexOfEid[eid]] || null;
        if (expectedRow !== row) {
          container.insertBefore(row, expectedRow);
        }
      } else {
        const expectedNode = this._activeList.children[index] || null;
        if (expectedNode !== row) {
          this._activeList.insertBefore(row, expectedNode);
        }
      }
    });

    if (this._isAddSectionVisible) {
      this._renderDropdown();
      this._filterDropdown(this._pathInput.value);
    }
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
      if (isDuplicatePath) this._addBtn.innerText = "Path Managed";
      else if (isDuplicateName) this._addBtn.innerText = "Name Taken";
      else if (isUnknownPath) this._addBtn.innerText = "Unknown Path";
      this._addBtn.style.background = "var(--error-color)";
    } else {
      this._addBtn.disabled = loggerPath.length === 0;
      this._addBtn.innerText = this._editingPath ? "Update" : "Save";
      this._addBtn.style.background = "var(--primary-color)";
    }
  }

  // --- Recording methods ---

  _openRecordingSetup() {
    const LOG_LEVELS = ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
    const managed = Object.entries(this._hass.states)
      .filter(([eid]) => eid.startsWith("select."))
      .filter(([, s]) => s.attributes.logger_name)
      .sort(([, a], [, b]) => (a.attributes.friendly_name || "").localeCompare(b.attributes.friendly_name || ""));

    let html = `<div class="select-all-row">
      <input type="checkbox" id="select-all-checkbox">
      <label for="select-all-checkbox">Select All</label>
    </div>`;

    managed.forEach(([, stateObj]) => {
      const loggerName = stateObj.attributes.logger_name;
      const friendlyName = stateObj.attributes.friendly_name || loggerName;
      const currentLevel = stateObj.state;
      const colors = this._levelColors(currentLevel);
      const levelOpts = LOG_LEVELS.map(l =>
        `<option value="${l}"${l === currentLevel ? " selected" : ""}>${l}</option>`
      ).join("");
      html += `<label class="checklist-item" style="background: ${colors.rowBg};">
        <input type="checkbox" data-logger="${this._escapeAttr(loggerName)}">
        <span class="logger-label">${this._escapeHtml(friendlyName)}</span>
        <select class="recording-level-select" title="Recording level for this logger" disabled style="color: ${colors.color}; background: ${colors.bg};">${levelOpts}</select>
        <button type="button" class="exclude-toggle" data-logger="${this._escapeAttr(loggerName)}" title="Exclude child loggers of ${this._escapeAttr(loggerName)} from this recording">+ exclusions</button>
        <div class="exclude-area" data-logger="${this._escapeAttr(loggerName)}" style="display: none;">
          <div class="exclude-chips"></div>
          <input type="text" class="exclude-input" data-logger="${this._escapeAttr(loggerName)}" placeholder="child.path.to.exclude — Enter to add">
        </div>
      </label>`;
    });

    this._loggerChecklist.innerHTML = html;

    // Update checklist item background and text color when level dropdown changes.
    this._loggerChecklist.querySelectorAll(".recording-level-select").forEach(sel => {
      sel.addEventListener("change", () => {
        const item = sel.closest(".checklist-item");
        if (!item) return;
        const colors = this._levelColors(sel.value);
        item.style.background = colors.rowBg;
        sel.style.color = colors.color;
        sel.style.background = colors.bg;
      });
    });

    const selectAll = this._loggerChecklist.querySelector("#select-all-checkbox");
    selectAll.addEventListener("change", () => {
      const checks = this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
      checks.forEach(cb => {
        cb.checked = selectAll.checked;
        // Also enable/disable level selects
        const levelSelect = cb.closest(".checklist-item").querySelector(".recording-level-select");
        if (levelSelect) levelSelect.disabled = !selectAll.checked;
      });
      this._validateRecordingSetup();
    });

    this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)").forEach(cb => {
      cb.addEventListener("change", () => {
        // Uncheck select-all if one is unchecked.
        const allChecks = this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
        const allChecked = Array.from(allChecks).every(c => c.checked);
        selectAll.checked = allChecked;

        // Enable/disable level select.
        const levelSelect = cb.closest(".checklist-item").querySelector(".recording-level-select");
        if (levelSelect) levelSelect.disabled = !cb.checked;

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
        const open = area.style.display !== "none";
        area.style.display = open ? "none" : "block";
        btn.textContent = open ? "+ exclusions" : "− exclusions";
        if (!open) {
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
      inp.addEventListener("input", () => {
        // Clear a stale invalid flag as soon as the user edits the text.
        inp.classList.remove("exclude-invalid");
        inp.title = "";
      });
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key !== "Enter") return;
        e.preventDefault();
        const path = inp.value.trim();
        if (!path) return;
        const loggerName = inp.dataset.logger;
        const segments = path.split(".");
        if (!path.startsWith(loggerName + ".") || segments.some(s => !s)) {
          inp.classList.add("exclude-invalid");
          inp.title = `Must be a child path of ${loggerName} without empty segments`;
          return;
        }
        inp.classList.remove("exclude-invalid");
        inp.title = "";
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
        rm.textContent = "✕";
        rm.title = "Remove exclusion";
        rm.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          chip.remove();
        });
        rm.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        });
        chip.append(label, rm);
        chips.appendChild(chip);
        inp.value = "";
      });
    });

    this._validateRecordingSetup();
    this._loadProfiles();
    this._recordingSetupDialog.style.display = "flex";
    requestAnimationFrame(() => {
      this._recordingSetupDialog.classList.add("visible");
    });
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

  _renderProfileOptions(profiles) {
    if (!this._profileSelect) return;
    const current = this._profileSelect.value;
    this._profileSelect.innerHTML =
      `<option value="">— None —</option>` + profiles.map(p =>
        `<option value="${this._escapeAttr(p.name)}">${this._escapeHtml(p.name)}</option>`
      ).join("");
    this._profileSelect.value = profiles.some(p => p.name === current) ? current : "";
    this._profileDeleteBtn.disabled = !this._profileSelect.value;
    this._profileSaveRow.style.display = "none";
    this._profileNameInput.value = "";
  }

  _applyProfile(name) {
    this._hass.connection.sendMessagePromise({
      type: "log_manager/profiles_get",
    }).then(res => {
      const profile = ((res && res.profiles) || []).find(p => p.name === name);
      if (!profile) return;
      const wanted = new Set(profile.loggers || []);
      const overrides = profile.level_overrides || {};
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
            levelSelect.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      });
      const selectAll = this._loggerChecklist.querySelector("#select-all-checkbox");
      if (selectAll) {
        const allChecks = this._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
        selectAll.checked = allChecks.length > 0 && Array.from(allChecks).every(c => c.checked);
      }
      this._validateRecordingSetup();
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
    this._hass.connection.sendMessagePromise({
      type: "log_manager/profile_save",
      name: name,
      loggers: loggers,
      level_overrides: levelOverrides,
      max_duration: this._recordingMaxDuration || 300,
    }).then(res => {
      this._renderProfileOptions((res && res.profiles) || []);
      this._profileSelect.value = name;
      this._profileDeleteBtn.disabled = false;
    }).catch(err => console.error("Failed to save profile:", err));
  }

  _validateRecordingSetup() {
    const checked = this._loggerChecklist.querySelectorAll("input[type='checkbox']:checked:not(#select-all-checkbox)");
    this._recordingSetupStart.disabled = checked.length === 0;
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
    if (this._livePreview) this._livePreview.innerHTML = "";
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
    }).then(res => {
      this._recordingMaxDuration = (res && res.max_duration) || 300;
      this._openLiveView();
    }).catch(err => {
      console.error("Failed to start recording:", err);
      this._recordingState = null;
      this._cleanupRecordingIntervals();
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
        this._showRecordingResults();
      }
    }).catch(err => {
      console.error("Failed to stop recording:", err);
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
      undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    );
    const level = entry.level;
    const colors = this._levelColors(level);
    const logger = this._escapeHtml(entry.logger);
    const msg = this._escapeHtml(entry.message);
    return `<div class="log-preview-line" data-id="${entry.id}" data-logger="${this._escapeAttr(entry.logger)}" data-level="${this._escapeAttr(level)}" data-key="${this._escapeAttr(this._dedupKey(entry))}" style="background: ${colors.rowBg};">
      <span class="log-preview-col idx-col">${entry.id + 1}</span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${this._escapeHtml(level)}</span>
      <span class="log-preview-col time-col">${time}</span>
      <span class="log-preview-col logger-col" title="${this._escapeAttr(entry.logger)}">${logger}</span>
      <span class="log-preview-col msg-col">${msg}</span>
    </div>`;
  }

  _resultsGroupHtml(run) {
    const colors = this._levelColors(run.level);
    const logger = this._escapeHtml(run.logger);
    const msg = this._escapeHtml(run.message);
    const items = run.times.map(ts => {
      const time = new Date(ts * 1000).toLocaleTimeString(
        undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
      );
      return `<div class="log-preview-group-item">${time}</div>`;
    }).join("");
    // Results groups always start collapsed; live expansions don't transfer.
    return `<div class="log-preview-group" data-logger="${this._escapeAttr(run.logger)}" data-level="${this._escapeAttr(run.level)}" data-key="${this._escapeAttr(run.key)}" data-first-id="${run.firstId}" data-count="${run.count}" data-ids="${this._escapeAttr(run.ids.join(","))}" style="background: ${colors.rowBg};" title="Identical entries grouped — click to expand">
      <span class="log-preview-col idx-col">${run.firstId + 1}</span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${this._escapeHtml(run.level)}</span>
      <span class="log-preview-col time-col">${this._dedupRangeText(run.firstTs, run.lastTs)}</span>
      <span class="log-preview-col logger-col" title="${this._escapeAttr(run.logger)}">${logger}</span>
      <span class="log-preview-col msg-col">${msg}<span class="dedup-count">×${run.count}</span></span>
    </div><div class="log-preview-group-items" style="display: none;">${items}</div>`;
  }

  _rebuildResultsPreview() {
    const container = this._livePreview;
    if (!container) return;
    if (this._recordingBuffer.length === 0) {
      container.innerHTML = `<div style="color: var(--secondary-text-color); font-style: italic;">No log entries were captured.</div>`;
      return;
    }
    const levelFilter = this._liveLevelFilter.value;
    const loggerFilter = this._liveLoggerFilter.value;
    let html = this._previewHeaderHtml();
    const ordered = this._recordingBuffer.slice().reverse();
    if (!this._isDedupEnabled()) {
      ordered.forEach(entry => {
        html += this._resultsLineHtml(entry);
      });
    } else {
      // Newest-first like the results view; filters apply so the visible
      // stream groups the same way it does while live.
      for (const run of this._groupConsecutiveDedup(ordered)) {
        if (!this._entryMatchesFilter({ logger: run.logger, level: run.level }, levelFilter, loggerFilter)) continue;
        html += run.count === 1 ? this._resultsLineHtml(run.first) : this._resultsGroupHtml(run);
      }
    }
    container.innerHTML = html;
    // The preview DOM was replaced: live trackers reference detached nodes.
    this._liveLastGroup = null;
    this._liveLastSingle = null;
    container.querySelectorAll(".log-preview-group").forEach(row => {
      const items = row.nextElementSibling;
      if (!items || !items.classList.contains("log-preview-group-items")) return;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        items.style.display = items.style.display === "none" ? "" : "none";
      });
    });
    container.scrollTop = 0;
  }

  _summarizeResults(logs) {
    const severityOrder = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
    const severity = {};
    const loggers = {};
    const repeats = {};
    for (const entry of logs) {
      severity[entry.level] = (severity[entry.level] || 0) + 1;
      loggers[entry.logger] = (loggers[entry.logger] || 0) + 1;
      const key = this._dedupKey(entry);
      if (!repeats[key]) {
        repeats[key] = {
          key,
          logger: entry.logger,
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
      host.insertBefore(el, this._livePreview);
    }
    return el;
  }

  _hideResultsSummary() {
    this._resultsSummaryFilter = null;
    const host = this._livePreview && this._livePreview.parentElement;
    const el = host && host.querySelector("#results-summary");
    if (el) el.style.display = "none";
  }

  _renderResultsSummary() {
    const el = this._ensureResultsSummaryEl();
    if (!el) return;
    const summary = this._summarizeResults(this._recordingBuffer);
    if (summary.total === 0) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    const active = this._resultsSummaryFilter;
    const esc = (s) => this._escapeHtml(String(s == null ? "" : s));
    const escAttr = (s) => this._escapeAttr(String(s == null ? "" : s));
    const sevLine = summary.severity.map(({ level, count }) => {
      const colors = this._levelColors(level);
      const label = `${level} ${count}`;
      // Only standard severities map onto the minimum-level dropdown.
      if (!["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"].includes(level)) {
        return `<span style="color: ${colors.color};">${esc(label)}</span>`;
      }
      const isActive = this._liveLevelFilter && this._liveLevelFilter.value === level;
      return `<span class="results-summary-row${isActive ? " active" : ""}" data-filter-type="level" data-filter-value="${escAttr(level)}" title="Show only ${escAttr(level)} and above"><span style="color: ${colors.color};">${esc(label)}</span></span>`;
    }).join(" · ");
    const loggerRows = summary.loggers.top.map(({ label, logger, count }) => {
      const isActive = this._liveLoggerFilter && this._liveLoggerFilter.value === logger;
      return `<div class="results-summary-row${isActive ? " active" : ""}" data-filter-type="logger" data-filter-value="${escAttr(logger)}" title="Show only ${escAttr(label)}"><span class="results-summary-label">${esc(label)}</span><span>${count}</span></div>`;
    }).join("") + (summary.loggers.more > 0 ? `<div class="results-summary-more">+${summary.loggers.more} more</div>` : "");
    const repeatRows = summary.repeats.top.map(({ key, logger, level, message, count }) => {
      const text = String(message == null ? "" : message);
      const short = text.length > 80 ? text.slice(0, 80) + "…" : text;
      const isActive = active && active.type === "repeat" && active.value === key;
      return `<div class="results-summary-row${isActive ? " active" : ""}" data-filter-type="repeat" data-filter-value="${escAttr(key)}" title="${escAttr(text)}"><span class="results-summary-label">${esc(logger)} ${esc(level)}</span><span>${esc(short)} <strong>×${count}</strong></span></div>`;
    }).join("") + (summary.repeats.more > 0 ? `<div class="results-summary-more">+${summary.repeats.more} more</div>` : "");
    el.innerHTML = `<div>${sevLine}</div>${loggerRows}${repeatRows}`;
    el.style.display = "";
    el.querySelectorAll(".results-summary-row").forEach(row => {
      row.addEventListener("click", () => this._onSummaryRowClick(row));
    });
  }

  _onSummaryRowClick(row) {
    const type = row.dataset.filterType;
    const value = row.dataset.filterValue;
    const active = this._resultsSummaryFilter;
    if (active && active.type === type && active.value === value) {
      // Toggle off: restore the dropdown-driven view.
      this._resultsSummaryFilter = null;
      this._rebuildResultsPreview();
      this._renderResultsSummary();
      return;
    }
    if (type === "level") {
      this._resultsSummaryFilter = null;
      // Toggle off restores the unfiltered view.
      this._liveLevelFilter.value = this._liveLevelFilter.value === value ? "ALL" : value;
      this._rebuildResultsPreview();
      this._renderResultsSummary();
    } else if (type === "logger") {
      this._resultsSummaryFilter = null;
      this._liveLoggerFilter.value = this._liveLoggerFilter.value === value ? "" : value;
      this._rebuildResultsPreview();
      this._renderResultsSummary();
    } else if (type === "repeat") {
      // Hide-only overlay on the rendered runs: no regroup, counts untouched.
      this._resultsSummaryFilter = { type, value };
      this._applySummaryRepeatFilter();
      this._renderResultsSummary();
    }
  }

  _applySummaryRepeatFilter() {
    const filter = this._resultsSummaryFilter;
    if (!filter || filter.type !== "repeat" || !this._livePreview) return;
    this._livePreview
      .querySelectorAll(".log-preview-line, .log-preview-group")
      .forEach(el => {
        const show = el.dataset.key === filter.value;
        el.style.display = show ? "" : "none";
        const items = el.nextElementSibling;
        if (items && items.classList.contains("log-preview-group-items")) {
          items.style.display = show ? items.style.display : "none";
        }
      });
  }

  _showRecordingResults() {
    const logs = this._recordingBuffer;
    const duration = this._recordingDuration;
    const count = this._recordingLogCount;
    const hasEntries = count > 0;

    // Hide live top bar, show completed state.
    this._liveStatusText.parentElement.style.display = "none";
    this._livePauseBtn.style.display = "none";
    this._liveStopBtn.style.display = "none";
    this._liveCloseBtn.textContent = "Close";
    this._liveCloseBtn.title = "The recorded data stays available until you discard it.";
    this._liveClearBtn.style.display = "none";
    this._liveDiscardBtn.style.display = "";

    this._liveSavePlainBtn.disabled = !hasEntries;
    this._liveSaveJsonlBtn.disabled = !hasEntries;
    this._liveCopyBtn.disabled = !hasEntries;
    this._liveSavePlainBtn.title = "Save all recorded entries as a plain-text .log file";
    this._liveSaveJsonlBtn.title = "Save all recorded entries as JSON Lines (.jsonl) — one JSON object per line (timestamp, level, logger, message, source); easy to process programmatically.";
    this._liveCopyBtn.title = "Copy all recorded entries to clipboard";
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
      this._livePreview.innerHTML = `<div style="color: var(--secondary-text-color); font-style: italic;">No log entries were captured.</div>`;
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
    // A completed recording stays available until explicitly discarded.
    if (this._recordingState === "results") {
      this._recordingState = "completed";
    }
    this._updateRecordingUI();
  }

  _downloadLogs(format) {
    const logs = this._recordingBuffer;
    const now = new Date();
    const dateStr = now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, "0") +
      String(now.getDate()).padStart(2, "0") + "_" +
      String(now.getHours()).padStart(2, "0") +
      String(now.getMinutes()).padStart(2, "0") +
      String(now.getSeconds()).padStart(2, "0");

    let content, filename, mimeType;

    if (format === "plain") {
      const lines = logs.map(entry => {
        const time = new Date(entry.timestamp * 1000).toLocaleString(undefined, {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        });
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
    const text = logs.map(entry => {
      const time = new Date(entry.timestamp * 1000).toLocaleString(undefined, {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      });
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
    this._resultsShown = false;
    this._hideResultsSummary();

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
    this._livePauseBtn.title = "Pause viewer update";
    this._liveStopBtn.style.display = "";
    this._liveCloseBtn.textContent = "Close & Keep Recording";
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

    // Start polling for entries. Timer always updates; polling gates on pause.
    this._pollRecordingEntries();
    this._livePollInterval = setInterval(() => {
      if (!this._livePaused) {
        this._pollRecordingEntries();
      }
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
      this._liveStatusText.textContent = "Recording Complete";
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
      this._appendLiveEntries(entries);
      this._updateLiveSummary();
    }).catch(() => {});
  }

  _dedupKey(entry) {
    return `${entry.logger}${entry.level}${entry.message}${entry.source || ""}`;
  }

  _isDedupEnabled() {
    return !this.config || this.config.live_dedup !== false;
  }

  _dedupMinute(ts) {
    return new Date(ts * 1000).toLocaleTimeString(
      undefined, { hour: "2-digit", minute: "2-digit", hour12: false }
    );
  }

  _dedupRangeText(firstTs, lastTs) {
    const first = this._dedupMinute(firstTs);
    const last = this._dedupMinute(lastTs);
    return first === last ? first : `${first}–${last}`;
  }

  _dedupRowInnerHtml(run, colors) {
    const logger = this._escapeHtml(run.logger);
    const msg = this._escapeHtml(run.message);
    return `<span class="log-preview-col idx-col">${run.firstId + 1}</span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${this._escapeHtml(run.level)}</span>
      <span class="log-preview-col time-col">${this._dedupRangeText(run.firstTs, run.lastTs)}</span>
      <span class="log-preview-col logger-col" title="${this._escapeAttr(run.logger)}">${logger}</span>
      <span class="log-preview-col msg-col">${msg}<span class="dedup-count">×${run.count}</span></span>`;
  }

  _dedupItemsInnerHtml(run) {
    return run.times.map(ts => {
      const time = new Date(ts * 1000).toLocaleTimeString(
        undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
      );
      return `<div class="log-preview-group-item">${time}</div>`;
    }).join("");
  }

  _wireDedupToggle(row, items, key) {
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      const expanded = items.style.display === "none";
      items.style.display = expanded ? "" : "none";
      if (expanded) {
        this._expandedDedupKeys.add(key);
      } else {
        this._expandedDedupKeys.delete(key);
      }
    });
  }

  _startDedupGroup(container, firstEntry, secondEntry) {
    const key = this._dedupKey(firstEntry);
    const run = {
      key,
      logger: firstEntry.logger,
      level: firstEntry.level,
      message: firstEntry.message,
      source: firstEntry.source || "",
      firstId: firstEntry.id,
      firstTs: firstEntry.timestamp,
      lastTs: secondEntry.timestamp,
      count: 2,
      times: [firstEntry.timestamp, secondEntry.timestamp],
    };
    const colors = this._levelColors(run.level);
    const row = document.createElement("div");
    row.className = "log-preview-group";
    row.dataset.logger = run.logger;
    row.dataset.level = run.level;
    row.dataset.key = run.key;
    row.dataset.firstId = String(run.firstId);
    row.dataset.count = String(run.count);
    row.dataset.ids = [firstEntry.id, secondEntry.id].join(",");
    row.style.background = colors.rowBg;
    row.title = "Identical entries grouped — click to expand";
    row.innerHTML = this._dedupRowInnerHtml(run, colors);
    const items = document.createElement("div");
    items.className = "log-preview-group-items";
    items.style.display = this._expandedDedupKeys.has(key) ? "" : "none";
    items.innerHTML = this._dedupItemsInnerHtml(run);
    this._wireDedupToggle(row, items, key);
    container.appendChild(row);
    container.appendChild(items);
    return { key, row, items, count: run.count, firstTs: run.firstTs, lastTs: run.lastTs, ids: [firstEntry.id, secondEntry.id] };
  }

  _bumpDedupGroup(group, entry) {
    group.count += 1;
    group.lastTs = entry.timestamp;
    group.ids.push(entry.id);
    group.row.querySelector(".dedup-count").textContent = `×${group.count}`;
    group.row.dataset.count = String(group.count);
    group.row.dataset.ids = group.ids.join(",");
    group.row.querySelector(".time-col").textContent = this._dedupRangeText(
      group.firstTs, group.lastTs
    );
    const item = document.createElement("div");
    item.className = "log-preview-group-item";
    item.textContent = new Date(entry.timestamp * 1000).toLocaleTimeString(
      undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    );
    group.items.appendChild(item);
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
    const div = document.createElement("div");
    div.className = "log-preview-line";
    div.dataset.logger = entry.logger;
    div.dataset.level = entry.level;
    div.dataset.key = key;
    div.dataset.id = entry.id;
    const colors = this._levelColors(entry.level);
    const time = new Date(entry.timestamp * 1000).toLocaleTimeString(
      undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    );
    div.style.background = colors.rowBg;
    div.innerHTML = `<span class="log-preview-col idx-col">${entry.id + 1}</span>
      <span class="log-preview-col level-col" style="color: ${colors.color};">${this._escapeHtml(entry.level)}</span>
      <span class="log-preview-col time-col">${time}</span>
      <span class="log-preview-col logger-col" title="${this._escapeAttr(entry.logger)}">${this._escapeHtml(entry.logger)}</span>
      <span class="log-preview-col msg-col">${this._escapeHtml(entry.message)}</span>`;
    container.appendChild(div);
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
    for (const entry of this._recordingBuffer) {
      if (!this._entryMatchesFilter(entry, levelFilter, loggerFilter)) continue;
      this._appendDedupEntry(container, entry);
    }
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
      const time = new Date(entry.timestamp * 1000).toLocaleTimeString(
        undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
      );
      const level = entry.level;
      const colors = this._levelColors(level);
      const logger = this._escapeHtml(entry.logger);
      const msg = this._escapeHtml(entry.message);
      const div = document.createElement("div");
      div.className = "log-preview-line";
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

      // Apply current filters.
      div.style.display = this._entryMatchesFilter(entry, levelFilter, loggerFilter) ? "" : "none";

      container.appendChild(div);
    }

    if (atBottom) {
      container.scrollTop = container.scrollHeight;
    }
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
  }

  _entryMatchesFilter(entry, levelFilter, loggerFilter) {
    if (loggerFilter && entry.logger !== loggerFilter && !entry.logger.startsWith(loggerFilter + ".")) {
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
    // A dropdown change replaces any summary repeat overlay: single-select.
    this._resultsSummaryFilter = null;
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
  }

  _togglePauseLive() {
    this._livePaused = !this._livePaused;
    this._livePauseBtn.textContent = this._livePaused ? "Resume" : "Pause";
    this._livePauseBtn.title = this._livePaused ? "View paused — click to resume" : "Pause viewer update";
    if (this._recordingState === "recording") {
      this._liveStatusText.textContent = this._livePaused ? "Recording · view paused" : "Recording";
    }
    if (!this._livePaused) {
      this._pollRecordingEntries();
    }
  }

  _updateLiveSummary() {
    const seen = this._recordingBuffer.length;
    const hidden = Math.max(0, this._recordingBackendCount - seen);
    const bufferPct = Math.round((seen / 10000) * 100);
    const recordingCount = this._recordingLoggers.length;
    const withEntries = new Set(this._recordingBuffer.map(entry => entry.logger)).size;
    const seenText = `${seen} entr${seen === 1 ? "y" : "ies"}${hidden > 0 ? ` (${hidden} hidden)` : ""}`;
    this._liveSummary.textContent =
      `${seenText} \u00B7 buffer at ${bufferPct}% \u00B7 ` +
      `${recordingCount} logger${recordingCount === 1 ? "" : "s"} recording \u00B7 ` +
      `${withEntries} with entr${withEntries === 1 ? "y" : "ies"}`;
    this._updateExportButtonState();
  }

  _updateExportButtonState() {
    if (!this._liveSavePlainBtn) return;
    const hasEntries = this._recordingBuffer.length > 0;
    const scope = this._recordingState === "recording" ? "captured so far" : "all recorded";
    this._liveSavePlainBtn.disabled = !hasEntries;
    this._liveSaveJsonlBtn.disabled = !hasEntries;
    this._liveCopyBtn.disabled = !hasEntries;
    this._liveSavePlainBtn.title = `Save ${scope} entries as a plain-text .log file`;
    this._liveSaveJsonlBtn.title = `Save ${scope} entries as JSON Lines (.jsonl) — one JSON object per line (timestamp, level, logger, message, source); easy to process programmatically.`;
    this._liveCopyBtn.title = `Copy ${scope} entries to clipboard`;
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

  _showPreviewContextMenu(e) {
    const hasEntries = this._recordingBuffer.length > 0;
    const menu = this._previewContextMenu;
    menu.style.display = "block";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.querySelectorAll("button").forEach(btn => {
      btn.disabled = !hasEntries;
    });
  }

  _hidePreviewContextMenu() {
    if (this._previewContextMenu) {
      this._previewContextMenu.style.display = "none";
    }
  }

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
      const time = new Date(entry.timestamp * 1000).toLocaleString(undefined, {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      });
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
