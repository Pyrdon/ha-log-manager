import { concern, registerConcern } from "./card-core.js";
import { utils } from "./card-utils.js";
import { ui } from "./card-ui.js";

// Late-bound cross-module seam: `card-core.js` holds the registry.
const contextMenu = concern("contextMenu");
const loggers = concern("loggers");
const recordingSession = concern("recordingSession");
const recordingSetup = concern("recordingSetup");
const selection = concern("selection");

// addForm concern for the Log Manager card.
//
// Extracted from the entry card. Each function takes the card instance and
// keeps its `this`-state and existing method names unchanged: the element
// delegates by name, and cross-concern calls go through `card._method()` so
// behaviour is identical to the inlined originals.

export function persistState(card) {
  if (card._pathInput) sessionStorage.setItem("logManagerPath", card._pathInput.value);
  if (card._friendlyNameInput) sessionStorage.setItem("logManagerName", card._friendlyNameInput.value);
}

// Clear the add/edit form and its persisted draft.
export function clearState(card) {
  if (card._pathInput) card._pathInput.value = "";
  if (card._friendlyNameInput) card._friendlyNameInput.value = "";
  card._editingPath = null;
  card._friendlyNameDirty = false;
  sessionStorage.removeItem("logManagerPath");
  sessionStorage.removeItem("logManagerName");
}

export function deriveFriendlyName(card, path) {
  const lastSegment = (path.split(".").pop() || "").trim();
  if (!lastSegment) return "";
  return lastSegment.split("_").map(word =>
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join(" ");
}

export function applyAutoFriendlyName(card, force = false) {
  if (card._friendlyNameDirty && !force) return;
  const path = card._pathInput.value.trim();
  if (!path) return;
  const derived = deriveFriendlyName(card, path);
  if (!derived) return;
  card._friendlyNameInput.value = derived;
  persistState(card);
  validateAddButton(card);
}

export function toggleExpand(card, loggerName) {
  if (card._expandedLogger === loggerName) {
    card._expandedLogger = null;
  } else {
    card._expandedLogger = loggerName;
    // Close the add/edit section to avoid two panels open at once.
    if (card._isAddSectionVisible) {
      closeAddSection(card);
    }
  }
  updateActiveList(card);
}

export function closeAddSection(card) {
  card._isAddSectionVisible = false;
  card._editingPath = null;
  card._addSectionWrapper.style.overflow = "hidden";
  card._addSectionWrapper.classList.remove("visible");
  tintConfigurePane(card, null);
  card._toggleIcon.setAttribute("icon", "mdi:plus");
  card._toggleText.innerText = "Add logger";
  restoreAddSectionPosition(card);
  clearState(card);
}

// Tint the configure pane with the edited logger's level colour, or clear the
// tint when no logger is being edited.
export function tintConfigurePane(card, level) {
  const pane = card._addSectionWrapper.querySelector(".add-section");
  if (!pane) return;
  if (!level) {
    pane.style.background = "";
    pane.style.borderLeft = "";
    return;
  }
  const colors = utils.levelColors(level);
  pane.style.background = colors.rowBg;
  pane.style.borderLeft = `3px solid ${colors.color}`;
}

export function restoreAddSectionPosition(card) {
  const haCard = card.shadowRoot.querySelector("ha-card");
  const actions = haCard && haCard.querySelector(".card-actions");
  if (haCard && actions && card._addSectionWrapper.parentElement !== haCard) {
    haCard.insertBefore(card._addSectionWrapper, actions);
  } else if (haCard && actions && card._addSectionWrapper.nextElementSibling !== actions) {
    haCard.insertBefore(card._addSectionWrapper, actions);
  }
}

export function insertAddSectionAfter(card, row) {
  if (!row || !row.parentElement) return;
  // Re-inserting to the same position would tear the node out and back in,
  // restarting its open animation. Skip when it is already placed correctly.
  if (card._addSectionWrapper.parentElement === row.parentElement
      && card._addSectionWrapper.previousElementSibling === row) {
    return;
  }
  row.parentElement.insertBefore(card._addSectionWrapper, row.nextSibling);
}

export function openAddSection(card, focus = "path") {
  if (card._expandedLogger) {
    card._expandedLogger = null;
    // Repaint now so the collapsed panel disappears with the section opening
    // rather than lingering until the next unrelated render.
    updateActiveList(card);
  }
  card._isAddSectionVisible = true;
  card._addSectionWrapper.classList.add("visible");
  card._toggleIcon.setAttribute("icon", "mdi:chevron-up");
  card._toggleText.innerText = "Cancel";
  setTimeout(() => {
    if (card._isAddSectionVisible) {
      card._addSectionWrapper.style.overflow = "visible";
      const target = focus === "name" ? card._friendlyNameInput : card._pathInput;
      target.focus();
      target.select();
    }
  }, 300);
  renderDropdown(card);
}

export function fetchLoggers(card) {
  card._hass.connection.sendMessagePromise({ type: "log_manager/get_loggers" }).then(res => {
    card._availableLoggers = res.sort();
    renderDropdown(card);
  });
}

export function renderDropdown(card) {
  card._optionsList.innerHTML = "";

  const highlights = ["homeassistant.", "custom_components.", "pyscript."];

  const activePaths = Object.values(card._hass.states)
    .filter(s => s.entity_id.startsWith("select.") && s.attributes.logger_name)
    .map(s => s.attributes.logger_name);

  card._availableLoggers.forEach(opt => {
    if (activePaths.includes(opt) && opt !== card._editingPath) return;

    const item = document.createElement("div");
    item.className = "option-item";

    item.dataset.path = opt;
    const isHighlight = highlights.some(prefix => opt.startsWith(prefix));
    if (isHighlight) item.classList.add("highlight");
    item.dataset.star = isHighlight ? "1" : "";
    renderOptionLabel(card, item, "");

    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      card._pathInput.value = opt;
      // A newly chosen logger recomputes the suggested name even if the
      // user had edited the previous one.
      applyAutoFriendlyName(card, true);
      persistState(card);
      validateAddButton(card);
      card._optionsList.style.display = "none";
      card._friendlyNameInput.focus();
    });

    card._optionsList.appendChild(item);
  });
}

