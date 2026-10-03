import { concern, registerConcern } from "./card-core.js";
import { utils } from "./card-utils.js";

// Late-bound cross-module seam: `card-core.js` holds the registry.
const addForm = concern("addForm");
const liveView = concern("liveView");
const loggers = concern("loggers");
const recordingSetup = concern("recordingSetup");
const results = concern("results");

// Recording session lifecycle: start/stop/discard/clear, polling,
// level-raise prompts and control lock.
// Extracted from the entry card; functions take the card instance and
// preserve its `this`-state and existing method names.

export function startRecording(card, loggers, levelOverrides, excludes) {
    card._recordingState = "recording";
    card._recordingStartTime = Date.now();
    card._recordingLoggers = loggers;
    card._recordingLevelOverrides = levelOverrides || {};
    card._recordingBuffer = [];
    card._recordingDuration = 0;
    card._recordingLogCount = 0;
    card._recordingCounts = {};
    card._recordingBackendCount = 0;
    card._liveLastId = 0;
    liveView.resetDedupState(card);
    card._resultsShown = false;
    results.hideResultsSummary(card);
    card._selectedKeys.clear();
    card._selectionAnchorRow = null;
    if (card._livePreview) card._livePreview.innerHTML = "";

    // Apply raise intents recorded at selection/profile-load time and remember
    // the original levels so the session end can restore them. The same intents
    // are sent to the backend, which owns the revert if the card disappears.
    card._recordingRestoreLevels = {};
    const raiseIntents = card._recordingRaiseIntents || {};
    const raiseLevels = {};
    Object.keys(raiseIntents).forEach(loggerName => {
      if (!loggers.includes(loggerName)) return;
      const intent = raiseIntents[loggerName];
      card._recordingRestoreLevels[loggerName] = {
        entityId: intent.entityId,
        level: intent.from,
        raisedTo: intent.to,
      };
      raiseLevels[loggerName] = {
        entity_id: intent.entityId,
        from: intent.from,
        to: intent.to,
      };
      card._hass.callService("select", "select_option", {
        entity_id: intent.entityId,
        option: intent.to,
      });
    });
    card._recordingRaiseIntents = {};
    if (card._liveLoggerFilter) card._liveLoggerFilter.value = "";
    if (card._liveLevelFilter) card._liveLevelFilter.value = "ALL";

    recordingSession.updateRecordingUI(card);

    card._recordingTimerInterval = setInterval(() => {
      recordingSession.updateRecordingUI(card);
      pollRecordingStatus(card);
    }, 1000);

    card._hass.connection.sendMessagePromise({
      type: "log_manager/start_recording",
      loggers: loggers,
      max_duration: 300,
      level_overrides: levelOverrides || {},
      excludes: excludes || {},
      raise_levels: raiseLevels,
    }).then(res => {
      card._recordingMaxDuration = (res && res.max_duration) || 300;
      liveView.openLiveView(card);
    }).catch(err => {
      console.error("Failed to start recording:", err);
      card._recordingState = null;
      recordingSession.cleanupRecordingIntervals(card);
      restoreRecordingLevels(card);
      card._recordingCounts = {};
      recordingSession.updateRecordingUI(card);
    });
  }

export function stopRecording(card) {
    recordingSession.cleanupRecordingIntervals(card);
    liveView.cleanupLivePolling(card);
    card._recordingState = "stopping";
    recordingSession.updateRecordingUI(card);

    card._hass.connection.sendMessagePromise({
      type: "log_manager/stop_recording",
    }).then(res => {
      if (res && res.logs) {
        card._recordingBuffer = res.logs;
        card._recordingDuration = res.duration || 0;
        card._recordingLogCount = res.log_count || 0;
        card._recordingBackendCount = res.log_count || 0;
        card._recordingState = "results";
        card._recordingCounts = {};
        restoreRecordingLevels(card);
        results.showRecordingResults(card);
      }
    }).catch(err => {
      console.error("Failed to stop recording:", err);
      restoreRecordingLevels(card);
      card._recordingState = null;
      card._recordingCounts = {};
      recordingSession.updateRecordingUI(card);
    });
  }

