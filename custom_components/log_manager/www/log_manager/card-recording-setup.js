import { concern, registerConcern } from "./card-core.js";
import { utils } from "./card-utils.js";

// Late-bound cross-module seam: `card-core.js` holds the registry. `loggers`
// is aliased so it does not collide with the local `loggers` array below.
const addForm = concern("addForm");
const loggersApi = concern("loggers");
const recordingSession = concern("recordingSession");

// Recording setup dialog: logger checklist, exclusions, profiles, set-all.
// Extracted from the entry card; functions take the card instance and
// preserve its `this`-state and existing method names.

export function openRecordingSetup(card) {
    // A fresh selection: drop any raise intents confirmed for a prior session.
    card._recordingRaiseIntents = {};
    const LOG_LEVELS = ["ALL", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
    const managed = Object.entries(card._hass.states)
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
      const colors = utils.levelColors(currentLevel);
      const levelOpts = LOG_LEVELS.map(l => {
        const moreVerbose = utils.isMoreVerbose(l, currentLevel);
        const label = l === "ALL" ? "All levels" : l;
        // ALL is the catch-all: bold and neutral, never a named floor.
        const allStyle = l === "ALL" ? ' style="font-weight: 600;" title="Capture everything this logger emits"' : "";
        return `<option value="${l}"${l === currentLevel ? " selected" : ""}${moreVerbose ? ' data-more-verbose="1"' : ""}${allStyle}>${moreVerbose ? "\u2193 " : ""}${label}</option>`;
      }).join("");
      html += `<label class="checklist-item" style="background: ${colors.rowBg};">
        <input type="checkbox" data-logger="${utils.escapeAttr(loggerName)}">
        <span class="logger-label">${utils.escapeHtml(friendlyName)}</span>
        <select class="recording-level-select" data-prev-level="${utils.escapeAttr(currentLevel)}" title="Recording level for ${utils.escapeAttr(friendlyName)} (${utils.escapeAttr(loggerName)})" disabled style="color: ${colors.color}; background: ${colors.bg};">${levelOpts}</select>
        <button type="button" class="exclude-toggle" data-logger="${utils.escapeAttr(loggerName)}" title="Exclude child loggers of ${utils.escapeAttr(loggerName)} from this recording" disabled>+ exclusions</button>
        <div class="exclude-area" data-logger="${utils.escapeAttr(loggerName)}" style="display: none;">
          <div class="exclude-chips"></div>
          <div class="exclude-input-wrapper">
            <input type="text" class="exclude-input" data-logger="${utils.escapeAttr(loggerName)}" placeholder="Search child logger to exclude — Enter to add">
            <div class="exclude-options options-list"></div>
          </div>
        </div>
      </label>`;
    });

    card._loggerChecklist.innerHTML = html;

    // A per-logger confirm is shown when a change raises the level; the prompt
    // records the intent instead of changing the level immediately.
    card._loggerChecklist.querySelectorAll(".recording-level-select").forEach(sel => {
      sel.addEventListener("change", () => recordingSession.handleRecordingLevelChange(card, sel));
    });

    const selectAll = card._loggerChecklist.querySelector("#select-all-checkbox");
    selectAll.addEventListener("change", () => {
      const checks = card._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
      checks.forEach(cb => {
        cb.checked = selectAll.checked;
        // Also enable/disable level selects and the exclusions control.
        const item = cb.closest(".checklist-item");
        const levelSelect = item.querySelector(".recording-level-select");
        if (levelSelect) levelSelect.disabled = !selectAll.checked;
        const excludeToggle = item.querySelector(".exclude-toggle");
        if (excludeToggle) excludeToggle.disabled = !selectAll.checked;
      });
      markProfileDirty(card);
      validateRecordingSetup(card);
    });

    card._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)").forEach(cb => {
      cb.addEventListener("change", () => {
        // Uncheck select-all if one is unchecked.
        const allChecks = card._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
        const allChecked = Array.from(allChecks).every(c => c.checked);
        selectAll.checked = allChecked;

        // Enable/disable level select and the exclusions control.
        const item = cb.closest(".checklist-item");
        const levelSelect = item.querySelector(".recording-level-select");
        if (levelSelect) levelSelect.disabled = !cb.checked;
        const excludeToggle = item.querySelector(".exclude-toggle");
        if (excludeToggle) excludeToggle.disabled = !cb.checked;

        markProfileDirty(card);
        validateRecordingSetup(card);
      });
    });

    card._loggerChecklist.querySelectorAll(".exclude-toggle").forEach(btn => {
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
          card._loggerChecklist.querySelectorAll(".exclude-area").forEach(other => {
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

    card._loggerChecklist.querySelectorAll(".exclude-input").forEach(inp => {
      // Keep the label from toggling its checkbox; focus manually.
      inp.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        inp.focus();
      });
      inp.addEventListener("click", (e) => e.stopPropagation());
      inp.addEventListener("focus", () => showExcludeSuggestions(card, inp));
      inp.addEventListener("input", () => {
        // Clear a stale invalid flag as soon as the user edits the text.
        inp.classList.remove("exclude-invalid");
        inp.title = "";
        showExcludeSuggestions(card, inp);
      });
      inp.addEventListener("blur", () => {
        setTimeout(() => hideExcludeSuggestions(card, inp), 150);
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
        addExcludeChip(card, inp, path);
        hideExcludeSuggestions(card, inp);
      });
    });

    validateRecordingSetup(card);
    loadProfiles(card);
    card._recordingSetupDialog.style.display = "flex";
    requestAnimationFrame(() => {
      card._recordingSetupDialog.classList.add("visible");
    });
  }

export function addExcludeChip(card, inp, path) {
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
      markProfileDirty(card);
    });
    rm.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    chip.append(label, rm);
    chips.appendChild(chip);
    markProfileDirty(card);
    inp.value = "";
  }

