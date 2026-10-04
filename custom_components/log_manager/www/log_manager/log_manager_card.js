// Cache-busting loader for sibling ES modules.
//
// Home Assistant serves this entry as a Lovelace *module* resource with a
// version query (`.../log_manager_card.js?v=<version>`). The browser caches
// module graphs by exact URL, so a static `import "./card-styles.js"` would
// drop that query and pin siblings to their own cache entries. Instead we read
// the entry's own version from `import.meta.url` and re-append it to every
// sibling URL, so one version change refetches the whole graph.
//
// Under Jest ESM the entry is imported by path with no query; `import.meta.url`
// then carries no `?v=` and the loader falls back to a bare relative URL.
// There is no top-level `await` and no top-level await of siblings: the class
// is defined and `customElements.define` + `window.customCards.push` run
// synchronously at module scope, exactly as before.
const ENTRY_URL = new URL(import.meta.url);
const ENTRY_VERSION = ENTRY_URL.searchParams.get("v");

function siblingURL(relativePath) {
  const url = new URL(relativePath, ENTRY_URL);
  if (ENTRY_VERSION) url.searchParams.set("v", ENTRY_VERSION);
  return url.href;
}

function loadSibling(relativePath) {
  return import(/* webpackIgnore: true */ siblingURL(relativePath));
}

let __cardStylesModule = null;
let __cardMarkupModule = null;
let __cardUtilsModule = null;
let __cardLoggersModule = null;
let __cardAddFormModule = null;
let __cardSelectionModule = null;
let __cardRecordingSetupModule = null;
let __cardRecordingSessionModule = null;
let __cardLiveViewModule = null;
let __cardResultsModule = null;
let __cardContextMenuModule = null;
let __cardUiModule = null;

// Kick off sibling loads eagerly. The dynamic imports start resolving at module
// scope, but nothing is awaited here, so the module body completes synchronously
// with the element registered. Consumers call `await whenCardModulesLoaded()`
// before using the CSS/markup strings.
const __cardModulesReady = Promise.all([
  loadSibling("./card-styles.js").then((mod) => {
    __cardStylesModule = mod;
    return mod;
  }),
  loadSibling("./card-markup.js").then((mod) => {
    __cardMarkupModule = mod;
    return mod;
  }),
  loadSibling("./card-utils.js").then((mod) => {
    __cardUtilsModule = mod;
    return mod;
  }),
  loadSibling("./card-loggers.js").then((mod) => {
    __cardLoggersModule = mod;
    return mod;
  }),
  loadSibling("./card-add-form.js").then((mod) => {
    __cardAddFormModule = mod;
    return mod;
  }),
  loadSibling("./card-selection.js").then((mod) => {
    __cardSelectionModule = mod;
    return mod;
  }),
  loadSibling("./card-recording-setup.js").then((mod) => {
    __cardRecordingSetupModule = mod;
    return mod;
  }),
  loadSibling("./card-recording-session.js").then((mod) => {
    __cardRecordingSessionModule = mod;
    return mod;
  }),
  loadSibling("./card-live-view.js").then((mod) => {
    __cardLiveViewModule = mod;
    return mod;
  }),
  loadSibling("./card-results.js").then((mod) => {
    __cardResultsModule = mod;
    return mod;
  }),
  loadSibling("./card-context-menu.js").then((mod) => {
    __cardContextMenuModule = mod;
    return mod;
  }),
  loadSibling("./card-ui.js").then((mod) => {
    __cardUiModule = mod;
    return mod;
  }),
]);

function whenCardModulesLoaded() {
  return __cardModulesReady;
}

// Surface a sibling-load failure once, at the source, so no awaiting consumer
// (the `set hass` callback, the Jest harness) produces an unhandled rejection.
__cardModulesReady.catch((err) => {
  console.error("Log Manager: failed to load card modules.", err);
});

// Exported for the Jest harness, which awaits readiness before building the UI.
export { whenCardModulesLoaded };
function getCardStyles() {
  return (__cardStylesModule && __cardStylesModule.CARD_STYLES) || "";
}

function getCardMarkup() {
  return (__cardMarkupModule && __cardMarkupModule.CARD_MARKUP) || "";
}

// Pure helpers live in card-utils.js; the element delegates to them so the
// private method names stay on the instance for existing callers.
function utils() {
  return __cardUtilsModule;
}

// Logger-tree concern functions live in card-loggers.js.
function loggersModule() {
  return __cardLoggersModule;
}

// Add/rename form and fuzzy dropdown live in card-add-form.js.
function addFormModule() {
  return __cardAddFormModule;
}