export function pollRecordingStatus(card) {
    if (card._recordingState !== "recording") return;
    card._hass.connection.sendMessagePromise({
      type: "log_manager/recording_status"
    }).then(status => {
      card._recordingCounts = status.logger_counts || {};
      card._recordingBackendCount = status.log_count || 0;
      if (status.max_duration) {
        card._recordingMaxDuration = status.max_duration;
      }
      if (status.status === "completed") {
        recordingSession.cleanupRecordingIntervals(card);
        liveView.cleanupLivePolling(card);
        card._recordingState = "completed";
        card._recordingLogCount = status.log_count || 0;
        card._recordingBackendCount = status.log_count || 0;
        card._recordingDuration = Math.round(status.elapsed || 0);
        restoreRecordingLevels(card);
        if (card._liveViewOpen) {
          results.fetchResults(card);
        }
        recordingSession.updateRecordingUI(card);
      }
    }).catch(() => {});
  }

export function checkExistingRecording(card) {
    if (!card._hass) return;
    card._hass.connection.sendMessagePromise({
      type: "log_manager/recording_status"
    }).then(status => {
      if (status.status === "recording") {
        card._recordingState = "recording";
        card._recordingStartTime = Date.now() - Math.round((status.elapsed || 0) * 1000);
        card._recordingLoggers = status.loggers || [];
        card._recordingMaxDuration = status.max_duration || 300;
        card._recordingCounts = status.logger_counts || {};
        // Adopt the session's pending level reverts so a reloaded card keeps
        // showing "Raised to X" and can restore the levels when the session ends.
        card._recordingRestoreLevels = {};
        Object.entries(status.level_restore || {}).forEach(([loggerName, intent]) => {
          card._recordingRestoreLevels[loggerName] = {
            entityId: intent.entity_id,
            level: intent.from,
            raisedTo: intent.to,
          };
        });
        card._recordingTimerInterval = setInterval(() => {
          recordingSession.updateRecordingUI(card);
          pollRecordingStatus(card);
        }, 1000);
        recordingSession.updateRecordingUI(card);
      } else if (status.status === "completed") {
        card._recordingState = "completed";
        card._recordingLogCount = status.log_count || 0;
        card._recordingBackendCount = status.log_count || 0;
        card._recordingDuration = Math.round(status.elapsed || 0);
        card._recordingCounts = status.logger_counts || {};
        recordingSession.updateRecordingUI(card);
      }
    }).catch(() => {});
  }

export function cleanupRecordingIntervals(card) {
    if (card._recordingTimerInterval) {
      clearInterval(card._recordingTimerInterval);
      card._recordingTimerInterval = null;
    }
  }

export function discardRecording(card) {
    card._hass.connection.sendMessagePromise({ type: "log_manager/discard_recording" })
      .then(() => {
        restoreRecordingLevels(card);
        recordingSession.cleanupRecordingIntervals(card);
        liveView.cleanupLivePolling(card);
        card._recordingBuffer = [];
        card._recordingCounts = {};
        card._recordingBackendCount = 0;
        card._recordingLogCount = 0;
        card._recordingState = null;
        card._liveLastId = 0;
        liveView.resetDedupState(card);
        card._resultsShown = false;
        results.hideResultsSummary(card);
        card._liveViewOpen = false;
        if (card._livePreview) card._livePreview.innerHTML = "";
        if (card._recordingLiveDialog) {
          card._recordingLiveDialog.classList.remove("visible");
          card._recordingLiveDialog.style.display = "none";
        }
        recordingSession.updateRecordingUI(card);
        addForm.updateActiveList(card);
      })
      .catch(err => console.error("Failed to discard recording:", err));
  }

export function clearRecordingBuffer(card) {
    card._hass.connection.sendMessagePromise({ type: "log_manager/clear_recording" })
      .then(() => {
        card._recordingBuffer = [];
        card._recordingCounts = {};
        card._recordingBackendCount = 0;
        card._liveLastId = 0;
        liveView.resetDedupState(card);
        card._resultsShown = false;
        results.hideResultsSummary(card);
        if (card._livePreview) card._livePreview.innerHTML = "";
        liveView.updateLiveSummary(card);
        addForm.updateActiveList(card);
      })
      .catch(err => console.error("Failed to clear recording:", err));
  }

