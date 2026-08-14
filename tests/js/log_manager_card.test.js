const fs = require("fs");
const path = require("path");

const cardSource = fs.readFileSync(
  path.resolve(__dirname, "../../custom_components/log_manager/www/log_manager/log_manager_card.js"),
  "utf8"
);

let cardInstance;

beforeAll(() => {
  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function () {
    const root = document.createElement("div");
    root.className = "shadow-root";
    this.shadowRoot = root;
    return root;
  };

  // Only define the custom element once.
  if (!customElements.get("log-manager-card")) {
    eval(cardSource);
  }

  Element.prototype.attachShadow = originalAttachShadow;

  cardInstance = document.createElement("log-manager-card");
});

describe("LogManagerCard", () => {
  describe("_escapeAttr", () => {
    test("escapes &, \", <, >", () => {
      expect(cardInstance._escapeAttr('a&b"c<d>e')).toBe("a&amp;b&quot;c&lt;d&gt;e");
    });

    test("passes through safe strings", () => {
      expect(cardInstance._escapeAttr("hello world")).toBe("hello world");
    });

    test("handles empty string", () => {
      expect(cardInstance._escapeAttr("")).toBe("");
    });
  });

  describe("_escapeHtml", () => {
    test("escapes &, <, > but not quotes", () => {
      expect(cardInstance._escapeHtml('a&b"c<d>e')).toBe("a&amp;b\"c&lt;d&gt;e");
    });

    test("passes through safe strings", () => {
      expect(cardInstance._escapeHtml("normal text")).toBe("normal text");
    });
  });

  describe("_levelColors", () => {
    test("returns correct colors for known levels", () => {
      const debug = cardInstance._levelColors("DEBUG");
      expect(debug.color).toBe("#03a9f4");

      const error = cardInstance._levelColors("ERROR");
      expect(error.color).toBe("#f44336");

      const critical = cardInstance._levelColors("CRITICAL");
      expect(critical.color).toBe("#9c27b0");
    });

    test("returns NOTSET colors for unknown level", () => {
      const unknown = cardInstance._levelColors("BOGUS");
      expect(unknown.color).toBe("var(--primary-text-color)");
    });
  });

  describe("_debounce", () => {
    test("only calls function once within wait period", (done) => {
      let callCount = 0;
      const fn = cardInstance._debounce(() => {
        callCount++;
      }, 50);

      fn();
      fn();
      fn();

      expect(callCount).toBe(0);

      setTimeout(() => {
        expect(callCount).toBe(1);
        done();
      }, 100);
    });

    test("calls with correct arguments", (done) => {
      let capturedArgs;
      const fn = cardInstance._debounce((...args) => {
        capturedArgs = args;
      }, 30);

      fn(1, 2, 3);

      setTimeout(() => {
        expect(capturedArgs).toEqual([1, 2, 3]);
        done();
      }, 60);
    });
  });

  describe("sessionStorage persistence", () => {
    beforeEach(() => {
      sessionStorage.clear();
    });

    test("_persistState writes to sessionStorage", () => {
      cardInstance._pathInput = { value: "test.path" };
      cardInstance._friendlyNameInput = { value: "Test Name" };

      cardInstance._persistState();

      expect(sessionStorage.getItem("logManagerPath")).toBe("test.path");
      expect(sessionStorage.getItem("logManagerName")).toBe("Test Name");
    });

    test("_clearState removes sessionStorage items", () => {
      cardInstance._pathInput = { value: "existing.path" };
      cardInstance._friendlyNameInput = { value: "Existing" };

      sessionStorage.setItem("logManagerPath", "existing.path");
      sessionStorage.setItem("logManagerName", "Existing");

      cardInstance._clearState();

      expect(sessionStorage.getItem("logManagerPath")).toBeNull();
      expect(sessionStorage.getItem("logManagerName")).toBeNull();
      expect(cardInstance._pathInput.value).toBe("");
      expect(cardInstance._friendlyNameInput.value).toBe("");
    });
  });

  describe("_renderCounterBadgeHtml", () => {
    test("returns empty string when no warnings or errors", () => {
      const result = cardInstance._renderCounterBadgeHtml("test.logger");
      expect(result).toBe("");
    });

    test("renders warning badge with count", () => {
      cardInstance._counters = { "test.logger": { warning: 3, error: 0 } };
      const result = cardInstance._renderCounterBadgeHtml("test.logger");
      expect(result).toContain("warning-badge");
      expect(result).toContain("3");
      expect(result).not.toContain("error-badge");
    });

    test("renders error badge with count", () => {
      cardInstance._counters = { "test.logger": { warning: 0, error: 2 } };
      const result = cardInstance._renderCounterBadgeHtml("test.logger");
      expect(result).toContain("error-badge");
      expect(result).toContain("2");
      expect(result).not.toContain("warning-badge");
    });

    test("renders both badges when both present", () => {
      cardInstance._counters = { "test.logger": { warning: 1, error: 4 } };
      const result = cardInstance._renderCounterBadgeHtml("test.logger");
      expect(result).toContain("warning-badge");
      expect(result).toContain("error-badge");
      expect(result).toContain("1");
      expect(result).toContain("4");
    });
  });

  describe("_updateRecordingCountBadge", () => {
    let row;

    beforeEach(() => {
      cardInstance._hass = { states: {} };
      cardInstance._openLiveView = jest.fn();
      cardInstance._recordingCounts = {};

      row = document.createElement("div");
      row.innerHTML = `
        <div class="log-controls-wrapper">
          <div class="log-controls"></div>
        </div>
      `;
    });

    test("creates badge when recording and count > 0", () => {
      cardInstance._updateRecordingCountBadge(row, "test.logger", 5, true);
      const badge = row.querySelector(".recording-count-badge");
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain("5");
    });

    test("does not create badge when count is 0", () => {
      cardInstance._updateRecordingCountBadge(row, "test.logger", 0, true);
      expect(row.querySelector(".recording-count-badge")).toBeNull();
    });

    test("removes badge when recording stops", () => {
      cardInstance._updateRecordingCountBadge(row, "test.logger", 5, true);
      expect(row.querySelector(".recording-count-badge")).not.toBeNull();

      cardInstance._updateRecordingCountBadge(row, "test.logger", 5, false);
      expect(row.querySelector(".recording-count-badge")).toBeNull();
    });

    test("badge click opens live view", () => {
      cardInstance._updateRecordingCountBadge(row, "test.logger", 3, true);
      const badge = row.querySelector(".recording-count-badge");
      badge.click();
      expect(cardInstance._openLiveView).toHaveBeenCalledTimes(1);
    });

    test("does not duplicate click handler when badge updates", () => {
      cardInstance._updateRecordingCountBadge(row, "test.logger", 3, true);
      cardInstance._updateRecordingCountBadge(row, "test.logger", 5, true);
      const badge = row.querySelector(".recording-count-badge");
      badge.click();
      expect(cardInstance._openLiveView).toHaveBeenCalledTimes(1);
    });

    test("badge has recBadgeHandler flag after creation", () => {
      cardInstance._updateRecordingCountBadge(row, "test.logger", 3, true);
      const badge = row.querySelector(".recording-count-badge");
      expect(badge.dataset.recBadgeHandler).toBe("true");
    });
  });

  describe("_buildUI", () => {
    test("binds _liveBtn element", () => {
      const mockRoot = document.createElement("div");
      mockRoot.getElementById = function (id) {
        return this.querySelector(`#${id}`);
      };
      cardInstance.shadowRoot = mockRoot;

      expect(cardInstance._liveBtn).toBeUndefined();
      cardInstance._buildUI();
      expect(cardInstance._liveBtn).toBeDefined();
      expect(cardInstance._liveBtn.id).toBe("live-btn");
    });
  });

  describe("row DOM structure", () => {
    test("row template wraps badges and controls in log-controls-wrapper", () => {
      const row = document.createElement("div");
      row.innerHTML = `
        <div class="log-name">Test</div>
        <div class="log-controls-wrapper">
          <div class="counter-badges">
            <span class="counter-badge warning-badge">&#9888; 3</span>
          </div>
          <div class="log-controls">
            <select class="level-select"></select>
          </div>
        </div>
        <div class="log-panel"></div>
      `;
      const wrapper = row.querySelector(".log-controls-wrapper");
      expect(wrapper).not.toBeNull();
      expect(wrapper.querySelector(".counter-badges")).not.toBeNull();
      expect(wrapper.querySelector(".log-controls")).not.toBeNull();
      expect(wrapper.parentElement).toBe(row);
    });
  });

  describe("recording state change", () => {
    let row;

    beforeEach(() => {
      cardInstance._hass = { states: {} };
      cardInstance._openLiveView = jest.fn();
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
      cardInstance._updateRecordingCountBadge(row, loggerName, 5, isRecording);
      expect(row.querySelector(".recording-count-badge")).not.toBeNull();

      // Now simulate recording stopping (same count, but isRecording=false)
      cardInstance._recordingState = "completed";
      isRecording = cardInstance._recordingState === "recording" && cardInstance._recordingLoggers.includes(loggerName);
      cardInstance._updateRecordingCountBadge(row, loggerName, 5, isRecording);
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
      rec._cleanupRecordingIntervals();
      rec._cleanupLivePolling();
    });

    test("_startRecording sends the command and adopts max_duration on success", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        status: "recording",
        max_duration: 120,
      });
      rec._startRecording(["rec.logger"], { "rec.logger": "DEBUG" });
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
      rec._startRecording(["rec.logger"], {});
      rejectCommand(new Error("boom"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rec._recordingState).toBeNull();
      expect(rec._recordingCounts).toEqual({});
    });

    test("_stopRecording fetches the buffer and shows results", async () => {
      rec._showRecordingResults = jest.fn();
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        logs: [{ id: 0, timestamp: 1, level: "INFO", logger: "rec.logger", message: "hi" }],
        duration: 2.0,
        log_count: 1,
        status: "completed",
      });
      rec._stopRecording();
      await Promise.resolve();

      expect(rec._recordingState).toBe("results");
      expect(rec._recordingBuffer).toHaveLength(1);
      expect(rec._recordingDuration).toBe(2.0);
      expect(rec._showRecordingResults).toHaveBeenCalledTimes(1);
    });

    test("_pollRecordingStatus transitions to completed and fetches results when live view is open", async () => {
      rec._recordingState = "recording";
      rec._liveViewOpen = true;
      rec._fetchResults = jest.fn();
      rec._cleanupRecordingIntervals = jest.fn();
      rec._cleanupLivePolling = jest.fn();
      rec._updateRecordingUI = jest.fn();
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        status: "completed",
        log_count: 5,
        elapsed: 10,
        max_duration: 300,
        logger_counts: { "rec.logger": 5 },
      });
      rec._pollRecordingStatus();
      await Promise.resolve();

      expect(rec._recordingState).toBe("completed");
      expect(rec._recordingLogCount).toBe(5);
      expect(rec._fetchResults).toHaveBeenCalledTimes(1);
    });

    test("_pollRecordingEntries appends new entries and advances next_id", async () => {
      rec._recordingState = "recording";
      rec._liveLastId = 0;
      rec._recordingBuffer = [];
      rec._livePreview = {
        appendChild: jest.fn(),
        scrollHeight: 0,
        scrollTop: 0,
        clientHeight: 0,
      };
      rec._liveLevelFilter = { value: "ALL" };
      rec._liveLoggerFilter = { value: "" };
      rec._updateLiveSummary = jest.fn();
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        entries: [
          { id: 0, timestamp: 1, level: "INFO", logger: "rec.logger", message: "one" },
          { id: 1, timestamp: 2, level: "WARNING", logger: "rec.logger", message: "two" },
        ],
        next_id: 2,
      });
      rec._pollRecordingEntries();
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
      rec._updateLiveSummary = jest.fn();
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        entries: [],
        next_id: 2,
      });
      rec._pollRecordingEntries();
      await Promise.resolve();

      expect(rec._livePreview.appendChild).not.toHaveBeenCalled();
      expect(rec._liveLastId).toBe(2);
    });

    test("_entryMatchesFilter filters by level threshold", () => {
      const entry = { logger: "rec.logger", level: "WARNING" };
      expect(cardInstance._entryMatchesFilter(entry, "ALL", "")).toBe(true);
      expect(cardInstance._entryMatchesFilter(entry, "WARNING", "")).toBe(true);
      expect(cardInstance._entryMatchesFilter(entry, "ERROR", "")).toBe(false);
    });

    test("_entryMatchesFilter matches child loggers for a logger filter", () => {
      const entry = { logger: "rec.logger.child", level: "INFO" };
      expect(cardInstance._entryMatchesFilter(entry, "ALL", "rec.logger")).toBe(true);
      expect(cardInstance._entryMatchesFilter(entry, "ALL", "other.logger")).toBe(false);
    });
  });

  describe("_updateBadgesInPlace", () => {
    let row;

    beforeEach(() => {
      cardInstance._counters = {};
      row = document.createElement("div");
      row.innerHTML = `
        <div class="log-controls-wrapper">
          <div class="counter-badges">
            <span class="counter-badge warning-badge">&#9888; 2</span>
          </div>
          <div class="log-controls"></div>
        </div>
      `;
    });

    test("updates an existing badge in place without recreating the element", () => {
      const badge = row.querySelector(".warning-badge");
      cardInstance._counters = { "t.logger": { warning: 5, error: 0 } };
      cardInstance._updateBadgesInPlace(row, "t.logger");

      const updated = row.querySelector(".warning-badge");
      expect(updated).toBe(badge);
      expect(updated.textContent).toContain("5");
    });

    test("removes badge and container when all counts drop to zero", () => {
      cardInstance._counters = { "t.logger": { warning: 0, error: 0 } };
      cardInstance._updateBadgesInPlace(row, "t.logger");

      expect(row.querySelector(".warning-badge")).toBeNull();
      expect(row.querySelector(".counter-badges")).toBeNull();
    });

    test("creates an error badge when only errors are present", () => {
      cardInstance._counters = { "t.logger": { warning: 0, error: 3 } };
      cardInstance._updateBadgesInPlace(row, "t.logger");

      const badge = row.querySelector(".error-badge");
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain("3");
    });

    test("updates badge text via textContent, not HTML entities", () => {
      cardInstance._counters = { "t.logger": { warning: 7, error: 0 } };
      cardInstance._updateBadgesInPlace(row, "t.logger");

      const badge = row.querySelector(".warning-badge");
      expect(badge.textContent).toBe("\u26A0 7");
      expect(badge.textContent).not.toContain("&#9888;");
    });
  });

  describe("_openRecordingSetup", () => {
    let rec;

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.test_logger": {
            attributes: {
              logger_name: "test.logger",
              friendly_name: "Test Logger",
            },
            state: "NOTSET",
          },
        },
      };
      rec._loggerChecklist = document.createElement("div");
      rec._recordingSetupDialog = document.createElement("div");
      rec._recordingSetupStart = { disabled: false };
    });

    test("offers NOTSET and preselects it for a NOTSET logger", () => {
      rec._openRecordingSetup();

      const options = Array.from(
        rec._loggerChecklist.querySelectorAll(".recording-level-select option")
      ).map((o) => o.value);
      expect(options).toContain("NOTSET");

      const select = rec._loggerChecklist.querySelector(".recording-level-select");
      expect(select.value).toBe("NOTSET");
    });

    test("preselects the current level for a non-NOTSET logger", () => {
      rec._hass.states["select.test_logger"].state = "WARNING";
      rec._openRecordingSetup();

      const select = rec._loggerChecklist.querySelector(".recording-level-select");
      expect(select.value).toBe("WARNING");
    });
  });

  describe("recording export", () => {
    let rec;
    let origCreate;
    let origRevoke;
    let origBlob;
    let blobArgs;

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      rec._recordingBuffer = [
        {
          timestamp: 0,
          level: "INFO",
          logger: "rec.logger",
          message: "hello world",
          source: "/code/app.py:42",
        },
      ];
      origCreate = URL.createObjectURL;
      origRevoke = URL.revokeObjectURL;
      origBlob = global.Blob;
      blobArgs = null;
      URL.createObjectURL = jest.fn(() => "blob:mock");
      URL.revokeObjectURL = jest.fn();
      global.Blob = function (parts, opts) {
        blobArgs = { parts, opts };
      };
    });

    afterEach(() => {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      global.Blob = origBlob;
      navigator.clipboard = undefined;
    });

    test("_downloadLogs builds a plain-text .log file", () => {
      let clicked = null;
      const clickSpy = jest
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(function () {
          clicked = { download: this.download, href: this.href };
        });
      try {
        rec._downloadLogs("plain");
      } finally {
        clickSpy.mockRestore();
      }

      expect(clicked.download).toMatch(/\.log$/);
      expect(clicked.href).toBe("blob:mock");
      expect(blobArgs.parts[0]).toContain("INFO");
      expect(blobArgs.parts[0]).toContain("rec.logger");
      expect(blobArgs.parts[0]).toContain("hello world");
    });

    test("_downloadLogs builds a JSONL file", () => {
      let clicked = null;
      const clickSpy = jest
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(function () {
          clicked = { download: this.download, href: this.href };
        });
      try {
        rec._downloadLogs("jsonl");
      } finally {
        clickSpy.mockRestore();
      }

      expect(clicked.download).toMatch(/\.jsonl$/);
      expect(blobArgs.parts[0]).toContain('"level":"INFO"');
      expect(blobArgs.parts[0]).toContain('"message":"hello world"');
    });

    test("_copyLogsToClipboard writes formatted text and shows confirmation", async () => {
      rec._liveCopyBtn = { textContent: "Copy to clipboard" };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: jest.fn().mockResolvedValue(undefined) },
      });
      await rec._copyLogsToClipboard();

      const text = navigator.clipboard.writeText.mock.calls[0][0];
      expect(text).toContain("INFO");
      expect(text).toContain("rec.logger");
      expect(text).toContain("hello world");
      expect(rec._liveCopyBtn.textContent).toBe("Copied!");
    });
  });

  describe("_updateLiveSummary", () => {
    let rec;

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      rec._liveSummary = { textContent: "" };
      rec._recordingLoggers = [];
      rec._recordingBuffer = [];
    });

    test("uses singular wording for one entry and one logger", () => {
      rec._recordingLoggers = ["rec.logger"];
      rec._recordingBuffer = [{ id: 0, logger: "rec.logger", level: "INFO", message: "x" }];
      rec._updateLiveSummary();
      expect(rec._liveSummary.textContent).toBe(
        "1 entry \u00B7 buffer at 0% \u00B7 1 logger recording \u00B7 1 with entry"
      );
    });

    test("uses plural wording for multiple entries and loggers", () => {
      rec._recordingLoggers = ["a.logger", "b.logger", "c.logger"];
      rec._recordingBuffer = [
        { id: 0, logger: "a.logger", level: "INFO", message: "x" },
        { id: 1, logger: "a.logger", level: "WARNING", message: "y" },
        { id: 2, logger: "b.logger", level: "ERROR", message: "z" },
      ];
      rec._updateLiveSummary();
      expect(rec._liveSummary.textContent).toBe(
        "3 entries \u00B7 buffer at 0% \u00B7 3 loggers recording \u00B7 2 with entries"
      );
    });

    test("derives with-entries from the buffer, ignoring stale _recordingCounts", () => {
      rec._recordingLoggers = ["a.logger"];
      rec._recordingBuffer = [{ id: 0, logger: "a.logger", level: "INFO", message: "x" }];
      rec._recordingCounts = { "stale.logger": 99 };
      rec._updateLiveSummary();
      expect(rec._liveSummary.textContent).toContain("1 with entry");
      expect(rec._liveSummary.textContent).not.toContain("stale");
    });
  });

  describe("_updateLiveTimer", () => {
    let rec;

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      rec._recordingLiveDialog = {};
      rec._liveTimer = { textContent: "" };
      rec._liveStatusText = { textContent: "" };
      rec._liveStatusDot = { style: { display: "" } };
      rec._recordingState = "recording";
      rec._recordingStartTime = Date.now();
      rec._recordingMaxDuration = 300;
      rec._livePaused = false;
    });

    test("shows plain recording status when not paused", () => {
      rec._updateLiveTimer();
      expect(rec._liveStatusText.textContent).toBe("Recording");
    });

    test("shows paused status when the view is paused", () => {
      rec._livePaused = true;
      rec._updateLiveTimer();
      expect(rec._liveStatusText.textContent).toBe("Recording \u00B7 view paused");
    });

    test("shows recording complete when recording has finished", () => {
      rec._recordingState = "completed";
      rec._updateLiveTimer();
      expect(rec._liveStatusText.textContent).toBe("Recording Complete");
    });
  });

  describe("_togglePauseLive", () => {
    let rec;

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      rec._livePaused = false;
      rec._livePauseBtn = { textContent: "", title: "" };
      rec._liveStatusText = { textContent: "" };
      rec._recordingState = "recording";
      rec._pollRecordingEntries = jest.fn();
    });

    test("updates the status text immediately with the paused label", () => {
      rec._togglePauseLive();
      expect(rec._livePaused).toBe(true);
      expect(rec._livePauseBtn.textContent).toBe("Resume");
      expect(rec._liveStatusText.textContent).toBe("Recording \u00B7 view paused");
      expect(rec._pollRecordingEntries).not.toHaveBeenCalled();

      rec._togglePauseLive();
      expect(rec._livePaused).toBe(false);
      expect(rec._livePauseBtn.textContent).toBe("Pause");
      expect(rec._liveStatusText.textContent).toBe("Recording");
      expect(rec._pollRecordingEntries).toHaveBeenCalledTimes(1);
    });
  });
});