export function setExcludeChips(card, item, loggerName, paths) {
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
        markProfileDirty(card);
      });
      rm.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      chip.append(label, rm);
      chips.appendChild(chip);
    });
  }

export function showExcludeSuggestions(card, inp) {
    const box = inp.parentElement && inp.parentElement.querySelector(".exclude-options");
    if (!box) return;
    const loggerName = inp.dataset.logger;
    const query = inp.value.trim();
    const taken = new Set(
      Array.from(inp.closest(".exclude-area").querySelectorAll(".exclude-chip"))
        .map(chip => chip.dataset.path)
    );
    const matches = (card._availableLoggers || [])
      .filter(p => p.startsWith(loggerName + ".") && !taken.has(p))
      .map(p => ({ p, score: addForm.fuzzyScore(card, p, query) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    if (matches.length === 0) {
      box.style.display = "none";
      box.innerHTML = "";
      return;
    }
    box.innerHTML = matches.map(({ p }) =>
      `<div class="option-item" data-path="${utils.escapeAttr(p)}">${addForm.highlightMatch(card, p, query)}</div>`
    ).join("");
    box.style.display = "block";
    box.querySelectorAll(".option-item").forEach(el => {
      el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        addExcludeChip(card, inp, el.dataset.path);
        hideExcludeSuggestions(card, inp);
      });
    });
  }

export function hideExcludeSuggestions(card, inp) {
    const box = inp.parentElement && inp.parentElement.querySelector(".exclude-options");
    if (box) {
      box.style.display = "none";
      box.innerHTML = "";
    }
  }

export function collectRecordingExcludes(card) {
    const excludes = {};
    const checked = card._loggerChecklist.querySelectorAll("input[type='checkbox']:checked:not(#select-all-checkbox)");
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

export function loadProfiles(card) {
    if (!card._hass || !card._hass.connection) {
      renderProfileOptions(card, []);
      return;
    }
    card._hass.connection.sendMessagePromise({
      type: "log_manager/profiles_get",
    }).then(res => {
      renderProfileOptions(card, (res && res.profiles) || []);
    }).catch(() => {
      renderProfileOptions(card, []);
    });
  }

export function onProfileSelectChange(card) {
    const name = card._profileSelect ? card._profileSelect.value : "";
    if (name === "__modified__") return;
    card._profileDeleteBtn.disabled = !name;
    if (!name) return;
    const reload = () => {
      clearProfileDirty(card);
      applyProfile(card, name);
    };
    if (card._profileDirty) {
      loggersApi.showDeleteConfirm(card, 
        "Reload this profile? Your current selection changes will be replaced.",
        reload,
        "Reload profile",
        "Reload",
        () => { card._profileSelect.value = "__modified__"; }
      );
    } else {
      reload();
    }
  }

export function markProfileDirty(card) {
    if (card._profileDirty || !card._profileSelect) return;
    const current = card._profileSelect.value;
    if (!current || current === "__modified__") return;
    card._modifiedBaseName = current;
    card._profileDirty = true;
    const opt = document.createElement("option");
    opt.value = "__modified__";
    opt.textContent = `${current} *`;
    opt.title = "Settings changed since this profile was loaded";
    card._profileSelect.insertBefore(opt, card._profileSelect.firstChild);
    card._profileSelect.value = "__modified__";
    card._profileDeleteBtn.disabled = true;
  }

export function clearProfileDirty(card) {
    card._profileDirty = false;
    card._modifiedBaseName = "";
    if (!card._profileSelect) return;
    const opt = card._profileSelect.querySelector('option[value="__modified__"]');
    if (opt) opt.remove();
  }

export function renderProfileOptions(card, profiles, selectName) {
    if (!card._profileSelect) return;
    card._profiles = profiles;
    // A fresh render always drops the modified marker.
    card._profileDirty = false;
    card._modifiedBaseName = "";
    const hasProfiles = profiles.length > 0;
    const current = selectName != null ? selectName : card._profileSelect.value;
    const retained = profiles.some(p => p.name === current) ? current : (hasProfiles ? profiles[0].name : "");
    card._profileSelect.disabled = !hasProfiles;
    card._profileSelect.innerHTML = hasProfiles
      ? profiles.map(p =>
          `<option value="${utils.escapeAttr(p.name)}">${utils.escapeHtml(p.name)}</option>`
        ).join("")
      : `<option value="">No profiles yet</option>`;
    card._profileSelect.value = retained;
    card._profileDeleteBtn.disabled = !hasProfiles;
    card._profileSaveRow.style.display = "none";
    if (card._profileRow) card._profileRow.style.display = "flex";
    card._profileNameInput.value = "";
    // Whatever profile is shown must actually enable its loggers.
    if (card._profileSelect.value) {
      applyProfile(card, card._profileSelect.value);
    }
  }

export function applyProfile(card, name) {
    card._hass.connection.sendMessagePromise({
      type: "log_manager/profiles_get",
    }).then(res => {
      const profile = ((res && res.profiles) || []).find(p => p.name === name);
      if (!profile) return;
      const wanted = new Set(profile.loggers || []);
      const overrides = profile.level_overrides || {};
      const excludes = profile.excludes || {};
      const raises = [];
      card._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)").forEach(cb => {
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
            recordingSession.applyRecordingLevelStyle(card, levelSelect, overrides[loggerName]);
            const stateObj = recordingSession.recordingLoggerState(card, loggerName);
            const current = stateObj ? stateObj.state : null;
            if (stateObj && utils.isMoreVerbose(overrides[loggerName], current)) {
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
        setExcludeChips(card, item, loggerName, excludes[loggerName] || []);
        const excludeToggle = item.querySelector(".exclude-toggle");
        if (excludeToggle) excludeToggle.disabled = !cb.checked;
      });
      const selectAll = card._loggerChecklist.querySelector("#select-all-checkbox");
      if (selectAll) {
        const allChecks = card._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
        selectAll.checked = allChecks.length > 0 && Array.from(allChecks).every(c => c.checked);
      }
      validateRecordingSetup(card);
      // A profile may raise several loggers: prompt per affected logger.
      recordingSession.promptRaiseSequence(card, raises);
    }).catch(err => console.error("Failed to load profile:", err));
  }