export function promptRaiseSequence(card, items) {
    if (!items || items.length === 0) return;
    const head = items[0];
    const rest = items.slice(1);
    const friendly = head.friendlyName || head.loggerName;
    loggers.showDeleteConfirm(card, 
      `${utils.escapeHtml(friendly)} is set to ${loggers.levelPillHtml(card, head.from)}. Raise it to ${loggers.levelPillHtml(card, head.to)} for this recording and restore it afterwards?`,
      () => {
        card._recordingRaiseIntents[head.loggerName] = {
          entityId: head.entityId,
          from: head.from,
          to: head.to,
        };
        promptRaiseSequence(card, rest);
      },
      "Raise logger level",
      "Raise for recording",
      () => {
        // Cancelling skips this raise and restores the logger's configured level.
        if (head.selectEl) {
          head.selectEl.value = head.from;
          head.selectEl.dataset.prevLevel = head.from;
          applyRecordingLevelStyle(card, head.selectEl, head.from);
        }
        delete card._recordingRaiseIntents[head.loggerName];
        promptRaiseSequence(card, rest);
      },
      true
    );
  }

export function handleRecordingLevelChange(card, sel) {
    const loggerName = sel.dataset.logger;
    const to = sel.value;
    const stateObj = recordingLoggerState(card, loggerName);
    const current = stateObj ? stateObj.state : null;
    const prev = sel.dataset.prevLevel || current;
    const friendly = (stateObj && stateObj.attributes.friendly_name) || loggerName;
    if (utils.isMoreVerbose(to, current)) {
      // Revert now; the prompt restores the verbose value on confirm.
      sel.value = prev;
      applyRecordingLevelStyle(card, sel, prev);
      loggers.showDeleteConfirm(card, 
        `${utils.escapeHtml(friendly)} is set to ${loggers.levelPillHtml(card, current)}. Raise it to ${loggers.levelPillHtml(card, to)} for this recording and restore it afterwards?`,
        () => {
          sel.value = to;
          sel.dataset.prevLevel = to;
          applyRecordingLevelStyle(card, sel, to);
          card._recordingRaiseIntents[loggerName] = { entityId: stateObj.entity_id, from: current, to };
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
    applyRecordingLevelStyle(card, sel, to);
    const intent = card._recordingRaiseIntents[loggerName];
    if (intent && intent.to !== to) {
      delete card._recordingRaiseIntents[loggerName];
    }
    recordingSetup.markProfileDirty(card);
  }

export function applyRecordingLevelStyle(card, sel, level) {
    const item = sel.closest(".checklist-item");
    const colors = utils.levelColors(level);
    if (item) item.style.background = colors.rowBg;
    sel.style.color = colors.color;
    sel.style.background = colors.bg;
  }

export function restoreRecordingLevels(card) {
    const restore = card._recordingRestoreLevels || {};
    Object.values(restore).forEach(({ entityId, level }) => {
      card._hass.callService("select", "select_option", { entity_id: entityId, option: level });
    });
    card._recordingRestoreLevels = {};
  }

export function recordingLoggerState(card, loggerName) {
    return Object.values((card._hass && card._hass.states) || {}).find(
      s => s.attributes && s.attributes.logger_name === loggerName
    ) || null;
  }

export function updateRecordingUI(card) {
    if (card._recordingState === "stopping") {
      card._recordIcon.setAttribute("icon", "mdi:stop-circle");
      card._recordBtn.classList.add("btn-record");
      card._recordBtn.classList.remove("btn-view-recording");
      card._recordBtn.title = "Stopping recording...";
      card._recordText.textContent = "Stopping...";
      card._liveBtn.style.display = "none";
      card._discardRecordBtn.style.display = "none";
    } else if (card._recordingState === "recording") {
      card._recordIcon.setAttribute("icon", "mdi:stop-circle");
      card._recordBtn.classList.add("btn-record");
      card._recordBtn.classList.remove("btn-view-recording");
      card._recordBtn.title = "Stop recording";
      const elapsed = Math.floor((Date.now() - card._recordingStartTime) / 1000);
      const remaining = Math.max(0, card._recordingMaxDuration - elapsed);
      const mins = String(Math.floor(remaining / 60)).padStart(2, "0");
      const secs = String(remaining % 60).padStart(2, "0");
      card._recordText.textContent = `Stop (${mins}:${secs})`;
      card._liveBtn.style.display = "";
      card._discardRecordBtn.style.display = "none";
    } else if (card._recordingState === "completed") {
      card._recordIcon.setAttribute("icon", "mdi:file-eye-outline");
      card._recordBtn.classList.remove("btn-record");
      card._recordBtn.classList.add("btn-view-recording");
      card._recordBtn.title = "View recorded logs";
      card._recordText.textContent = `View Recording (${card._recordingLogCount})`;
      card._liveBtn.style.display = "none";
      card._discardRecordBtn.style.display = "";
    } else if (card._recordingState === "results") {
      card._recordIcon.setAttribute("icon", "mdi:eye-check");
      card._recordBtn.classList.remove("btn-record");
      card._recordBtn.classList.add("btn-view-recording");
      card._recordBtn.title = "Viewing recording results";
      card._recordText.textContent = "Viewing";
      card._liveBtn.style.display = "none";
      card._discardRecordBtn.style.display = "";
    } else {
      card._recordIcon.setAttribute("icon", "mdi:record-circle");
      card._recordBtn.classList.remove("btn-record");
      card._recordBtn.classList.remove("btn-view-recording");
      card._recordBtn.title = "Record log events for export";
      card._recordText.textContent = "Record";
      card._liveBtn.style.display = "none";
      card._discardRecordBtn.style.display = "none";
    }
  }

export function updateRecordingCountBadge(card, row, loggerName, count, isRecording) {
    let container = row.querySelector(".counter-badges");
    let badge = container ? container.querySelector(".recording-count-badge") : null;

    if (isRecording && count > 0) {
      const stateObj = card._hass && Object.values(card._hass.states).find(
        s => s.attributes.logger_name === loggerName
      );
      const friendlyName = stateObj ? (stateObj.attributes.friendly_name || loggerName) : loggerName;
      const title = `${count} entries recorded for ${friendlyName}`;
      const attachClickListener = (el) => {
        if (el.dataset.recBadgeHandler) return;
        el.dataset.recBadgeHandler = "true";
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          liveView.openLiveView(card, loggerName);
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

// Wire the recording controls: start/stop button, live stop, clear, discard.
export function attachRecordingSession(card) {
  // Recording button: stop recording, fetch saved results, or open setup.
  card._recordBtn.addEventListener("click", () => {
    if (card._recordingState === "recording") {
      loggers.showDeleteConfirm(card, 
        "Stop recording and keep the captured entries?",
        () => stopRecording(card),
        "Stop recording",
        "Stop"
      );
    } else if (card._recordingState === "stopping") {
      // Ignore clicks while stopping is in-flight.
    } else if (card._recordingState === "completed") {
      results.fetchResults(card);
    } else {
      recordingSetup.openRecordingSetup(card);
    }
  });

  card._liveStopBtn.addEventListener("click", () => {
    loggers.showDeleteConfirm(card, 
      "Stop recording and keep the captured entries?",
      () => { results.closeLiveView(card); stopRecording(card); },
      "Stop recording",
      "Stop"
    );
  });

  card._liveClearBtn.addEventListener("click", () => {
    loggers.showDeleteConfirm(card, 
      "Clear all captured entries? Recording continues.",
      () => clearRecordingBuffer(card),
      "Clear recording",
      "Clear"
    );
  });

  card._liveDiscardBtn.addEventListener("click", () => {
    loggers.showDeleteConfirm(card, 
      "Discard the recorded logs? This cannot be undone.",
      () => discardRecording(card),
      "Discard recording",
      "Discard"
    );
  });

  card._discardRecordBtn.addEventListener("click", () => {
    loggers.showDeleteConfirm(card, 
      "Discard the recorded logs? This cannot be undone.",
      () => discardRecording(card),
      "Discard recording",
      "Discard"
    );
  });
}

// Mutable API object: the cross-concern call seam and the test stub target.
export const recordingSession = {
  startRecording,
  stopRecording,
  pollRecordingStatus,
  checkExistingRecording,
  cleanupRecordingIntervals,
  discardRecording,
  clearRecordingBuffer,
  promptRaiseSequence,
  handleRecordingLevelChange,
  applyRecordingLevelStyle,
  restoreRecordingLevels,
  recordingLoggerState,
  updateRecordingUI,
  updateRecordingCountBadge,
  attachRecordingSession,
};
registerConcern("recordingSession", recordingSession);
