import { concern, registerConcern } from "./card-core.js";
import { utils } from "./card-utils.js";
import { ui } from "./card-ui.js";

// Late-bound cross-module seam: `card-core.js` holds the registry, so this
// module has no static import of its callers.
const addForm = concern("addForm");
const selection = concern("selection");

// loggers concern for the Log Manager card.
// Extracted from the entry card. Each function takes the card instance
// and keeps its `this`-state and existing method names unchanged.

// Audit-trail display policy, mirroring AUDIT_KEEP/AUDIT_SHOW.
// Backend keeps AUDIT_KEEP entries per logger (see MAX_AUDIT in const.py); the
// panel shows newest AUDIT_SHOW.
const AUDIT_KEEP = 5;
const AUDIT_SHOW = 3;

// Why a core-pinned logger's level cannot be changed from the card. Exposed on
// the `loggers` API object so the add/edit rows use one shared string.
export const PINNED_REASON = "Managed by Home Assistant; not editable from the card.";

// Shared counter-badge tooltip, so the wording is defined once for the initial
// render and the in-place update path.
function counterBadgeTitle(label) {
  return label === "warning" ? "View captured warnings" : "View captured errors";
}

// Show a styled delete confirmation dialog instead of browser confirm().
// Used by every concern that needs a destructive-action prompt; the dialog
// element and its confirm/cancel wiring live on the card shell.
export function showDeleteConfirm(card, message, onConfirm, title = "Remove logger", confirmLabel = "Remove", onCancel = null, htmlMessage = false) {
    card._deleteConfirmTarget = { onConfirm, onCancel };
    card._deleteDialog.querySelector(".delete-dialog-title").textContent = title;
    const msgEl = card._deleteDialog.querySelector(".delete-dialog-message");
    // Only pre-escaped HTML is passed here; plain text remains the safe default.
    if (htmlMessage) msgEl.innerHTML = message;
    else msgEl.textContent = message;
    card.shadowRoot.getElementById("delete-confirm-btn").textContent = confirmLabel;
    card._deleteDialog.style.display = "flex";
  }

export function fetchCounters(card) {
    if (!card._hass || !card._hass.connection) return;
    const now = Date.now();
    if (now - card._lastCounterFetch < 5000) return;
    card._lastCounterFetch = now;

    card._hass.connection.sendMessagePromise({ type: "log_manager/get_stats" }).then(res => {
      // Only re-render if counter data actually changed, to preserve hover tooltips.
      if (JSON.stringify(card._counters) !== JSON.stringify(res)) {
        card._counters = res;
        addForm.updateActiveList(card);
      }
    }).catch(() => {});
  }

export function renderCounterBadgeHtml(card, loggerName) {
    const stats = card._counters[loggerName];
    if (!stats) return "";

    const warningCount = stats.warning || 0;
    const errorCount = stats.error || 0;
    if (warningCount === 0 && errorCount === 0) return "";

    let html = "";
    if (warningCount > 0) {
      const title = counterBadgeTitle("warning");
      html += `<span class="counter-badge warning-badge" title="${utils.escapeAttr(title)}" data-logger="${utils.escapeAttr(loggerName)}">&#9888; ${warningCount}</span>`;
    }
    if (errorCount > 0) {
      const title = counterBadgeTitle("error");
      html += `<span class="counter-badge error-badge" title="${utils.escapeAttr(title)}" data-logger="${utils.escapeAttr(loggerName)}">&#10005; ${errorCount}</span>`;
    }
    return html;
  }

export function effectiveChipInfo(card, stateObj, currentLevel, isUnavailable) {
    if (isUnavailable || currentLevel !== "NOTSET") return null;
    const effectiveLevel = stateObj.attributes.effective_level;
    if (!effectiveLevel) return null;
    const effectiveSource = stateObj.attributes.effective_source;
    const sourceText = (!effectiveSource || effectiveSource === "root")
      ? `Effective level ${effectiveLevel} from the root logger`
      : `Effective level ${effectiveLevel} inherited from ${effectiveSource}`;
    return { effectiveLevel, sourceText };
  }