export function saveProfile(card) {
    const name = card._profileNameInput.value.trim();
    if (!name) {
      card._profileNameInput.focus();
      return;
    }
    const checkboxes = card._loggerChecklist.querySelectorAll("input[type='checkbox']:checked:not(#select-all-checkbox)");
    const loggers = [];
    const levelOverrides = {};
    checkboxes.forEach(cb => {
      const loggerName = cb.dataset.logger;
      loggers.push(loggerName);
      const levelSelect = cb.closest(".checklist-item").querySelector(".recording-level-select");
      if (levelSelect) levelOverrides[loggerName] = levelSelect.value;
    });
    if (loggers.length === 0) return;
    const excludes = recordingSetup.collectRecordingExcludes(card);
    const proceed = () => recordingSetup.sendProfileSave(card, name, loggers, levelOverrides, excludes);
    const existing = (card._profiles || []).some(pr => pr.name === name);
    if (existing) {
      loggersApi.showDeleteConfirm(card, 
        `Overwrite the existing profile "${name}"?`,
        proceed,
        "Overwrite profile",
        "Overwrite"
      );
    } else {
      proceed();
    }
  }

export function sendProfileSave(card, name, loggers, levelOverrides, excludes) {
    card._hass.connection.sendMessagePromise({
      type: "log_manager/profile_save",
      name: name,
      loggers: loggers,
      level_overrides: levelOverrides,
      excludes: excludes || {},
      max_duration: card._recordingMaxDuration || 300,
    }).then(res => {
      // Select the saved name before rendering so the shown profile is applied,
      // keeping the checklist in sync (no stale profile re-applied).
      renderProfileOptions(card, (res && res.profiles) || [], name);
      card._profileDeleteBtn.disabled = false;
    }).catch(err => console.error("Failed to save profile:", err));
  }

