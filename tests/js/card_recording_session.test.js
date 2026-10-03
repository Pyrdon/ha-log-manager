import { jest } from "@jest/globals";
import {
  setupCard,
  cardSource,
  cardStylesSource,
  cardMarkupSource,
  liveView,
  results,
  recordingSession,
  recordingSetup,
  loggers,
  addForm,
  utils,
} from "./setup.js";

let cardInstance;

beforeAll(async () => {
  await setupCard();
  cardInstance = document.createElement("log-manager-card");
});

describe("LogManagerCard", () => {
  describe("_updateRecordingCountBadge", () => {
    let row;

    beforeEach(() => {
      cardInstance._hass = { states: {} };
      // The badge click handler calls liveView.openLiveView directly.
      jest.spyOn(liveView, "openLiveView").mockImplementation(() => {});
      cardInstance._recordingCounts = {};

      row = document.createElement("div");
      row.innerHTML = `
        <div class="log-controls-wrapper">
          <div class="log-controls"></div>
        </div>
      `;
    });

    afterEach(() => {
      liveView.openLiveView.mockRestore();
    });

    test("creates badge when recording and count > 0", () => {
      recordingSession.updateRecordingCountBadge(cardInstance, row, "test.logger", 5, true);
      const badge = row.querySelector(".recording-count-badge");
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain("5");
    });

    test("does not create badge when count is 0", () => {
      recordingSession.updateRecordingCountBadge(cardInstance, row, "test.logger", 0, true);
      expect(row.querySelector(".recording-count-badge")).toBeNull();
    });

    test("removes badge when recording stops", () => {
      recordingSession.updateRecordingCountBadge(cardInstance, row, "test.logger", 5, true);
      expect(row.querySelector(".recording-count-badge")).not.toBeNull();

      recordingSession.updateRecordingCountBadge(cardInstance, row, "test.logger", 5, false);
      expect(row.querySelector(".recording-count-badge")).toBeNull();
    });

    test("badge click opens live view", () => {
      recordingSession.updateRecordingCountBadge(cardInstance, row, "test.logger", 3, true);
      const badge = row.querySelector(".recording-count-badge");
      badge.click();
      expect(liveView.openLiveView).toHaveBeenCalledTimes(1);
    });

    test("does not duplicate click handler when badge updates", () => {
      recordingSession.updateRecordingCountBadge(cardInstance, row, "test.logger", 3, true);
      recordingSession.updateRecordingCountBadge(cardInstance, row, "test.logger", 5, true);
      const badge = row.querySelector(".recording-count-badge");
      badge.click();
      expect(liveView.openLiveView).toHaveBeenCalledTimes(1);
    });

    test("badge has recBadgeHandler flag after creation", () => {
      recordingSession.updateRecordingCountBadge(cardInstance, row, "test.logger", 3, true);
      const badge = row.querySelector(".recording-count-badge");
      expect(badge.dataset.recBadgeHandler).toBe("true");
    });
  });

  describe("recording state change", () => {
    let row;

    beforeEach(() => {
      cardInstance._hass = { states: {} };
      cardInstance._recordingCounts = {};
      cardInstance._recordingState = null;
      cardInstance._recordingLoggers = [];

      row = document.createElement("div");
      row.innerHTML = `
        <div class="log-name">
          <div style="font-weight: 500;">Test Logger</div>
        </div>
        <div class="log-controls-wrapper">
          <div class="log-controls"></div>
        </div>
      `;
    });

    test("recording count badge is removed when recording state transitions to inactive", () => {
      const loggerName = "test.logger";
      cardInstance._recordingLoggers = [loggerName];
      cardInstance._recordingState = "recording";
      let isRecording = cardInstance._recordingState === "recording" && cardInstance._recordingLoggers.includes(loggerName);
      recordingSession.updateRecordingCountBadge(cardInstance, row, loggerName, 5, isRecording);
      expect(row.querySelector(".recording-count-badge")).not.toBeNull();

      // Now simulate recording stopping (same count, but isRecording=false)
      cardInstance._recordingState = "completed";
      isRecording = cardInstance._recordingState === "recording" && cardInstance._recordingLoggers.includes(loggerName);
      recordingSession.updateRecordingCountBadge(cardInstance, row, loggerName, 5, isRecording);
      expect(row.querySelector(".recording-count-badge")).toBeNull();
    });
  });

  describe("recording flow", () => {
    let rec;

    // Give a fresh card instance the minimal recording UI elements the real
    // _updateRecordingUI() touches.
    const stubRecordingUI = (c) => {
      c._recordIcon = { setAttribute: jest.fn() };
      c._recordBtn = { classList: { add: jest.fn(), remove: jest.fn() } };
      c._recordText = { textContent: "" };
      c._liveBtn = { style: { display: "" } };
      c._discardRecordBtn = { style: { display: "" } };
      c._recordingCounts = {};
      c._recordingState = null;
      c._recordingLoggers = [];
      c._recordingBuffer = [];
      c._recordingLevelOverrides = {};
    };

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      stubRecordingUI(rec);
      rec._hass = { connection: { sendMessagePromise: jest.fn() } };
    });

    afterEach(() => {
      recordingSession.cleanupRecordingIntervals(rec);
      liveView.cleanupLivePolling(rec);
      jest.restoreAllMocks();
    });

    test("_startRecording sends the command and adopts max_duration on success", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        status: "recording",
        max_duration: 120,
      });
      recordingSession.startRecording(rec, ["rec.logger"], { "rec.logger": "DEBUG" });
      await Promise.resolve();

      expect(rec._recordingState).toBe("recording");
      expect(rec._recordingLoggers).toEqual(["rec.logger"]);
      expect(rec._recordingLevelOverrides).toEqual({ "rec.logger": "DEBUG" });
      expect(rec._recordingMaxDuration).toBe(120);
      expect(rec._hass.connection.sendMessagePromise).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "log_manager/start_recording",
          loggers: ["rec.logger"],
        })
      );
    });

    test("_startRecording resets state on failure", async () => {
      let rejectCommand;
      rec._hass.connection.sendMessagePromise.mockImplementation(
        () => new Promise((_, reject) => { rejectCommand = reject; })
      );
      recordingSession.startRecording(rec, ["rec.logger"], {});
      rejectCommand(new Error("boom"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rec._recordingState).toBeNull();
      expect(rec._recordingCounts).toEqual({});
    });

    test("_checkExistingRecording adopts the session's pending level reverts", async () => {
      jest.spyOn(recordingSession, "updateRecordingUI").mockImplementation(() => {});
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        status: "recording",
        elapsed: 5,
        max_duration: 300,
        loggers: ["rec.logger"],
        logger_counts: {},
        level_restore: {
          "rec.logger": { entity_id: "select.rec", from: "INFO", to: "DEBUG" },
        },
      });
      recordingSession.checkExistingRecording(rec);
      await Promise.resolve();

      expect(rec._recordingState).toBe("recording");
      expect(rec._recordingRestoreLevels["rec.logger"]).toEqual({
        entityId: "select.rec",
        level: "INFO",
        raisedTo: "DEBUG",
      });
      recordingSession.updateRecordingUI.mockRestore();
    });

    test("_stopRecording fetches the buffer and shows results", async () => {
      jest.spyOn(results, "showRecordingResults").mockImplementation(() => {});
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        logs: [{ id: 0, timestamp: 1, level: "INFO", logger: "rec.logger", message: "hi" }],
        duration: 2.0,
        log_count: 1,
        status: "completed",
      });
      recordingSession.stopRecording(rec);
      await Promise.resolve();

      expect(rec._recordingState).toBe("results");
      expect(rec._recordingBuffer).toHaveLength(1);
      expect(rec._recordingDuration).toBe(2.0);
      expect(results.showRecordingResults).toHaveBeenCalledTimes(1);
      results.showRecordingResults.mockRestore();
    });

    test("_pollRecordingStatus transitions to completed and fetches results when live view is open", async () => {
      rec._recordingState = "recording";
      rec._liveViewOpen = true;
      jest.spyOn(results, "fetchResults").mockImplementation(() => {});
      jest.spyOn(recordingSession, "cleanupRecordingIntervals").mockImplementation(() => {});
      jest.spyOn(liveView, "cleanupLivePolling").mockImplementation(() => {});
      jest.spyOn(recordingSession, "updateRecordingUI").mockImplementation(() => {});
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        status: "completed",
        log_count: 5,
        elapsed: 10,
        max_duration: 300,
        logger_counts: { "rec.logger": 5 },
      });
      recordingSession.pollRecordingStatus(rec);
      await Promise.resolve();

      expect(rec._recordingState).toBe("completed");
      expect(rec._recordingLogCount).toBe(5);
      expect(results.fetchResults).toHaveBeenCalledTimes(1);
      results.fetchResults.mockRestore();
      recordingSession.cleanupRecordingIntervals.mockRestore();
      liveView.cleanupLivePolling.mockRestore();
      recordingSession.updateRecordingUI.mockRestore();
    });

    test("_pollRecordingEntries appends new entries and advances next_id", async () => {
      rec._recordingState = "recording";
      rec._liveLastId = 0;
      rec._recordingBuffer = [];
      rec._livePreview = {
        appendChild: jest.fn(),
        querySelector: jest.fn(() => ({})),
        insertAdjacentHTML: jest.fn(),
        scrollHeight: 0,
        scrollTop: 0,
        clientHeight: 0,
      };
      rec._liveLevelFilter = { value: "ALL" };
      rec._liveLoggerFilter = { value: "" };
      jest.spyOn(liveView, "updateLiveSummary").mockImplementation(() => {});
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        entries: [
          { id: 0, timestamp: 1, level: "INFO", logger: "rec.logger", message: "one" },
          { id: 1, timestamp: 2, level: "WARNING", logger: "rec.logger", message: "two" },
        ],
        next_id: 2,
      });
      liveView.pollRecordingEntries(rec);
      await Promise.resolve();

      expect(rec._recordingBuffer).toHaveLength(2);
      expect(rec._liveLastId).toBe(2);
      expect(rec._livePreview.appendChild).toHaveBeenCalledTimes(2);
    });

    test("_pollRecordingEntries does not re-append entries already seen", async () => {
      rec._recordingState = "recording";
      rec._liveLastId = 2;
      rec._recordingBuffer = [];
      rec._livePreview = {
        appendChild: jest.fn(),
        scrollHeight: 0,
        scrollTop: 0,
        clientHeight: 0,
      };
      rec._liveLevelFilter = { value: "ALL" };
      rec._liveLoggerFilter = { value: "" };
      jest.spyOn(liveView, "updateLiveSummary").mockImplementation(() => {});
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        entries: [],
        next_id: 2,
      });
      liveView.pollRecordingEntries(rec);
      await Promise.resolve();

      expect(rec._livePreview.appendChild).not.toHaveBeenCalled();
      expect(rec._liveLastId).toBe(2);
    });

    test("_entryMatchesFilter filters by level threshold", () => {
      const entry = { logger: "rec.logger", level: "WARNING" };
      expect(liveView.entryMatchesFilter(cardInstance, entry, "ALL", "")).toBe(true);
      expect(liveView.entryMatchesFilter(cardInstance, entry, "WARNING", "")).toBe(true);
      expect(liveView.entryMatchesFilter(cardInstance, entry, "ERROR", "")).toBe(false);
    });

    test("_entryMatchesFilter matches only the exact logger, not its children", () => {
      const child = { logger: "rec.logger.child", level: "INFO" };
      const parent = { logger: "rec.logger", level: "INFO" };
      expect(liveView.entryMatchesFilter(cardInstance, parent, "ALL", "rec.logger")).toBe(true);
      expect(liveView.entryMatchesFilter(cardInstance, child, "ALL", "rec.logger")).toBe(false);
      expect(liveView.entryMatchesFilter(cardInstance, child, "ALL", "other.logger")).toBe(false);
    });
  });

  describe("recording verbosity prompt", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    test("_isMoreVerbose only flags lower severities above NOTSET", () => {
      const rec = document.createElement("log-manager-card");
      expect(utils.isMoreVerbose("DEBUG", "INFO")).toBe(true);
      expect(utils.isMoreVerbose("INFO", "INFO")).toBe(false);
      expect(utils.isMoreVerbose("WARNING", "INFO")).toBe(false);
      expect(utils.isMoreVerbose("DEBUG", "NOTSET")).toBe(false);
      expect(utils.isMoreVerbose("NOTSET", "INFO")).toBe(false);
    });

    test("more verbose options are marked in the setup", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.t": { attributes: { logger_name: "t.logger", friendly_name: "T" }, state: "INFO" },
        },
      };
      rec._loggerChecklist = document.createElement("div");
      rec._recordingSetupDialog = { style: {}, classList: { add: jest.fn(), remove: jest.fn() } };
      rec._recordingSetupStart = { disabled: false };
      recordingSetup.openRecordingSetup(rec);

      const debug = rec._loggerChecklist.querySelector('option[value="DEBUG"]');
      const warning = rec._loggerChecklist.querySelector('option[value="WARNING"]');
      expect(debug.dataset.moreVerbose).toBe("1");
      expect(warning.dataset.moreVerbose).toBeUndefined();
    });

    test("confirming a raise records the intent instead of changing the level", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.t": { entity_id: "select.t", attributes: { logger_name: "t.logger" }, state: "WARNING" },
        },
      };
      const item = document.createElement("div");
      item.className = "checklist-item";
      item.innerHTML = `<select class="recording-level-select" data-logger="t.logger" data-prev-level="WARNING"><option value="WARNING">WARNING</option><option value="DEBUG">DEBUG</option></select>`;
      const sel = item.querySelector(".recording-level-select");
      sel.value = "DEBUG";
      jest.spyOn(loggers, "showDeleteConfirm").mockImplementation((card, message, onConfirm) => onConfirm());

      recordingSession.handleRecordingLevelChange(rec, sel);

      expect(rec._recordingRaiseIntents["t.logger"]).toEqual({
        entityId: "select.t",
        from: "WARNING",
        to: "DEBUG",
      });
      expect(sel.value).toBe("DEBUG");
    });

    test("cancelling a raise reverts the select and records nothing", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.t": { entity_id: "select.t", attributes: { logger_name: "t.logger" }, state: "WARNING" },
        },
      };
      const item = document.createElement("div");
      item.className = "checklist-item";
      item.innerHTML = `<select class="recording-level-select" data-logger="t.logger" data-prev-level="WARNING"><option value="WARNING">WARNING</option><option value="DEBUG">DEBUG</option></select>`;
      const sel = item.querySelector(".recording-level-select");
      sel.value = "DEBUG";
      jest.spyOn(loggers, "showDeleteConfirm").mockImplementation((card, message, onConfirm, title, confirmLabel, onCancel) => onCancel && onCancel());

      recordingSession.handleRecordingLevelChange(rec, sel);

      expect(rec._recordingRaiseIntents["t.logger"]).toBeUndefined();
      expect(sel.value).toBe("WARNING");
    });

    test("changing to a less verbose level recolours the row", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.t": { entity_id: "select.t", attributes: { logger_name: "t.logger" }, state: "WARNING" },
        },
      };
      const item = document.createElement("div");
      item.className = "checklist-item";
      item.innerHTML = `<select class="recording-level-select" data-logger="t.logger" data-prev-level="WARNING"><option value="WARNING">WARNING</option><option value="ERROR">ERROR</option></select>`;
      const sel = item.querySelector(".recording-level-select");
      sel.value = "ERROR";

      recordingSession.handleRecordingLevelChange(rec, sel);

      const probeColor = document.createElement("span");
      probeColor.style.color = utils.levelColors("ERROR").color;
      const probeBg = document.createElement("span");
      probeBg.style.background = utils.levelColors("ERROR").rowBg;
      expect(sel.style.color).toBe(probeColor.style.color);
      expect(item.style.background).toBe(probeBg.style.background);
      expect(sel.dataset.prevLevel).toBe("ERROR");
    });

    test("raise prompt names the logger and colours both levels", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.t": {
            entity_id: "select.t",
            attributes: { logger_name: "t.logger", friendly_name: "Test Logger" },
            state: "WARNING",
          },
        },
      };
      const item = document.createElement("div");
      item.className = "checklist-item";
      item.innerHTML = `<select class="recording-level-select" data-logger="t.logger" data-prev-level="WARNING"><option value="WARNING">WARNING</option><option value="DEBUG">DEBUG</option></select>`;
      const sel = item.querySelector(".recording-level-select");
      sel.value = "DEBUG";
      let captured = null;
      jest.spyOn(loggers, "showDeleteConfirm").mockImplementation((card, message, onConfirm, title, confirmLabel, onCancel, htmlMessage) => {
        captured = { msg: message, html: htmlMessage };
      });

      recordingSession.handleRecordingLevelChange(rec, sel);

      expect(captured.html).toBe(true);
      expect(captured.msg).toContain("Test Logger");
      expect(captured.msg).not.toContain("This logger");
      expect(captured.msg).toContain(utils.levelColors("WARNING").color);
      expect(captured.msg).toContain(utils.levelColors("DEBUG").color);
    });

    test("cancelling a profile raise restores the select to the configured level", () => {
      const rec = document.createElement("log-manager-card");
      const item = document.createElement("div");
      item.className = "checklist-item";
      item.innerHTML = `<select class="recording-level-select" data-logger="t.logger" data-prev-level="DEBUG"><option value="INFO">INFO</option><option value="DEBUG">DEBUG</option></select>`;
      const sel = item.querySelector(".recording-level-select");
      sel.value = "DEBUG";
      const cancels = [];
      jest.spyOn(loggers, "showDeleteConfirm").mockImplementation((card, message, onConfirm, title, confirmLabel, onCancel) => {
        cancels.push(onCancel);
      });
      rec._recordingRaiseIntents = {};

      recordingSession.promptRaiseSequence(rec, [
        { loggerName: "t.logger", friendlyName: "Test Logger", entityId: "select.t", from: "INFO", to: "DEBUG", selectEl: sel },
      ]);
      expect(cancels).toHaveLength(1);
      cancels[0]();

      expect(sel.value).toBe("INFO");
      expect(sel.dataset.prevLevel).toBe("INFO");
      expect(rec._recordingRaiseIntents["t.logger"]).toBeUndefined();
    });

    test("_startRecording applies raise intents and remembers the originals", () => {
      const rec = document.createElement("log-manager-card");
      rec._recordIcon = { setAttribute: jest.fn() };
      rec._recordBtn = { classList: { add: jest.fn(), remove: jest.fn() }, title: "" };
      rec._recordText = { textContent: "" };
      rec._liveBtn = { style: { display: "" } };
      rec._discardRecordBtn = { style: { display: "" } };
      rec._recordingCounts = {};
      rec._recordingBuffer = [];
      rec._recordingLevelOverrides = {};
      rec._livePreview = document.createElement("div");
      rec._liveLoggerFilter = { value: "" };
      rec._liveLevelFilter = { value: "ALL" };
      rec._hass = {
        connection: { sendMessagePromise: jest.fn(() => new Promise(() => {})) },
        callService: jest.fn(),
      };
      rec._recordingRaiseIntents = {
        "rec.logger": { entityId: "select.rec", from: "INFO", to: "DEBUG" },
      };

      recordingSession.startRecording(rec, ["rec.logger"], { "rec.logger": "DEBUG" });

      expect(rec._hass.callService).toHaveBeenCalledWith("select", "select_option", {
        entity_id: "select.rec",
        option: "DEBUG",
      });
      expect(rec._recordingRestoreLevels["rec.logger"]).toEqual({
        entityId: "select.rec",
        level: "INFO",
        raisedTo: "DEBUG",
      });
      const payload = rec._hass.connection.sendMessagePromise.mock.calls
        .find(([msg]) => msg.type === "log_manager/start_recording")[0];
      // The intents go to the backend too, which owns the revert if the card
      // disappears (reload mid-session).
      expect(payload.raise_levels).toEqual({
        "rec.logger": { entity_id: "select.rec", from: "INFO", to: "DEBUG" },
      });
      recordingSession.cleanupRecordingIntervals(rec);
    });

    test("_startRecording restores raised levels when the start request fails", async () => {
      const rec = document.createElement("log-manager-card");
      rec._recordIcon = { setAttribute: jest.fn() };
      rec._recordBtn = { classList: { add: jest.fn(), remove: jest.fn() }, title: "" };
      rec._recordText = { textContent: "" };
      rec._liveBtn = { style: { display: "" } };
      rec._discardRecordBtn = { style: { display: "" } };
      rec._recordingCounts = {};
      rec._recordingBuffer = [];
      rec._recordingLevelOverrides = {};
      rec._livePreview = document.createElement("div");
      rec._liveLoggerFilter = { value: "" };
      rec._liveLevelFilter = { value: "ALL" };
      rec._hass = {
        connection: { sendMessagePromise: jest.fn(() => Promise.reject(new Error("nope"))) },
        callService: jest.fn(),
      };
      rec._recordingRaiseIntents = {
        "rec.logger": { entityId: "select.rec", from: "INFO", to: "DEBUG" },
      };

      recordingSession.startRecording(rec, ["rec.logger"], { "rec.logger": "DEBUG" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Raised to DEBUG first, then reverted to INFO because the session never started.
      expect(rec._hass.callService).toHaveBeenCalledWith("select", "select_option", {
        entity_id: "select.rec",
        option: "DEBUG",
      });
      expect(rec._hass.callService).toHaveBeenCalledWith("select", "select_option", {
        entity_id: "select.rec",
        option: "INFO",
      });
      expect(rec._recordingState).toBeNull();
      recordingSession.cleanupRecordingIntervals(rec);
    });
  });

  describe("raised indicator", () => {
    test("coexists with the effective chip and clears when not recording", () => {
      const rec = document.createElement("log-manager-card");
      rec._recordingRestoreLevels = {
        "t.logger": { entityId: "select.t", level: "INFO", raisedTo: "DEBUG" },
      };
      const chip = loggers.renderRaisedChipHtml(rec, "t.logger", true);
      expect(chip).toContain("Raised to DEBUG");
      expect(chip).toContain("Restored to INFO");

      const stateObj = {
        state: "NOTSET",
        attributes: { effective_level: "WARNING", effective_source: "root" },
      };
      expect(loggers.renderEffectiveChip(rec, stateObj, "NOTSET", false)).toContain("Effective:");
      expect(loggers.renderRaisedChipHtml(rec, "t.logger", false)).toBe("");
    });

    test("the row shows both the effective chip and the raised indicator", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.rec": {
            state: "NOTSET",
            attributes: {
              logger_name: "rec.logger",
              friendly_name: "Rec",
              options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
              effective_level: "WARNING",
              effective_source: "root",
            },
          },
        },
        callService: jest.fn(),
      };
      rec._counters = {};
      rec._prevRowStates = {};
      rec._activeList = document.createElement("div");
      rec._recordingState = "recording";
      rec._recordingLoggers = ["rec.logger"];
      rec._recordingCounts = {};
      rec._recordingRestoreLevels = {
        "rec.logger": { entityId: "select.rec", level: "INFO", raisedTo: "DEBUG" },
      };
      addForm.updateActiveList(rec);

      const row = rec._activeList.querySelector('.log-row[data-entity-id="select.rec"]');
      expect(row.querySelector(".effective-line").textContent).toContain("Effective:");
      const raised = row.querySelector(".raised-line");
      expect(raised.textContent).toContain("Raised to DEBUG");
      expect(raised.title).toContain("Restored to INFO");
    });
  });

  describe("recording level lock scope", () => {
    test("only recorded loggers have a locked level selector", () => {
      const rec = document.createElement("log-manager-card");
      const options = ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
      rec._hass = {
        states: {
          "select.rec": {
            state: "INFO",
            attributes: { logger_name: "rec.logger", friendly_name: "Rec", options },
          },
          "select.free": {
            state: "INFO",
            attributes: { logger_name: "free.logger", friendly_name: "Free", options },
          },
        },
        callService: jest.fn(),
      };
      rec._counters = {};
      rec._prevRowStates = {};
      rec._activeList = document.createElement("div");
      rec._recordingState = "recording";
      rec._recordingLoggers = ["rec.logger"];
      rec._recordingCounts = {};
      rec._expandedLogger = null;
      addForm.updateActiveList(rec);

      const locked = rec._activeList.querySelector('.log-row[data-entity-id="select.rec"] .level-select');
      const free = rec._activeList.querySelector('.log-row[data-entity-id="select.free"] .level-select');
      expect(locked.disabled).toBe(true);
      expect(locked.title).toContain("locked");
      expect(free.disabled).toBe(false);
      expect(free.title || "").not.toContain("locked");
    });
  });
});