export function fuzzyScore(card, text, query) {
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

export function highlightMatch(card, text, query) {
  const raw = String(text || "");
  const q = String(query || "").toLowerCase().replace(/[\s_]+/g, "");
  if (!q) return utils.escapeHtml(raw);
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
    hit[i] ? `<b class="fuzzy-hit">${utils.escapeHtml(c)}</b>` : utils.escapeHtml(c)
  ).join("");
}

export function renderOptionLabel(card, item, query) {
  const path = item.dataset.path || "";
  const star = item.dataset.star ? `<span class="option-star">★ </span>` : "";
  item.innerHTML = star + highlightMatch(card, path, query);
}

export function filterDropdown(card, filterText) {
  const entries = Array.from(card._optionsList.children).map(child => {
    const text = child.dataset.path || child.textContent.replace("★ ", "");
    return { child, score: fuzzyScore(card, text, filterText) };
  });
  entries.sort((a, b) => b.score - a.score);
  entries.forEach(({ child, score }) => {
    child.style.display = score > 0 ? "block" : "none";
    renderOptionLabel(card, child, filterText);
    card._optionsList.appendChild(child);
  });
}

// Tooltip shown on the bulk controls when they are disabled.
const SET_ALL_RECORDING_HINT = "Set all is unavailable while a recording is active.";
const SET_ALL_NO_LOGGERS_HINT = "Add a logger to use Set all.";
const RECORD_NO_LOGGERS_HINT = "Add at least one logger to record log events.";