export function validateRecordingSetup(card) {
    const checked = card._loggerChecklist.querySelectorAll("input[type='checkbox']:checked:not(#select-all-checkbox)");
    card._recordingSetupStart.disabled = checked.length === 0;
  }

export function applySetAll(card) {
    const level = card._setAllLevel.value;
    if (!level) return;
    loggersApi.showDeleteConfirm(card, 
      `Set every managed logger to ${loggersApi.levelPillHtml(card, level)}? Core-pinned loggers are left untouched.`,
      () => {
        card._hass.connection.sendMessagePromise({
          type: "log_manager/set_levels",
          level: level,
        }).then(res => {
          const changed = (res && res.changed) || 0;
          const skipped = (res && res.skipped) || 0;
          if (skipped > 0) {
            loggersApi.showDeleteConfirm(card, 
              `${changed} logger${changed === 1 ? "" : "s"} updated; ${skipped} core-pinned ${skipped === 1 ? "logger was" : "loggers were"} left untouched.`,
              () => {},
              "Set all levels",
              "OK"
            );
          }
          addForm.updateActiveList(card);
        }).catch(err => console.error("Failed to set all levels:", err));
      },
      "Set all levels",
      "Apply",
      null,
      true
    );
  }

// Wire the recording-setup dialog controls (profiles, exclusions, start).
export function attachRecordingSetup(card) {
  // Recording setup dialog handlers.
  const closeSetup = () => {
    card._recordingSetupDialog.classList.remove("visible");
    card._recordingSetupDialog.style.display = "none";
  };
  card._recordingSetupCancel.addEventListener("click", closeSetup);
  card._recordingSetupDialog.addEventListener("click", (e) => {
    if (e.target === card._recordingSetupDialog) closeSetup();
  });

  // Recording profile handlers.
  card._profileSelect.addEventListener("change", () => onProfileSelectChange(card));
  card._profileSaveBtn.addEventListener("click", () => {
    // Replace the selection row with the save controls, not a new row below.
    card._profileRow.style.display = "none";
    card._profileNameInput.value = card._profileSelect.value || "";
    card._profileSaveRow.style.display = "flex";
    card._profileNameInput.focus();
  });
  card._profileAbortBtn.addEventListener("click", () => {
    card._profileSaveRow.style.display = "none";
    card._profileRow.style.display = "flex";
    card._profileNameInput.value = "";
  });
  card._profileConfirmBtn.addEventListener("click", () => {
    saveProfile(card);
  });
  card._profileNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveProfile(card);
  });

  card._profileDeleteBtn.addEventListener("click", () => {
    const name = card._profileSelect.value;
    if (!name) return;
    loggersApi.showDeleteConfirm(card, `Delete recording profile "${name}"?`, () => {
      card._hass.connection.sendMessagePromise({
        type: "log_manager/profile_delete",
        name: name,
      }).then(res => {
        renderProfileOptions(card, (res && res.profiles) || []);
      }).catch(err => console.error("Failed to delete profile:", err));
    }, "Delete profile", "Delete");
  });

  card._recordingSetupStart.addEventListener("click", () => {
    const checkboxes = card._loggerChecklist.querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)");
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
    const excludes = collectRecordingExcludes(card);
    card._recordingSetupDialog.classList.remove("visible");
    card._recordingSetupDialog.style.display = "none";
    recordingSession.startRecording(card, selected, levelOverrides, excludes);
  });
}

// Mutable API object: the cross-concern call seam and the test stub target.
export const recordingSetup = {
  openRecordingSetup,
  addExcludeChip,
  setExcludeChips,
  showExcludeSuggestions,
  hideExcludeSuggestions,
  collectRecordingExcludes,
  loadProfiles,
  onProfileSelectChange,
  markProfileDirty,
  clearProfileDirty,
  renderProfileOptions,
  applyProfile,
  saveProfile,
  sendProfileSave,
  validateRecordingSetup,
  applySetAll,
  attachRecordingSetup,
};
registerConcern("recordingSetup", recordingSetup);
