class LogManagerCard extends HTMLElement {
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
    sessionStorage.removeItem("logManagerPath");
    sessionStorage.removeItem("logManagerName");
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

  _renderLogPanelHtml(loggerName) {
    const stats = this._counters[loggerName] || {"warning": 0, "error": 0, "recent_logs": []};
    const hasCounters = (stats.warning || 0) > 0 || (stats.error || 0) > 0;

    const recentLogs = stats.recent_logs || [];
    let entriesHtml = "";
    if (recentLogs.length === 0) {
      entriesHtml = `<div class="log-entry-empty">No recent log entries.</div>`;
    } else {
      recentLogs.forEach(entry => {
        const time = new Date(entry.timestamp * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
        const levelClass = entry.level === "ERROR" || entry.level === "CRITICAL"
          ? "log-level-error" : "log-level-warning";
        const levelLabel = entry.level === "CRITICAL" ? "C" : entry.level === "ERROR" ? "E" : "W";
        const msg = this._escapeHtml(entry.message);
        const src = entry.source ? this._escapeHtml(entry.source.split("/").pop()) : "";
        entriesHtml += `
          <div class="log-entry">
            <span class="log-time">${time}</span>
            <span class="log-level ${levelClass}">${levelLabel}</span>
            <span class="log-msg">${msg}</span>
            ${src ? `<span class="log-src">${src}</span>` : ""}
          </div>`;
      });
    }

    return `
      <div class="log-panel">
        <div class="log-entries">${entriesHtml}</div>
        <div class="log-disclaimer">Only WARNING and above are captured, regardless of configured level.</div>
        <button class="reset-btn" data-logger="${this._escapeAttr(loggerName)}"${hasCounters ? "" : " disabled"}>
          <ha-icon icon="mdi:refresh" style="--mdi-icon-size: 14px;"></ha-icon>
          Reset counters
        </button>
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
        this._counters[loggerName] = {"warning": 0, "error": 0, "last_warning": "", "last_error": "", "recent_logs": []};
      }
      this._updateActiveList();
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
          badge.innerHTML = `${icon} ${count}`;
          badge.setAttribute("title", title);
        } else {
          // Create badge element.
          if (!badgesContainer) {
            badgesContainer = document.createElement("div");
            badgesContainer.className = "counter-badges";
            row.insertBefore(badgesContainer, row.querySelector(".log-controls"));
          }
          badge = document.createElement("span");
          badge.className = `counter-badge ${cls}`;
          badge.title = title;
          badge.dataset.logger = loggerName;
          badge.innerHTML = `${icon} ${count}`;
          badge.addEventListener("click", (e) => {
            e.stopPropagation();
            this._toggleExpand(loggerName);
          });
          badgesContainer.appendChild(badge);
        }
      }
      return null; // not used
    };

    upsertBadge("warning-badge", warningCount, "&#9888;", "warning");
    upsertBadge("error-badge", errorCount, "&#10005;", "error");

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
  _showDeleteConfirm(displayName, onConfirm) {
    this._deleteConfirmTarget = { displayName, onConfirm };
    this._deleteDialog.querySelector(".delete-dialog-message").textContent =
      `Remove logger "${displayName}"? This cannot be undone.`;
    this._deleteDialog.style.display = "flex";
  }

  set hass(hass) {
    this._hass = hass;

    if (!this._uiBuilt) {
      this._buildUI();
      this._fetchLoggers();
      this._uiBuilt = true;
    }

    // Debounce via rAF so we never do redundant DOM work within a single frame.
    if (!this._updateScheduled) {
      this._updateScheduled = true;
      requestAnimationFrame(() => {
        try { this._updateActiveList(); }
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

        .counter-badges { display: flex; align-items: center; gap: 4px; flex-shrink: 0; margin-right: 8px; }

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

    this._pathInput.value = this._savedPath;
    this._friendlyNameInput.value = this._savedName;

    // Delete dialog handlers.
    this.shadowRoot.getElementById("delete-cancel-btn").addEventListener("click", () => {
      this._deleteDialog.style.display = "none";
      this._deleteConfirmTarget = null;
    });

    this.shadowRoot.getElementById("delete-confirm-btn").addEventListener("click", () => {
      if (this._deleteConfirmTarget) {
        this._deleteConfirmTarget.onConfirm();
        this._deleteConfirmTarget = null;
      }
      this._deleteDialog.style.display = "none";
    });

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

    this._pathInput.addEventListener("keydown", handleEscKey);
    this._friendlyNameInput.addEventListener("keydown", handleEscKey);

    this._friendlyNameInput.addEventListener("input", () => {
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
      }

      this._clearState();
      this._closeAddSection();
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
          : `<select class="level-select">${selectOptions}</select>`;

        const counterBadgeHtml = this._renderCounterBadgeHtml(actualLoggerName);
        const counterBadgesDiv = counterBadgeHtml ? `<div class="counter-badges">${counterBadgeHtml}</div>` : "";

        const isExpanded = this._expandedLogger === actualLoggerName;
        const logPanelHtml = isExpanded ? this._renderLogPanelHtml(actualLoggerName) : "";

        row.innerHTML = `
          <div class="log-name ${isUnavailable ? "unavailable" : ""}">
            <div style="font-weight: 500;">${displayName}</div>
            <div style="color: var(--secondary-text-color); font-size: 12px; margin-top: 2px;">
              ${actualLoggerName}
            </div>
          </div>
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
          this._showDeleteConfirm(displayName, () => {
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
            }
          } else {
            row.insertAdjacentHTML("beforeend", panelHtml);
            this._prevPanelHtml[actualLoggerName] = panelHtml;
            this._attachResetHandler(row);
          }
        } else if (panel) {
          panel.remove();
          delete this._prevPanelHtml[actualLoggerName];
        }
      }

      // Cache state for next update to avoid unnecessary DOM touches.
      this._prevRowStates[eid] = {
        level: currentLevel,
        warningCount: curWarn,
        errorCount: curErr
      };

      const expectedNode = this._activeList.children[index] || null;
      if (expectedNode !== row) {
        this._activeList.insertBefore(row, expectedNode);
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