export function renderEffectiveChip(card, stateObj, currentLevel, isUnavailable) {
    const info = effectiveChipInfo(card, stateObj, currentLevel, isUnavailable);
    if (!info) return "";
    const colors = utils.levelColors(info.effectiveLevel);
    return `<div class="effective-line" style="color: ${colors.color};" title="${utils.escapeAttr(info.sourceText)}">Effective: <span class="effective-level" style="color: ${colors.color};">${utils.escapeHtml(info.effectiveLevel)}</span></div>`;
  }

export function updateEffectiveChipInPlace(card, pathDiv, stateObj, currentLevel, isUnavailable) {
    const existing = pathDiv.querySelector(".effective-line");
    const html = renderEffectiveChip(card, stateObj, currentLevel, isUnavailable);
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

export function updateRaisedChipInPlace(card, pathDiv, html) {
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
    // innerHTML preserves the severity-coloured level span inside the chip.
    existing.innerHTML = freshLine.innerHTML;
    existing.setAttribute("title", freshLine.getAttribute("title") || "");
  }

export function setSelectTitle(card, select, title) {
    if (!select) return;
    if (title) select.setAttribute("title", title);
    else select.removeAttribute("title");
  }

export function findEntityIdByLogger(card, loggerName) {
    if (!card._hass) return null;
    const eid = Object.keys(card._hass.states).find(id => {
      if (!id.startsWith("select.")) return false;
      return card._hass.states[id].attributes.logger_name === loggerName;
    });
    return eid || null;
  }

export function effectiveGateLevel(card, loggerName) {
  const eid = findEntityIdByLogger(card, loggerName);
  if (!eid) return null;
  const attrs = card._hass.states[eid].attributes || {};
  return attrs.effective_level || null;
}

export function isGroupingEnabled(card) {
    return !card.config || card.config.group_by_prefix !== false;
  }

export function getCollapsedGroups(card) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem("log_manager_collapsed_groups") || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Corrupt JSON falls through to the empty default below.
    }
    return {};
  }