// Single source of truth for the two bulk controls' disabled state AND their
// disabled-state tooltip. Computed from the same facts for every writer: no
// managed loggers disables Set all and, unless an undiscarded recording is
// held, Record; an active recording additionally locks Set all (a bulk level
// change would corrupt the capture) while leaving Record enabled as the stop
// control. Nothing else may write `_setAllLevel.disabled` or
// `_recordBtn.disabled`.
//
// Title precedence: this function owns both controls' *disabled* tooltip. The
// record button's *enabled* title stays owned by `updateRecordingUI`, so the
// enabled branch never clobbers a fresh title: it restores the cached enabled
// title only when the "no loggers" hint is currently shown (meaning this
// function was the last writer), and otherwise caches the title it sees.
export function refreshSetupControls(card) {
  const states = (card._hass && card._hass.states) || {};
  const hasLoggers = Object.keys(states).some(eid =>
    eid.startsWith("select.") &&
    states[eid] &&
    states[eid].attributes &&
    states[eid].attributes.logger_name
  );
  const recording = card._recordingState === "recording" || card._recordingState === "stopping";
  const hasSaved = card._recordingState === "completed" || card._recordingState === "results";
  if (card._setAllLevel) {
    card._setAllLevel.disabled = !hasLoggers || recording;
    if (recording) card._setAllLevel.title = SET_ALL_RECORDING_HINT;
    else if (!hasLoggers) card._setAllLevel.title = SET_ALL_NO_LOGGERS_HINT;
    else card._setAllLevel.title = card._setAllDefaultTitle || card._setAllLevel.title;
  }
  if (card._recordBtn) {
    card._recordBtn.disabled = !hasLoggers && !hasSaved && !recording;
    if (card._recordBtn.disabled) {
      card._recordBtn.title = RECORD_NO_LOGGERS_HINT;
    } else if (card._recordBtn.title === RECORD_NO_LOGGERS_HINT) {
      if (card._recordEnabledTitle) card._recordBtn.title = card._recordEnabledTitle;
    } else {
      card._recordEnabledTitle = card._recordBtn.title;
    }
  }
}