// Row selection and entry identity live in card-selection.js.
function selectionModule() {
  return __cardSelectionModule;
}

// Recording setup dialog, exclusions and profiles live in card-recording-setup.js.
function recordingSetupModule() {
  return __cardRecordingSetupModule;
}

// Recording session lifecycle lives in card-recording-session.js.
function recordingSessionModule() {
  return __cardRecordingSessionModule;
}

// Live recording viewer lives in card-live-view.js.
function liveViewModule() {
  return __cardLiveViewModule;
}

// Recording results view lives in card-results.js.
function resultsModule() {
  return __cardResultsModule;
}

// Context menu and text serialization live in card-context-menu.js.
function contextMenuModule() {
  return __cardContextMenuModule;
}

// Shared presentation helpers (tinting, confirm dialog) live in card-ui.js.
function uiModule() {
  return __cardUiModule;
}

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
    // False until the sibling dynamic imports resolve; the `hass` setter and
    // `_scheduleUpdate` treat an unloaded graph as a no-op rather than a throw.
    this._modulesLoaded = false;
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
    // Logger filter (live/results) is a searchable checkbox multi-select.
    // `_loggerFilterNames` accumulates logger names seen in the buffer while
    // the picker is closed; `_loggerFilterSelected` holds the ticked names and
    // survives rebuilds and reopen (the DOM-held checklist is not the model);
    // `_loggerFilterRendered` is the sorted snapshot last painted, used to
    // detect growth while open; `_loggerFilterOpen` gates rendering.
    this._loggerFilterNames = new Set();
    this._loggerFilterSelected = new Set();
    this._loggerFilterRendered = null;
    this._loggerFilterOpen = false;
    this._resultsShown = false;
    this._liveDedupOverride = null;
    // Sibling modules load asynchronously, so the constructor cannot call into
    // them: HA may construct the element in the same tick the module is
    // evaluated. Default to empty widths here and load the persisted values
    // once the modules resolve (see the loader callback in `set hass`).
    this._colWidths = {};
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

  set hass(hass) {
    this._hass = hass;

    if (!this._uiBuilt) {
      // The CSS/markup siblings load asynchronously (versioned dynamic import).
      // Build once they are ready so the first paint has the real strings; the
      // guard is set up front so repeat assignments during load do not re-enter.
      this._uiBuilt = true;
      whenCardModulesLoaded().then(() => {
        this._modulesLoaded = true;
        // Column widths persist across reloads; load them now that the sibling
        // module is available.
        this._colWidths = liveViewModule().loadColumnWidths(this);
        // The element may have been disconnected or re-configured meanwhile.
        if (this._uiBuilt && !this.shadowRoot.childNodes.length) {
          this._buildUI();
        }
        addFormModule().fetchLoggers(this);
        recordingSessionModule().checkExistingRecording(this);
        this._scheduleUpdate();
        loggersModule().fetchCounters(this);
      }).catch(() => {
        // The load failure is logged at the promise source; just stop waiting
        // so a repeat `hass` assignment does not sit unresolved.
        this._modulesLoaded = true;
      });
      return;
    }

    // A second assignment can arrive while the siblings are still loading.
    // Skip it; the pending loader callback above repaints once they resolve.
    if (!this._modulesLoaded) return;

    this._scheduleUpdate();

    loggersModule().fetchCounters(this);
  }

  // Debounce a list/recording repaint via rAF so redundant DOM work within one
  // frame collapses into a single pass.
  _scheduleUpdate() {
    if (this._updateScheduled) return;
    this._updateScheduled = true;
    requestAnimationFrame(() => {
      try {
        // Null-guard the accessors: a not-yet-loaded sibling is a no-op here
        // rather than a TypeError mid-frame.
        const addForm = addFormModule();
        if (addForm) addForm.updateActiveList(this);
        const session = recordingSessionModule();
        if (session) session.updateRecordingUI(this);
      }
      finally { this._updateScheduled = false; }
    });
  }

  _buildUI() {
    this.shadowRoot.innerHTML = getCardStyles() + getCardMarkup();

    this._activeList = this.shadowRoot.getElementById("active-list");
    this._setAllLevel = this.shadowRoot.getElementById("set-all-level");
    this._pathInput = this.shadowRoot.getElementById("path-input");
    this._optionsList = this.shadowRoot.getElementById("options-list");
    this._friendlyNameInput = this.shadowRoot.getElementById("friendly-name-input");
    this._addBtn = this.shadowRoot.getElementById("add-btn");
    this._toggleAddBtn = this.shadowRoot.getElementById("toggle-add-btn");
    this._toggleIcon = this.shadowRoot.getElementById("toggle-icon");
    this._toggleText = this.shadowRoot.getElementById("toggle-text");
    this._addSectionWrapper = this.shadowRoot.getElementById("add-section-wrapper");
    this._deleteDialog = this.shadowRoot.getElementById("delete-dialog");
    this._confirmDialog = this.shadowRoot.getElementById("confirm-dialog");
    this._recordBtn = this.shadowRoot.getElementById("record-btn");
    this._recordIcon = this.shadowRoot.getElementById("record-icon");
    this._recordText = this.shadowRoot.getElementById("record-text");
    this._discardRecordBtn = this.shadowRoot.getElementById("discard-record-btn");
    this._recordingSetupDialog = this.shadowRoot.getElementById("recording-setup-dialog");
    this._loggerChecklist = this.shadowRoot.getElementById("logger-checklist");
    this._recordingSetupStart = this.shadowRoot.getElementById("recording-setup-start");
    this._recordingSetupCancel = this.shadowRoot.getElementById("recording-setup-cancel");
    this._recordingDedupToggle = this.shadowRoot.getElementById("recording-dedup-toggle");
    this._recordingDedupToggle.checked = liveViewModule().isDedupEnabled(this);
    this._profileSelect = this.shadowRoot.getElementById("recording-profile-select");
    this._profileRow = this.shadowRoot.getElementById("recording-profile-row");
    this._profileSaveBtn = this.shadowRoot.getElementById("recording-profile-save");
    this._profileSaveNewBtn = this.shadowRoot.getElementById("recording-profile-save-new");
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
    this._loggerFilterBtn = this.shadowRoot.getElementById("logger-filter-btn");
    this._loggerFilterPanel = this.shadowRoot.getElementById("logger-filter-panel");
    this._loggerFilterSearch = this.shadowRoot.getElementById("logger-filter-search");
    this._loggerFilterList = this.shadowRoot.getElementById("logger-filter-list");
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

    // Recording setup dialog handlers (profiles, exclusions, start).
    recordingSetupModule().attachRecordingSetup(this);

    // Live view dialog and preview controls.
    liveViewModule().attachLiveView(this);

    resultsModule().attachResults(this);

    // Stop, clear and discard controls belong to the recording session.
    recordingSessionModule().attachRecordingSession(this);

    // Right-click context menu, shared by every non-text surface. Text inputs
    // keep the browser's cut/copy/paste menu.
    contextMenuModule().attachContextMenu(this);

    // Add/edit logger form and bulk "set all" control.
    addFormModule().attachAddForm(this);

    // Re-render after focus leaves a control so a deferred commit is reflected,
    // coalesced through the same rAF scheduler the state updates use so routine
    // tabbing does not trigger a full list rebuild per focus change.
    this.shadowRoot.addEventListener("focusout", () => {
      this._scheduleUpdate();
    });

    // Explicit row-selection model for the logger panel and the live/results views.
    selectionModule().attachSelection(this);

    // Ctrl/Cmd+C copies the selected entries when a selection resolves to the
    // recording buffer; otherwise the browser's native copy runs. Text-entry
    // controls keep native copy.
    this.shadowRoot.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c") return;
      const active = this.shadowRoot.activeElement;
      const tag = active && active.tagName ? active.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (this._selectedKeys && this._selectedKeys.size > 0 &&
          resultsModule().selectedBufferKeys(this).length > 0) {
        e.preventDefault();
        resultsModule().copyLogsToClipboard(this);
      }
    });

    // ESC key closes any open dialog.
    this.shadowRoot.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this._contextMenu && this._contextMenu.style.display === "block") {
        contextMenuModule().hideContextMenu(this);
        return;
      }
      if (this._deleteDialog.style.display === "flex") {
        this._deleteDialog.style.display = "none";
        this._deleteConfirmTarget = null;
      } else if (this._confirmDialog && this._confirmDialog.style.display === "flex") {
        // Route ESC through the confirm's cancel path so onCancel runs
        // (Set-all revert, raise-sequence restore).
        uiModule().dismissConfirm(this);
      } else if (this._historyDialog.style.display === "flex") {
        this._historyDialog.classList.remove("visible");
        this._historyDialog.style.display = "none";
      } else if (this._recordingSetupDialog.style.display === "flex") {
        this._recordingSetupDialog.classList.remove("visible");
        this._recordingSetupDialog.style.display = "none";
      } else if (this._recordingLiveDialog.style.display === "flex") {
        resultsModule().closeLiveView(this);
      }
    });
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

export { LogManagerCard };