export function setGroupCollapsed(card, prefix, collapsed) {
    try {
      const map = getCollapsedGroups(card);
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

export function buildLoggerTree(card, names) {
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

export function ensureGroupHeader(card, item) {
    let el = Array.from(card._activeList.children).find(
      e => e.classList && e.classList.contains("log-group-header") && e.dataset.group === item.key
    ) || null;
    const collapsed = !!getCollapsedGroups(card)[item.key];
    const chevron = collapsed ? "\u25B8" : "\u25BE";
    if (!el) {
      el = document.createElement("div");
      el.className = "log-group-header";
      el.dataset.group = item.key;
      el.title = "Toggle section";
      el.innerHTML = `<span class="log-group-chevron"></span><span class="log-group-name"></span><span class="log-group-count"></span>`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        setGroupCollapsed(card, item.key, !getCollapsedGroups(card)[item.key]);
        addForm.updateActiveList(card);
      });
    }
    el.querySelector(".log-group-chevron").textContent = chevron;
    el.querySelector(".log-group-name").textContent = item.label;
    el.querySelector(".log-group-count").textContent = `(${item.count})`;
    return el;
  }

export function getAlertInfo(card, loggerName) {
    const eid = findEntityIdByLogger(card, loggerName);
    if (!eid) {
      return { threshold: 0, level: "ERROR", disabled: true, unavailable: true };
    }
    const stateObj = card._hass.states[eid];
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

export function getAuditEntries(card, loggerName) {
    const eid = findEntityIdByLogger(card, loggerName);
    if (!eid) return [];
    const audit = card._hass.states[eid].attributes.audit || [];
    return Array.isArray(audit)
      ? audit.slice(0, AUDIT_KEEP)
      : [];
  }

export function auditTitle(card, loggerName) {
    const entries = getAuditEntries(card, loggerName);
    if (!entries || entries.length === 0) return "";
    const sourceLabels = { ui: "UI", core: "Home Assistant" };
    return entries.slice(0, AUDIT_SHOW).map(a => {
      const when = utils.formatDateTime(a.ts, card._hass);
      const who = sourceLabels[a.source] || a.source || "unknown";
      return `${a.old_level || "?"} \u2192 ${a.new_level || "?"} by ${who} at ${when}`;
    }).join("\n");
  }

export function auditSourceLabel(card, source) {
    return { ui: "UI", core: "Home Assistant" }[source] || source || "unknown";
  }

export function historyRowsHtml(card, loggerName) {
    const entries = getAuditEntries(card, loggerName).slice(0, AUDIT_SHOW);
    if (entries.length === 0) {
      return `<tr><td colspan="4" style="color: var(--secondary-text-color); font-style: italic;">No level changes recorded.</td></tr>`;
    }
    return entries.map(a => {
      const when = utils.formatDateTime(a.ts, card._hass);
      return `<tr>
        <td>${utils.escapeHtml(when)}</td>
        <td>${utils.escapeHtml(auditSourceLabel(card, a.source))}</td>
        <td>${levelPillHtml(card, a.old_level || "?")}</td>
        <td>${levelPillHtml(card, a.new_level || "?")}</td>
      </tr>`;
    }).join("");
  }

export function openHistoryDialog(card, loggerName) {
    if (!card._historyDialog) return;
    card._historyLoggerPath = loggerName;
    if (card._historyLoggerName) {
      const { friendly, path } = loggerDisplay(card, loggerName);
      card._historyLoggerName.textContent = friendly === path ? path : `${friendly} (${path})`;
      card._historyLoggerName.title = path;
    }
    if (card._historyTableBody) card._historyTableBody.innerHTML = historyRowsHtml(card, loggerName);
    card._historyDialog.style.display = "flex";
    requestAnimationFrame(() => card._historyDialog.classList.add("visible"));
  }

export function renderLogPanelHtml(card, loggerName) {
    const stats = card._counters[loggerName] || {"warning": 0, "error": 0, "recent_logs": [], "levels": {}};

    const alertInfo = getAlertInfo(card, loggerName);
    const auditHistory = auditTitle(card, loggerName);

    const recentLogs = stats.recent_logs || [];
    const hasEntries = recentLogs.length > 0;
    let entriesHtml = "";
    if (recentLogs.length === 0) {
      entriesHtml = `<div class="log-entry-empty">No recent warning+ entries.</div>`;
    } else {
      const levelChips = {
        "CRITICAL": ["C", "log-level-error"],
        "ERROR": ["E", "log-level-error"],
        "WARNING": ["W", "log-level-warning"],
        "INFO": ["I", "log-level-info"],
        "DEBUG": ["D", "log-level-debug"],
      };
      recentLogs.forEach((entry, index) => {
        const time = utils.formatClockTime(entry.timestamp, card._hass);
        const chip = levelChips[entry.level] || [entry.level.charAt(0), "log-level-debug"];
        const colors = utils.levelColors(entry.level);
        const msg = utils.escapeHtml(entry.message);
        const src = entry.source ? utils.escapeHtml(entry.source.split("/").pop()) : "";
        entriesHtml += `
          <div class="log-entry selectable-entry" data-entry-index="${index}" data-sel-keys="${utils.escapeAttr(JSON.stringify([selection.entryKey(card, entry)]))}" draggable="false" style="background: ${colors.rowBg}; border-left: 2px solid ${colors.color};">
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
          : utils.levelColors(l).color;
        return `<option value="${l}" style="color: ${color};"${selected ? " selected" : ""}>${l}</option>`;
      }).join("");
    const alertColors = alertDisabled
      ? { color: "var(--secondary-text-color)" }
      : utils.levelColors(alertInfo.level);
    const thresholdValue = alertDisabled ? 1 : Math.max(1, alertInfo.threshold);
    const thresholdHidden = alertDisabled ? ' style="display: none;"' : "";

    // The counting floor is fixed at WARNING; explain only when the logger's
    // own level is numerically stricter, since then its events never alert.
    // Hidden when the effective level is unknown.
    const gateLevel = effectiveGateLevel(card, loggerName);
    const gateSeverity = gateLevel ? utils.entrySeverity(gateLevel) : -1;
    const gateStricter = gateSeverity > utils.entrySeverity("WARNING");
    const gateColor = gateStricter ? utils.levelColors(gateLevel).color : "";
    const countWarningHtml = gateStricter
      ? `<div class="count-warning">This logger is set to <span style="color: ${gateColor}; font-weight: 600;">${utils.escapeHtml(gateLevel)}</span>, so events below it never alert.</div>`
      : "";

    // Static explanation of what the panel shows. "WARNINGs" is tinted with the
    // warning severity colour. Independent of the logger's own level.
    const warnColor = utils.levelColors("WARNING").color;
    const disclaimerHtml = `<div class="log-disclaimer">This panel shows recent <span style="color: ${warnColor}; font-weight: 600;">WARNINGs</span> and above, separately from any recording.</div>`;

    return `
      <div class="log-panel">
        <div class="panel-controls-row">
          <label class="alert-row" title="Notify after this many events at the chosen level or above. DISABLED turns it off.">
            Alert:
            <select class="alert-level-select" data-logger="${utils.escapeAttr(loggerName)}" style="color: ${alertColors.color}; border-color: ${alertColors.color};"${alertInfo.unavailable ? " disabled" : ""}>${alertOptions}</select>
            ${alertDisabled ? "" : "<span>&ge;</span>"}
            <input class="alert-threshold-input" type="number" min="1" max="100000" step="1" value="${thresholdValue}" data-logger="${utils.escapeAttr(loggerName)}"${thresholdHidden}${alertInfo.unavailable ? " disabled" : ""}>
          </label>
          <button type="button" class="icon-btn history-btn" data-logger="${utils.escapeAttr(loggerName)}" title="${utils.escapeAttr(auditHistory ? `Show level-change history\n\n${auditHistory}` : "Show level-change history")}">
            <ha-icon icon="mdi:history" style="--mdi-icon-size: 14px;"></ha-icon>
          </button>
        </div>
        ${countWarningHtml}
        <div class="log-entries">${entriesHtml}</div>
        ${hasEntries ? `<div class="selection-hint">Click to select &middot; Ctrl/Cmd-click or drag to select more</div>` : ""}
        ${disclaimerHtml}
        ${hasEntries ? `<div style="display: flex; gap: 8px; margin-top: 8px;">
          <button class="reset-btn" data-logger="${utils.escapeAttr(loggerName)}" title="Clear captured entries and counts.">
            <ha-icon icon="mdi:refresh" style="--mdi-icon-size: 14px;"></ha-icon>
            Clear
          </button>
          <button class="copy-panel-btn" data-logger="${utils.escapeAttr(loggerName)}" title="Copy selected entries, or all captured entries.">
            <ha-icon icon="mdi:content-copy" style="--mdi-icon-size: 14px;"></ha-icon>
            Copy
          </button>
        </div>` : ""}
      </div>`;
  }

export function attachBadgeHandlers(card, row) {
    row.querySelectorAll(".counter-badge").forEach(badge => {
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        const loggerName = badge.dataset.logger;
        if (!loggerName) return;
        addForm.toggleExpand(card, loggerName);
      });
    });
  }

export function attachResetHandler(card, row) {
    const btn = row.querySelector(".reset-btn");
    if (!btn) return;
    // Remove stale listeners to prevent duplicate handler accumulation.
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener("click", (e) => {
      e.stopPropagation();
      const loggerName = clone.dataset.logger;
      if (!loggerName) return;
      card._hass.callService("log_manager", "reset_counters", {
        logger_name: loggerName
      });
      // Clear counts and captured entries but keep the panel open.
      if (card._counters[loggerName]) {
        card._counters[loggerName] = {"warning": 0, "error": 0, "last_warning": "", "last_error": "", "recent_logs": [], "levels": {}};
      }
      // Force the panel rebuild even while the Clear button still holds focus.
      addForm.refreshAfterCommit(card, loggerName);
    });
  }

export function attachAlertHandler(card, row) {
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
      card._panelRefreshRequested = loggerName;
      card._hass.callService("log_manager", "set_alert_threshold", {
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
      // Colour every option, not just the selected DISABLED/severity value.
      ui.tintLevelOptions(sel);
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

export function attachHistoryHandler(card, row) {
    const btn = row.querySelector(".history-btn");
    if (!btn) return;
    // Remove stale listeners to prevent duplicate handler accumulation.
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener("click", (e) => {
      e.stopPropagation();
      const loggerName = clone.dataset.logger;
      if (loggerName) openHistoryDialog(card, loggerName);
    });
  }

export function updateBadgesInPlace(card, row, loggerName) {
    const stats = card._counters[loggerName];
    const warningCount = stats ? (stats.warning || 0) : 0;
    const errorCount = stats ? (stats.error || 0) : 0;

    let badgesContainer = row.querySelector(".counter-badges");

    const upsertBadge = (cls, count, icon, label) => {
      if (count > 0) {
        const title = counterBadgeTitle(label);
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
            addForm.toggleExpand(card, loggerName);
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

export function levelPillHtml(card, level) {
    const colors = utils.levelColors(level);
    return `<span style="color: ${colors.color}; font-weight: 600;">${utils.escapeHtml(level)}</span>`;
  }

export function renderRaisedChipHtml(card, loggerName, isRecording) {
    if (!isRecording) return "";
    const restore = (card._recordingRestoreLevels || {})[loggerName];
    if (!restore || !restore.raisedTo) return "";
    const title = `Restored to ${restore.level} when the recording ends`;
    const colors = utils.levelColors(restore.raisedTo);
    return `<div class="raised-line" title="${utils.escapeAttr(title)}">\u2191 Raised to <span style="color: ${colors.color}; font-weight: 600;">${utils.escapeHtml(restore.raisedTo)}</span></div>`;
  }

export function levelSourceLabel(card, loggerName, level) {
    const entries = getAuditEntries(card, loggerName);
    const match = entries.find(a => a.new_level === level);
    if (match) {
      // The card's own change is not restated: omit the "UI" attribution.
      const label = auditSourceLabel(card, match.source);
      return label === "UI" ? "" : label;
    }
    if (level === "NOTSET") return "inherited";
    return "";
  }

export function levelSelectTooltip(card, loggerName, currentLevel, isPinned, isRecording) {
    const parts = [];
    if (isPinned) {
      parts.push(PINNED_REASON);
    }
    if (isRecording) {
      parts.push("Locked while recording; stop to change it.");
    }
    if (currentLevel) {
      const source = levelSourceLabel(card, loggerName, currentLevel);
      parts.push(`Current level: ${currentLevel}${source ? ` (${source})` : ""}`);
    }
    return parts.join("\n\n");
  }

export function managedRootFor(card, loggerName) {
    // Resolve an emitting logger to its managed root (longest matching prefix),
    // preferring the active recording set, else all managed loggers.
    const candidates = (card._recordingLoggers && card._recordingLoggers.length)
      ? card._recordingLoggers
      : Object.values((card._hass && card._hass.states) || {})
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

export function loggerDisplay(card, loggerName) {
    const root = managedRootFor(card, loggerName);
    const stateObj = Object.values((card._hass && card._hass.states) || {}).find(
      s => s.attributes && s.attributes.logger_name === root
    );
    const friendly = stateObj ? (stateObj.attributes.friendly_name || root) : root;
    const child = loggerName.length > root.length ? loggerName.slice(root.length + 1) : "";
    return { friendly, child, path: loggerName };
  }

export function loggerCellHtml(card, loggerName) {
    const info = loggerDisplay(card, loggerName);
    const child = info.child
      ? ` <span class="logger-child">${utils.escapeHtml(info.child)}</span>`
      : "";
    return `${utils.escapeHtml(info.friendly)}${child}`;
  }

export function managedRoot(card, loggerName) {
    // Map an emitting (possibly child) logger back to its managed root so
    // "with entries" counts loggers, not distinct child logger names.
    let best = null;
    for (const name of card._recordingLoggers) {
      if (loggerName === name || loggerName.startsWith(name + ".")) {
        if (!best || name.length > best.length) best = name;
      }
    }
    return best || loggerName;
  }

// Mutable API object: the cross-concern call seam and the test stub target.
export const loggers = {
  showDeleteConfirm,
  fetchCounters,
  renderCounterBadgeHtml,
  effectiveChipInfo,
  renderEffectiveChip,
  updateEffectiveChipInPlace,
  updateRaisedChipInPlace,
  setSelectTitle,
  findEntityIdByLogger,
  effectiveGateLevel,
  isGroupingEnabled,
  getCollapsedGroups,
  setGroupCollapsed,
  buildLoggerTree,
  ensureGroupHeader,
  getAlertInfo,
  getAuditEntries,
  auditTitle,
  auditSourceLabel,
  historyRowsHtml,
  openHistoryDialog,
  renderLogPanelHtml,
  attachBadgeHandlers,
  attachResetHandler,
  attachAlertHandler,
  attachHistoryHandler,
  updateBadgesInPlace,
  levelPillHtml,
  renderRaisedChipHtml,
  levelSourceLabel,
  levelSelectTooltip,
  managedRootFor,
  loggerDisplay,
  loggerCellHtml,
  managedRoot,
  PINNED_REASON,
};
registerConcern("loggers", loggers);