export function updateActiveList(card) {
  const rawActiveEntities = Object.keys(card._hass.states).filter(eid => {
    return eid.startsWith("select.") && card._hass.states[eid].attributes.logger_name;
  });
  // Keep the bulk controls in step with the managed-logger count on every pass.
  refreshSetupControls(card);

  if (rawActiveEntities.length === 0) {
    card._activeList.innerHTML = `
      <div class="empty-state"
        style="color: var(--secondary-text-color); font-style: italic;
        font-size: 14px; text-align: center; padding: 16px;">
        No loggers managed.
      </div>`;

    if (card._isAddSectionVisible) {
      renderDropdown(card);
      filterDropdown(card, card._pathInput.value);
    }
    return;
  }

  const emptyState = card._activeList.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  card._activeList.style.display = "flex";
  card._activeList.style.flexDirection = "column";
  card._activeList.style.gap = "8px";

  const mappedEntities = rawActiveEntities.map(eid => {
    const stateObj = card._hass.states[eid];
    const friendlyName = stateObj.attributes.friendly_name || eid;
    return { eid, friendlyName };
  });

  mappedEntities.sort((a, b) => {
    return a.friendlyName.localeCompare(b.friendlyName, undefined, { sensitivity: "base" });
  });

  const activeEntities = mappedEntities.map(item => item.eid);

  const grouping = loggers.isGroupingEnabled(card);
  const collapsedMap = loggers.getCollapsedGroups(card);
  const rowByEid = {};
  let model = [];
  let collapsibleByLogger = {};
  let loggerToEid = {};
  if (grouping) {
    activeEntities.forEach(eid => {
      const name = card._hass.states[eid].attributes.logger_name || "";
      if (name) loggerToEid[name] = eid;
    });
    model = loggers.buildLoggerTree(card, Object.keys(loggerToEid));
    model.forEach(item => {
      if (item.kind === "row") collapsibleByLogger[item.logger] = item.collapsible;
    });
  }
  // Drop headers no longer in the model (or all of them in flat mode).
  const desiredHeaderKeys = new Set(
    model.filter(item => item.kind === "group").map(item => item.key)
  );
  Array.from(card._activeList.querySelectorAll(".log-group-header")).forEach(header => {
    if (!grouping || !desiredHeaderKeys.has(header.dataset.group)) header.remove();
  });

  const existingRows = Array.from(card._activeList.querySelectorAll(".log-row"));
  existingRows.forEach(row => {
    if (!activeEntities.includes(row.dataset.entityId)) row.remove();
  });

  activeEntities.forEach((eid) => {
    const stateObj = card._hass.states[eid];
    let row = card._activeList.querySelector(`.log-row[data-entity-id="${eid}"]`);

    const options = stateObj.attributes.options || [];
    const isUnavailable = stateObj.state === "unavailable" ||
                          stateObj.state === "unknown" ||
                          options.length === 0;
    const actualLoggerName = stateObj.attributes.logger_name || "Unknown";
    const displayName = stateObj.attributes.friendly_name || eid;
    const currentLevel = stateObj.state;
    const isPinned = !!stateObj.attributes.core_pinned;
    const pinnedTitle = loggers.PINNED_REASON;
    const chipInfo = loggers.effectiveChipInfo(card, stateObj, currentLevel, isUnavailable);
    const chipSig = chipInfo ? `${chipInfo.effectiveLevel}|${chipInfo.sourceText}` : "";
    const raisedChipHtml = loggers.renderRaisedChipHtml(card, 
      actualLoggerName,
      card._recordingState === "recording" && card._recordingLoggers.includes(actualLoggerName)
    );
    const levelTitleSig = loggers.levelSelectTooltip(card, 
      actualLoggerName, currentLevel, isPinned,
      card._recordingState === "recording" && card._recordingLoggers.includes(actualLoggerName)
    );
    // NOTSET rows take the effective level's colour, with a dashed border to
    // signal the level is inherited rather than set here.
    const inherited = currentLevel === "NOTSET" && !!chipInfo;
    const colorLevel = inherited ? chipInfo.effectiveLevel : currentLevel;
    const colors = utils.levelColors(colorLevel);
    const badgeStats = card._counters[actualLoggerName];
    const curWarn = badgeStats ? (badgeStats.warning || 0) : 0;
    const curErr = badgeStats ? (badgeStats.error || 0) : 0;
    // A logger being recorded has a locked level until the session ends.
    const recordedNow = card._recordingState === "recording" && card._recordingLoggers.includes(actualLoggerName);
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

      const selectOptions = options.map(opt => {
        // Colour options by severity, not just the selected value.
        const c = ui.optionColor(opt);
        // NOTSET means "no level configured here"; show it as readable text
        // while keeping the option's value so the service call is unchanged.
        const label = opt === "NOTSET" ? "Not set" : opt;
        return `<option value="${opt}" style="color: ${c};">${label}</option>`;
      }).join("");

      // The selector tooltip shows lock reasons plus the current level/source;
      // the full level-change history lives in the history dialog.
      const selectTitle = loggers.levelSelectTooltip(card, actualLoggerName, currentLevel, isPinned, recordedNow);
      const selectHtml = isUnavailable
        ? `<select class="level-select" disabled><option>Unavailable</option></select>`
        : `<select class="level-select"${selectTitle ? ` title="${utils.escapeAttr(selectTitle)}"` : ""}${isPinned || recordedNow ? " disabled" : ""}>${selectOptions}</select>`;

      const counterBadgeHtml = loggers.renderCounterBadgeHtml(card, actualLoggerName);
      const counterBadgesDiv = counterBadgeHtml ? `<div class="counter-badges">${counterBadgeHtml}</div>` : "";

      const isExpanded = card._expandedLogger === actualLoggerName;
      const logPanelHtml = isExpanded ? loggers.renderLogPanelHtml(card, actualLoggerName) : "";

      const isRecording = card._recordingState === "recording" && card._recordingLoggers.includes(actualLoggerName);
      const recordingLevel = card._recordingLevelOverrides[actualLoggerName] || currentLevel;
      const recordingTag = isRecording
        ? `<span class="recording-tag" title="Recording at ${utils.escapeAttr(recordingLevel)}">${recordingLevel.charAt(0)}</span>`
        : "";
      const pinnedTag = isPinned
        ? `<span class="pinned-tag" title="${utils.escapeAttr(pinnedTitle)}">Pinned</span>`
        : "";
      const effectiveChip = loggers.renderEffectiveChip(card, stateObj, currentLevel, isUnavailable);
      const raisedChip = loggers.renderRaisedChipHtml(card, actualLoggerName, isRecording);
      const rowChevron = hasChildren
        ? `<button type="button" class="row-group-chevron" title="Collapse or expand child loggers">${loggers.getCollapsedGroups(card)[actualLoggerName] ? "\u25B8" : "\u25BE"}</button>`
        : "";

      row.innerHTML = `
        <div class="log-name ${isUnavailable ? "unavailable" : ""}" title="Click to expand or collapse the log panel">
          <div style="font-weight: 500;">${recordingTag}${pinnedTag}${rowChevron}${utils.escapeHtml(displayName)}</div>
          <div style="color: var(--secondary-text-color); font-size: 12px; margin-top: 2px;">
            ${utils.escapeHtml(actualLoggerName)}
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
        ui.tintLevelOptions(selectEl);

        selectEl.addEventListener("change", (e) => {
          card._hass.callService("select", "select_option", {
            entity_id: eid,
            option: e.target.value
          });
        });

        // Prevent select change from toggling expand.
        selectEl.addEventListener("click", (e) => e.stopPropagation());

        row.querySelector(".edit-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          card._pathInput.value = actualLoggerName;
          card._friendlyNameInput.value = displayName;
          card._editingPath = actualLoggerName;
          // Start from the current name; a different selection recomputes it.
          card._friendlyNameDirty = true;
          tintConfigurePane(card, currentLevel);

          // Expand in place, directly beneath the row being edited.
          insertAddSectionAfter(card, row);
          if (!card._isAddSectionVisible) {
            openAddSection(card, "name");
          } else {
            card._addSectionWrapper.classList.add("visible");
            setTimeout(() => {
              card._friendlyNameInput.focus();
              card._friendlyNameInput.select();
            }, 0);
            validateAddButton(card);
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
            loggers.setGroupCollapsed(card, actualLoggerName, !loggers.getCollapsedGroups(card)[actualLoggerName]);
            updateActiveList(card);
          });
        }
      }

      // Click on the logger name area to toggle expand panel.
      row.querySelector(".log-name").addEventListener("click", () => {
        toggleExpand(card, actualLoggerName);
      });

      // Click on empty space in the row also toggles expand.
      row.addEventListener("click", (e) => {
        if (e.target.closest(".log-controls") || e.target.closest(".counter-badge") || e.target.closest(".log-panel") || e.target.closest(".log-name")) return;
        toggleExpand(card, actualLoggerName);
      });

      row.querySelector(".remove-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        loggers.showDeleteConfirm(card, `Remove logger "${displayName}"?`, () => {
          // Close the configure pane if it is editing the logger being removed.
          if (card._editingPath === actualLoggerName) closeAddSection(card);
          if (!isUnavailable) {
            card._hass.callService("log_manager", "remove_logger", {
              logger_name: actualLoggerName,
              friendly_name: displayName
            });
          } else {
            card._hass.connection.sendMessagePromise({
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

      loggers.attachBadgeHandlers(card, row);
      loggers.attachResetHandler(card, row);
      contextMenu.attachCopyPanelHandler(card, row);
      loggers.attachAlertHandler(card, row);
      loggers.attachHistoryHandler(card, row);
      recordingSession.updateRecordingCountBadge(card, 
        row, actualLoggerName,
        card._recordingCounts[actualLoggerName] || 0,
        card._recordingState === "recording" && card._recordingLoggers.includes(actualLoggerName)
      );

    } else {
      // Update existing row — only touch DOM when values actually changed.
      const prev = card._prevRowStates[eid] || {};

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
          ui.tintLevelOptions(select);
        }
      }

      // Update row background tint when the level or its effective colour changes.
      if (prev.level !== currentLevel || prev.colorLevel !== colorLevel) {
        row.style.background = colors.rowBg;
        row.style.borderStyle = inherited ? "dashed" : "";
      }

      // Keep an open configure pane in step with a later level change: the tint
      // is set imperatively at edit-open, so retint reactively when the edited
      // logger's level changes while its pane is visible.
      if (card._isAddSectionVisible && card._editingPath === actualLoggerName && prev.colorLevel !== colorLevel) {
        tintConfigurePane(card, colorLevel);
      }

      // Update counter badges in-place — never destroy badge DOM, so title tooltips survive.
      if (prev.warningCount !== curWarn || prev.errorCount !== curErr) {
        loggers.updateBadgesInPlace(card, row, actualLoggerName);
      }

      // Update or toggle the expand panel — only replace when content changed.
      let panel = row.querySelector(".log-panel");
      const isExpanded = card._expandedLogger === actualLoggerName;
      if (isExpanded) {
        const panelHtml = loggers.renderLogPanelHtml(card, actualLoggerName);
        // A committed control change requests a rebuild even while its control
        // still has focus; otherwise never rebuild while a control inside the
        // panel has focus (an incoming entry would close an open dropdown and
        // revert the value). The forced request is held until the rendered
        // content actually changes, so it lands when the fresh state arrives
        // rather than repainting stale content first. The explicit selection
        // survives rebuilds via stored entry keys.
        const forceRefresh = card._panelRefreshRequested === actualLoggerName;
        const panelFocused = !!panel && panel.contains(card.shadowRoot.activeElement);
        const contentChanged = card._prevPanelHtml[actualLoggerName] !== panelHtml;
        if (panel) {
          if (contentChanged && (forceRefresh || !panelFocused)) {
            panel.outerHTML = panelHtml;
            card._prevPanelHtml[actualLoggerName] = panelHtml;
            if (forceRefresh) card._panelRefreshRequested = null;
            loggers.attachResetHandler(card, row);
            contextMenu.attachCopyPanelHandler(card, row);
            loggers.attachAlertHandler(card, row);
            loggers.attachHistoryHandler(card, row);
          }
        } else {
          row.insertAdjacentHTML("beforeend", panelHtml);
          card._prevPanelHtml[actualLoggerName] = panelHtml;
          if (forceRefresh) card._panelRefreshRequested = null;
          loggers.attachResetHandler(card, row);
          contextMenu.attachCopyPanelHandler(card, row);
          loggers.attachAlertHandler(card, row);
          loggers.attachHistoryHandler(card, row);
        }
      } else if (panel) {
        panel.remove();
        delete card._prevPanelHtml[actualLoggerName];
      }

      // Update recording tag when recording state changes.
      const isRecording = card._recordingState === "recording" && card._recordingLoggers.includes(actualLoggerName);
      if (prev.recording !== isRecording) {          const nameDivFirst = row.querySelector(".log-name > div:first-child");
        if (nameDivFirst) {
          const existingTag = nameDivFirst.querySelector(".recording-tag");
          if (isRecording && !existingTag) {
            const tag = document.createElement("span");
            tag.className = "recording-tag";
            const recordingLevel = card._recordingLevelOverrides[actualLoggerName] || currentLevel;
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
        if (select) loggers.setSelectTitle(card, select, levelTitleSig);
      }

      // Update the effective-level chip when its content changes.
      if (prev.effective !== chipSig) {
        const pathDiv = row.querySelector(".log-name > div:last-child");
        if (pathDiv) {
          loggers.updateEffectiveChipInPlace(card, pathDiv, stateObj, currentLevel, isUnavailable);
        }
      }

      // Update the "Raised to X" chip when the recording raise state changes.
      if (prev.raised !== raisedChipHtml) {
        const pathDiv = row.querySelector(".log-name > div:last-child");
        if (pathDiv) loggers.updateRaisedChipInPlace(card, pathDiv, raisedChipHtml);
      }

      // Keep a terminal row's collapse chevron in sync with stored state.
      const chevronBtn = row.querySelector(".row-group-chevron");
      if (chevronBtn) {
        chevronBtn.textContent = loggers.getCollapsedGroups(card)[actualLoggerName]
          ? "\u25B8"
          : "\u25BE";
      }

      // Update recording count badge when count or recording state changes.
      const recordingCount = card._recordingCounts[actualLoggerName] || 0;
      if (prev.recording !== isRecording || prev.recordingCount !== recordingCount) {
        recordingSession.updateRecordingCountBadge(card, row, actualLoggerName, recordingCount, isRecording);
      }
    }

    // Cache state for next update to avoid unnecessary DOM touches.
    card._prevRowStates[eid] = {
      level: currentLevel,
      colorLevel,
      warningCount: curWarn,
      errorCount: curErr,
      pinned: isPinned,
      effective: chipSig,
      raised: raisedChipHtml,
      levelTitleSig,
      recording: card._recordingState === "recording" && card._recordingLoggers.includes(actualLoggerName),
      recordingCount: card._recordingCounts[actualLoggerName] || 0,
    };

    rowByEid[eid] = row;
  });

  // Lay out the flat list (headers and rows) in model order, applying the
  // depth indent and hiding anything under a collapsed ancestor.
  const orderedEls = [];
  if (grouping) {
    model.forEach(item => {
      if (item.kind === "group") {
        orderedEls.push({ el: loggers.ensureGroupHeader(card, item), item });
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
    const expected = card._activeList.children[index] || null;
    if (expected !== entry.el) card._activeList.insertBefore(entry.el, expected);
    // Cap the indent so deep trees never starve the logger name of width.
    const depth = Math.min(entry.item.depth || 0, 3);
    entry.el.style.marginLeft = `${depth * 12}px`;
    entry.el.style.borderLeft = depth > 0 ? "2px solid var(--divider-color)" : "";
    const hidden = (entry.item.ancestors || []).some(key => collapsedMap[key]);
    entry.el.style.display = hidden ? "none" : "";
  });

  if (card._isAddSectionVisible) {
    renderDropdown(card);
    filterDropdown(card, card._pathInput.value);
  }

  // Keep an open edit form directly beneath its logger after re-layout; the
  // ordered layout loop above reorders rows around it.
  if (card._editingPath && card._addSectionWrapper) {
    const editedRow = Array.from(card._activeList.querySelectorAll(".log-row"))
      .find(r => r.dataset.loggerName === card._editingPath);
    if (editedRow) insertAddSectionAfter(card, editedRow);
  }

  // Re-apply the explicit selection after any panel rebuild.
  selection.refreshSelection(card, card._activeList);
  // Keep every level select (rows, set-all) tinted after a rebuild.
  ui.tintAllLevelSelects(card);
}

// Shared repaint seam: a committed control change may still hold focus inside
// the panel, so an optional logger name forces that panel to rebuild even
// while a control inside it is focused (bypassing the focused-control
// deferral). Every commit-driven repaint routes through here.
export function refreshAfterCommit(card, loggerName = null) {
  if (loggerName) card._panelRefreshRequested = loggerName;
  updateActiveList(card);
}

export function validateAddButton(card) {
  const loggerPath = card._pathInput.value.trim();
  const friendlyName = card._friendlyNameInput.value.trim();

  const activeStates = Object.values(card._hass.states).filter(s => {
    return s.entity_id.startsWith("select.") &&
           s.attributes.logger_name &&
           s.attributes.logger_name !== card._editingPath;
  });

  const isDuplicatePath = activeStates.some(s => s.attributes.logger_name === loggerPath);
  const isDuplicateName = activeStates.some(s => s.attributes.friendly_name === friendlyName && friendlyName !== "");
  const isUnknownPath = loggerPath.length > 0 &&
                        !card._availableLoggers.includes(loggerPath) &&
                        loggerPath !== card._editingPath;

  if (loggerPath.length === 0) {
    // A blank path is rejected outright with an explicit unknown-path state.
    card._addBtn.disabled = true;
    card._addBtn.innerText = "Unknown path";
    card._addBtn.style.background = "var(--error-color)";
    return;
  }

  if (isDuplicatePath || isDuplicateName || isUnknownPath) {
    card._addBtn.disabled = true;
    if (isDuplicatePath) card._addBtn.innerText = "Path managed";
    else if (isDuplicateName) card._addBtn.innerText = "Name taken";
    else if (isUnknownPath) card._addBtn.innerText = "Unknown path";
    card._addBtn.style.background = "var(--error-color)";
  } else {
    card._addBtn.disabled = loggerPath.length === 0;
    card._addBtn.innerText = card._editingPath ? "Update" : "Save";
    card._addBtn.style.background = "var(--primary-color)";
  }
}

// Return the bulk "Set all" control to its non-level placeholder and repaint.
// Called after an apply or cancel so the same level can be re-picked without
// first switching away.
export function resetSetAll(card) {
  if (!card._setAllLevel) return;
  card._setAllLevel.value = "";
  ui.tintLevelOptions(card._setAllLevel);
  card._setAllLevel.style.borderColor = "";
}

// Wire the add/edit logger form and "set all" bulk control onto the card.
export function attachAddForm(card) {
  const toggleSection = () => {
    if (card._isAddSectionVisible) closeAddSection(card);
    else openAddSection(card);
  };
  card._toggleAddBtn.addEventListener("click", toggleSection);

  // "Set all" bulk level control: the five named levels behind a non-level
  // placeholder (NOTSET is excluded). There is no sticky committed value: the
  // control returns to the placeholder after every apply or cancel, so
  // re-picking any level — including the one just applied — always fires
  // `change`. A native select fires no `change` when the already-shown option
  // is re-picked, which is exactly why the placeholder is required.
  card._setAllDefaultTitle = card._setAllLevel.title;
  card._setAllLevel.innerHTML =
    `<option value="" disabled selected>Set all</option>` +
    ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
      .map(l => `<option value="${l}" style="color: ${ui.optionColor(l)};">${l}</option>`).join("");
  card._setAllLevel.value = "";
  const paintSetAll = () => {
    ui.tintLevelOptions(card._setAllLevel);
    if (!card._setAllLevel.value) {
      // The placeholder is not a severity: use the neutral control border.
      card._setAllLevel.style.borderColor = "";
      return;
    }
    const colors = utils.levelColors(card._setAllLevel.value);
    card._setAllLevel.style.borderColor = colors.color;
  };
  paintSetAll();
  card._setAllLevel.addEventListener("change", () => {
    if (!card._setAllLevel.value) return;
    paintSetAll();
    recordingSetup.applySetAll(card, card._setAllLevel.value);
  });

  const debouncedFilter = card._debounce((val) => {
    filterDropdown(card, val);
  }, 200).bind(card);

  card._pathInput.addEventListener("input", (e) => {
    const val = e.target.value;
    debouncedFilter(val);
    persistState(card);
    validateAddButton(card);
  });

  card._pathInput.addEventListener("focus", () => {
    card._optionsList.style.display = "block";
    filterDropdown(card, card._pathInput.value);
  });

  card._pathInput.addEventListener("blur", () => {
    setTimeout(() => { card._optionsList.style.display = "none"; }, 150);
  });

  const handleEscKey = (e) => {
    if (e.key === "Escape") {
      if (card._optionsList.style.display === "block") {
        card._optionsList.style.display = "none";
      } else if (card._isAddSectionVisible) {
        closeAddSection(card);
      }
    }
  };

  // Enter moves to the friendly name field; Escape closes the dropdown.
  card._pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      card._optionsList.style.display = "none";
      applyAutoFriendlyName(card);
      card._friendlyNameInput.focus();
    } else if (e.key === "Escape") {
      handleEscKey(e);
    }
  });

  // Enter in the friendly name field saves the logger.
  card._friendlyNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!card._addBtn.disabled) {
        card._addBtn.click();
      }
    } else if (e.key === "Escape") {
      handleEscKey(e);
    }
  });

  card._friendlyNameInput.addEventListener("input", () => {
    card._friendlyNameDirty = true;
    persistState(card);
    validateAddButton(card);
  });

  card._addBtn.addEventListener("click", () => {
    const loggerPath = card._pathInput.value.trim();
    const friendlyName = card._friendlyNameInput.value.trim() || loggerPath;

    if (card._editingPath) {
      card._hass.callService("log_manager", "remove_logger", {
        logger_name: card._editingPath
      });

      setTimeout(() => {
        card._hass.callService("log_manager", "add_logger", {
          logger_name: loggerPath,
          friendly_name: friendlyName
        });
      }, 250);
      // Close the configure pane after a committed Update.
      closeAddSection(card);
    } else {
      card._hass.callService("log_manager", "add_logger", {
        logger_name: loggerPath,
        friendly_name: friendlyName
      });
      clearState(card);
      closeAddSection(card);
    }
  });
}

// Mutable API object: the cross-concern call seam and the test stub target.
export const addForm = {
  persistState,
  clearState,
  deriveFriendlyName,
  applyAutoFriendlyName,
  toggleExpand,
  closeAddSection,
  tintConfigurePane,
  restoreAddSectionPosition,
  insertAddSectionAfter,
  openAddSection,
  fetchLoggers,
  renderDropdown,
  fuzzyScore,
  highlightMatch,
  renderOptionLabel,
  filterDropdown,
  refreshSetupControls,
  updateActiveList,
  refreshAfterCommit,
  resetSetAll,
  validateAddButton,
  attachAddForm,
};
registerConcern("addForm", addForm);
