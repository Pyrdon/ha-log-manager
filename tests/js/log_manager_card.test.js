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

  describe("logger grouping", () => {
    const groupStates = () => ({
      "select.core_a": {
        state: "INFO",
        attributes: {
          logger_name: "homeassistant.core.a",
          friendly_name: "Core A",
          options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        },
      },
      "select.core_b": {
        state: "INFO",
        attributes: {
          logger_name: "homeassistant.core.b",
          friendly_name: "Core B",
          options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        },
      },
      "select.hacs": {
        state: "INFO",
        attributes: {
          logger_name: "custom_components.hacs",
          friendly_name: "HACS",
          options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        },
      },
    });

    beforeEach(() => {
      window.localStorage.removeItem("log_manager_collapsed_groups");
      delete cardInstance.config;
      cardInstance._hass = { states: groupStates(), callService: jest.fn() };
      cardInstance._counters = {};
      cardInstance._prevRowStates = {};
      cardInstance._prevPanelHtml = {};
      cardInstance._expandedLogger = null;
      cardInstance._recordingCounts = {};
      cardInstance._recordingState = null;
      cardInstance._recordingLoggers = [];
      cardInstance._activeList = document.createElement("div");
    });

    afterEach(() => {
      delete cardInstance.config;
      window.localStorage.removeItem("log_manager_collapsed_groups");
    });

    test("_groupKey uses the first two dotted segments", () => {
      expect(cardInstance._groupKey("homeassistant.components.light")).toBe(
        "homeassistant.components"
      );
      expect(cardInstance._groupKey("custom_components.hacs")).toBe(
        "custom_components.hacs"
      );
      expect(cardInstance._groupKey("mylogger")).toBe("mylogger");
    });

    test("grouped rows render under prefix sections with counts", () => {
      cardInstance._updateActiveList();
      const sections = Array.from(
        cardInstance._activeList.querySelectorAll(":scope > .log-group")
      );
      expect(sections.map((s) => s.dataset.group)).toEqual([
        "custom_components.hacs",
        "homeassistant.core",
      ]);
      const core = sections[1];
      expect(core.querySelector(".log-group-count").textContent).toBe("(2)");
      const rows = Array.from(core.querySelectorAll(".log-row"));
      expect(rows.map((r) => r.dataset.entityId)).toEqual([
        "select.core_a",
        "select.core_b",
      ]);
    });

    test("group_by_prefix false renders a flat list", () => {
      cardInstance.config = { type: "custom:log-manager-card", group_by_prefix: false };
      cardInstance._updateActiveList();
      expect(
        cardInstance._activeList.querySelector(".log-group")
      ).toBeNull();
      expect(
        cardInstance._activeList.querySelectorAll(":scope > .log-row").length
      ).toBe(3);
    });

    test("collapsing a section hides its rows and persists", () => {
      cardInstance._updateActiveList();
      const section = cardInstance._activeList.querySelector(
        '.log-group[data-group="homeassistant.core"]'
      );
      section.querySelector(".log-group-header").click();
      expect(
        section.querySelector(".log-group-rows").style.display
      ).toBe("none");
      expect(
        JSON.parse(
          window.localStorage.getItem("log_manager_collapsed_groups")
        )
      ).toEqual({ "homeassistant.core": true });

      // A fresh render restores the collapsed state without rebuilding rows.
      const before = section.querySelector(
        '.log-row[data-entity-id="select.core_a"]'
      );
      cardInstance._updateActiveList();
      const after = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.core_a"]'
      );
      expect(after).toBe(before);
      expect(
        after.closest(".log-group-rows").style.display
      ).toBe("none");
    });

    test("switching to flat mode unwraps sections and restores row order", () => {
      cardInstance._updateActiveList();
      expect(
        cardInstance._activeList.querySelectorAll(":scope > .log-group").length
      ).toBe(2);

      cardInstance.config = { type: "custom:log-manager-card", group_by_prefix: false };
      cardInstance._updateActiveList();

      expect(
        cardInstance._activeList.querySelector(".log-group")
      ).toBeNull();
      const rows = Array.from(
        cardInstance._activeList.querySelectorAll(":scope > .log-row")
      );
      expect(rows.map((r) => r.dataset.entityId)).toEqual([
        "select.core_a",
        "select.core_b",
        "select.hacs",
      ]);
    });

    test("removing a logger drops its empty section", () => {
      cardInstance._updateActiveList();
      expect(
        cardInstance._activeList.querySelectorAll(":scope > .log-group").length
      ).toBe(2);

      delete cardInstance._hass.states["select.hacs"];
      cardInstance._updateActiveList();

      const sections = Array.from(
        cardInstance._activeList.querySelectorAll(":scope > .log-group")
      );
      expect(sections.map((s) => s.dataset.group)).toEqual([
        "homeassistant.core",
      ]);
      expect(sections[0].querySelector(".log-group-count").textContent).toBe(
        "(2)"
      );
    });

    test("a corrupt collapsed-groups value degrades to all expanded", () => {
      window.localStorage.setItem(
        "log_manager_collapsed_groups",
        "null"
      );
      cardInstance._updateActiveList();
      const sections = Array.from(
        cardInstance._activeList.querySelectorAll(":scope > .log-group")
      );
      expect(sections.length).toBe(2);
      sections.forEach((section) => {
        expect(
          section.querySelector(".log-group-rows").style.display
        ).not.toBe("none");
      });
    });
  });

  describe("live-view dedup", () => {
    const ts = 1700000000;
    const mk = (id, dt, logger, level = "ERROR", message = "boom", source = "mod.py") => ({
      id,
      timestamp: ts + dt,
      logger,
      level,
      message,
      source,
    });
    const minuteFmt = (t) =>
      new Date(t * 1000).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

    beforeEach(() => {
      delete cardInstance.config;
      cardInstance._livePreview = document.createElement("div");
      cardInstance._liveLevelFilter = { value: "ALL" };
      cardInstance._liveLoggerFilter = { value: "" };
      cardInstance._recordingBuffer = [];
      cardInstance._liveLastGroup = null;
      cardInstance._liveLastSingle = null;
      cardInstance._expandedDedupKeys = new Set();
      cardInstance._resultsShown = false;
    });

    afterEach(() => {
      delete cardInstance.config;
    });

    test("_dedupKey separates source but tolerates a missing one", () => {
      const a = mk(0, 0, "a.logger");
      expect(cardInstance._dedupKey(a)).toBe(cardInstance._dedupKey(mk(1, 99, "a.logger")));
      expect(cardInstance._dedupKey(a)).not.toBe(
        cardInstance._dedupKey(mk(0, 0, "a.logger", "ERROR", "boom", "other.py"))
      );
      const noSource = { id: 0, timestamp: 1, logger: "a.logger", level: "ERROR", message: "boom" };
      expect(() => cardInstance._dedupKey(noSource)).not.toThrow();
    });

    test("consecutive identical entries fold into one group", () => {
      cardInstance._appendLiveEntries([mk(0, 0, "a.logger"), mk(1, 5, "a.logger")]);
      expect(
        cardInstance._livePreview.querySelectorAll(".log-preview-line").length
      ).toBe(0);
      const groups = cardInstance._livePreview.querySelectorAll(".log-preview-group");
      expect(groups.length).toBe(1);
      expect(groups[0].querySelector(".dedup-count").textContent).toBe("×2");
      expect(groups[0].querySelector(".time-col").textContent).toBe(minuteFmt(ts));
      expect(
        groups[0].nextElementSibling.querySelectorAll(".log-preview-group-item").length
      ).toBe(2);
    });

    test("a cross-minute group shows a time range", () => {
      cardInstance._appendLiveEntries([mk(0, 0, "a.logger"), mk(1, 125, "a.logger")]);
      const time = cardInstance._livePreview.querySelector(
        ".log-preview-group .time-col"
      ).textContent;
      expect(time).toBe(`${minuteFmt(ts)}–${minuteFmt(ts + 125)}`);
    });

    test("non-consecutive repeats stay separate", () => {
      cardInstance._appendLiveEntries([
        mk(0, 0, "a.logger"),
        mk(1, 1, "b.logger", "ERROR", "other"),
        mk(2, 2, "a.logger"),
      ]);
      expect(
        cardInstance._livePreview.querySelectorAll(".log-preview-line").length
      ).toBe(3);
      expect(
        cardInstance._livePreview.querySelector(".log-preview-group")
      ).toBeNull();
    });

    test("filter-hidden entries neither render nor split visible runs", () => {
      cardInstance._liveLoggerFilter = { value: "a.logger" };
      cardInstance._appendLiveEntries([
        mk(0, 0, "a.logger"),
        mk(1, 1, "b.logger", "ERROR", "other"),
        mk(2, 2, "a.logger"),
      ]);
      const groups = cardInstance._livePreview.querySelectorAll(".log-preview-group");
      expect(groups.length).toBe(1);
      expect(groups[0].querySelector(".dedup-count").textContent).toBe("×2");
    });

    test("different level, message, or source never merge", () => {
      for (const [level, message, source] of [
        ["WARNING", "boom", "mod.py"],
        ["ERROR", "different", "mod.py"],
        ["ERROR", "boom", "other.py"],
      ]) {
        cardInstance._livePreview.innerHTML = "";
        cardInstance._liveLastGroup = null;
        cardInstance._liveLastSingle = null;
        cardInstance._appendLiveEntries([
          mk(0, 0, "a.logger"),
          mk(1, 1, "a.logger", level, message, source),
        ]);
        expect(
          cardInstance._livePreview.querySelectorAll(".log-preview-line").length
        ).toBe(2);
      }
    });

    test("clicking a group expands and collapses its occurrences", () => {
      cardInstance._appendLiveEntries([mk(0, 0, "a.logger"), mk(1, 5, "a.logger")]);
      const group = cardInstance._livePreview.querySelector(".log-preview-group");
      const items = group.nextElementSibling;
      expect(items.style.display).toBe("none");
      group.click();
      expect(items.style.display).toBe("");
      group.click();
      expect(items.style.display).toBe("none");
    });

    test("live_dedup false renders the raw stream", () => {
      cardInstance.config = { type: "custom:log-manager-card", live_dedup: false };
      cardInstance._liveLoggerFilter = { value: "a.logger" };
      cardInstance._appendLiveEntries([
        mk(0, 0, "a.logger"),
        mk(1, 1, "b.logger", "ERROR", "other"),
        mk(2, 2, "a.logger"),
      ]);
      expect(
        cardInstance._livePreview.querySelectorAll(".log-preview-line").length
      ).toBe(3);
      expect(
        cardInstance._livePreview.querySelector(".log-preview-group")
      ).toBeNull();
      const hidden = Array.from(
        cardInstance._livePreview.querySelectorAll(".log-preview-line")
      ).filter((el) => el.style.display === "none");
      expect(hidden.length).toBe(1);
    });

    test("changing filters regroups the visible stream", () => {
      cardInstance._appendLiveEntries([
        mk(0, 0, "a.logger"),
        mk(1, 1, "b.logger", "ERROR", "other"),
        mk(2, 2, "a.logger"),
      ]);
      expect(
        cardInstance._livePreview.querySelectorAll(".log-preview-line").length
      ).toBe(3);

      cardInstance._liveLoggerFilter = { value: "a.logger" };
      cardInstance._recordingBuffer = [
        mk(0, 0, "a.logger"),
        mk(1, 1, "b.logger", "ERROR", "other"),
        mk(2, 2, "a.logger"),
      ];
      cardInstance._applyLiveFilters();
      const groups = cardInstance._livePreview.querySelectorAll(".log-preview-group");
      expect(groups.length).toBe(1);
      expect(groups[0].querySelector(".dedup-count").textContent).toBe("×2");
    });

    test("_groupConsecutiveDedup batches newest-first results runs", () => {
      const runs = cardInstance._groupConsecutiveDedup([
        mk(2, 2, "a.logger"),
        mk(1, 1, "a.logger"),
        mk(0, 0, "b.logger", "ERROR", "other"),
      ]);
      expect(runs.length).toBe(2);
      expect(runs[0].count).toBe(2);
      expect(runs[0].firstId).toBe(2);
      expect(runs[1].count).toBe(1);
    });

    describe("results view", () => {
      const stubResultsChrome = () => {
        cardInstance._liveStatusText = { parentElement: { style: {} } };
        cardInstance._livePauseBtn = { style: {}, textContent: "", title: "" };
        cardInstance._liveStopBtn = { style: {} };
        cardInstance._liveCloseBtn = { style: {}, textContent: "", title: "" };
        cardInstance._liveClearBtn = { style: {} };
        cardInstance._liveDiscardBtn = { style: {} };
        cardInstance._liveSavePlainBtn = { disabled: false, title: "" };
        cardInstance._liveSaveJsonlBtn = { disabled: false, title: "" };
        cardInstance._liveCopyBtn = { disabled: false, title: "" };
        cardInstance._liveSummary = { textContent: "" };
        cardInstance._recordingLiveDialog = {
          style: {},
          classList: { add: jest.fn(), remove: jest.fn() },
        };
        cardInstance._recordingDuration = 10;
        cardInstance._recordingLogCount = 3;
      };

      let rafSpy;
      beforeEach(() => {
        stubResultsChrome();
        rafSpy = jest
          .spyOn(window, "requestAnimationFrame")
          .mockImplementation((cb) => {
            cb();
            return 0;
          });
      });

      afterEach(() => {
        rafSpy.mockRestore();
      });

      test("results group newest-first and filter changes keep that order", () => {
        cardInstance._recordingBuffer = [
          mk(0, 0, "a.logger"),
          mk(1, 1, "a.logger"),
          mk(2, 2, "b.logger", "ERROR", "other"),
        ];
        cardInstance._showRecordingResults();
        let groups = cardInstance._livePreview.querySelectorAll(".log-preview-group");
        expect(groups.length).toBe(1);

        // Changing filters must not flip results into oldest-first live order.
        cardInstance._liveLoggerFilter = { value: "" };
        cardInstance._applyLiveFilters();
        const rows = Array.from(
          cardInstance._livePreview.querySelectorAll(
            ".log-preview-line, .log-preview-group"
          )
        );
        expect(rows.length).toBe(2);
        // Newest-first: the lone "other" line, then the folded a.logger pair.
        expect(rows[0].querySelector(".msg-col").textContent).toContain("other");
        expect(rows[1].className).toContain("log-preview-group");
        expect(rows[1].querySelector(".dedup-count").textContent).toBe("×2");
      });

      test("showing results clears live expansions", () => {
        cardInstance._expandedDedupKeys.add("a.logger\x1fERROR\x1fboom\x1fmod.py");
        cardInstance._recordingBuffer = [mk(0, 0, "a.logger"), mk(1, 5, "a.logger")];
        cardInstance._showRecordingResults();
        expect(cardInstance._expandedDedupKeys.size).toBe(0);
        const items = cardInstance._livePreview.querySelector(
          ".log-preview-group-items"
        );
        expect(items.style.display).toBe("none");
      });

      test("copying across a group emits every grouped entry", () => {
        cardInstance._recordingBuffer = [mk(0, 0, "a.logger"), mk(1, 5, "a.logger")];
        cardInstance._showRecordingResults();
        const group = cardInstance._livePreview.querySelector(".log-preview-group");
        const range = {
          startContainer: group.querySelector(".msg-col").firstChild,
          endContainer: group.querySelector(".msg-col").firstChild,
          collapsed: false,
        };
        const selection = {
          rangeCount: 1,
          isCollapsed: false,
          getRangeAt: () => range,
        };
        const event = {
          preventDefault: jest.fn(),
          clipboardData: { setData: jest.fn() },
        };
        const realSelection = window.getSelection;
        window.getSelection = () => selection;
        try {
          cardInstance._handlePreviewCopy(event);
        } finally {
          window.getSelection = realSelection;
        }
        expect(event.preventDefault).toHaveBeenCalled();
        const text = event.clipboardData.setData.mock.calls[0][1];
        expect(text.split("\n").filter(Boolean)).toHaveLength(2);
        expect(text).toContain("boom");
      });
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
        querySelector: jest.fn(() => ({})),
        insertAdjacentHTML: jest.fn(),
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

  describe("counting level panel", () => {
    beforeEach(() => {
      cardInstance._hass = {
        states: {
          "select.test": {
            state: "INFO",
            attributes: { logger_name: "t.logger", count_level: "INFO" },
          },
        },
        callService: jest.fn(),
      };
      cardInstance._counters = {
        "t.logger": {
          warning: 1,
          error: 0,
          recent_logs: [
            {
              timestamp: 1700000000,
              level: "INFO",
              logger: "t.logger",
              message: "some info",
              source: "",
            },
          ],
          levels: { INFO: 12, WARNING: 1 },
        },
      };
    });

    test("renders the count select with the entity's counting level selected", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('class="count-level-select"');
      expect(html).toContain('<option value="INFO" selected>INFO</option>');
    });

    test("disclaimer reflects the counting threshold", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain("INFO and above");
    });

    test("renders a per-severity count line and omits zero counts", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain("INFO 12");
      expect(html).toContain("WARNING 1");
      expect(html).not.toContain("ERROR 0");
      expect(html).not.toContain("DEBUG 0");
    });

    test("renders INFO entries with an info chip", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain("log-level-info");
      expect(html).toContain(">I</span>");
    });

    test("defaults to WARNING when no entity exposes a counting level", () => {
      cardInstance._hass = { states: {}, callService: jest.fn() };
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('<option value="WARNING" selected>WARNING</option>');
      expect(html).toContain("WARNING and above");
    });

    test("changing the count select calls set_count_level", () => {
      const row = document.createElement("div");
      row.innerHTML = cardInstance._renderLogPanelHtml("t.logger");
      cardInstance._attachCountLevelHandler(row);

      const sel = row.querySelector(".count-level-select");
      sel.value = "DEBUG";
      sel.dispatchEvent(new Event("change", { bubbles: true }));

      expect(cardInstance._hass.callService).toHaveBeenCalledWith(
        "log_manager",
        "set_count_level",
        { logger_name: "t.logger", level: "DEBUG" }
      );
    });
  });

  describe("alert threshold panel", () => {
    beforeEach(() => {
      cardInstance._hass = {
        states: {
          "select.test": {
            state: "INFO",
            attributes: {
              logger_name: "t.logger",
              count_level: "WARNING",
              alert_threshold: 5,
              alert_level: "WARNING",
            },
          },
        },
        callService: jest.fn(),
      };
      cardInstance._counters = {
        "t.logger": { warning: 2, error: 0, recent_logs: [], levels: { WARNING: 2 } },
      };
    });

    test("renders the alert severity select and threshold input with current values", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('class="alert-level-select"');
      expect(html).toContain('<option value="WARNING" selected>WARNING</option>');
      expect(html).toContain('class="alert-threshold-input"');
      expect(html).toContain('value="5"');
    });

    test("defaults to ERROR severity and zero threshold without entity data", () => {
      cardInstance._hass = { states: {}, callService: jest.fn() };
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('<option value="ERROR" selected>ERROR</option>');
      expect(html).toContain('value="0"');
    });

    test("changing either control calls set_alert_threshold with both values", () => {
      const row = document.createElement("div");
      row.innerHTML = cardInstance._renderLogPanelHtml("t.logger");
      cardInstance._attachAlertHandler(row);

      const sel = row.querySelector(".alert-level-select");
      const num = row.querySelector(".alert-threshold-input");
      num.value = "7";
      sel.value = "ERROR";
      sel.dispatchEvent(new Event("change", { bubbles: true }));

      expect(cardInstance._hass.callService).toHaveBeenCalledWith(
        "log_manager",
        "set_alert_threshold",
        { logger_name: "t.logger", events: 7, level: "ERROR" }
      );
    });
  });

  describe("counter sensor toggle", () => {
    beforeEach(() => {
      cardInstance._hass = {
        states: {
          "select.test": {
            state: "INFO",
            attributes: {
              logger_name: "t.logger",
              count_level: "WARNING",
              alert_threshold: 0,
              alert_level: "ERROR",
              sensor_enabled: true,
            },
          },
        },
        callService: jest.fn(),
      };
      cardInstance._counters = {
        "t.logger": { warning: 0, error: 0, recent_logs: [], levels: {} },
      };
    });

    test("renders a checked toggle when sensors are enabled", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('class="sensor-enabled-toggle"');
      expect(html).toContain("checked");
    });

    test("renders an unchecked toggle by default", () => {
      cardInstance._hass.states["select.test"].attributes.sensor_enabled = false;
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('class="sensor-enabled-toggle"');
      expect(html).not.toContain("checked");
    });

    test("toggling calls set_sensor_enabled with the checkbox state", () => {
      const row = document.createElement("div");
      row.innerHTML = cardInstance._renderLogPanelHtml("t.logger");
      cardInstance._attachSensorHandler(row);

      const toggle = row.querySelector(".sensor-enabled-toggle");
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));

      expect(cardInstance._hass.callService).toHaveBeenCalledWith(
        "log_manager",
        "set_sensor_enabled",
        { logger_name: "t.logger", enabled: false }
      );
    });

    test("panel refresh path keeps the toggle wired to set_sensor_enabled", () => {
      Object.assign(cardInstance._hass.states["select.test"].attributes, {
        friendly_name: "Test",
        options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        sensor_enabled: true,
      });
      cardInstance._counters = {
        "t.logger": { warning: 0, error: 0, recent_logs: [], levels: {} },
      };
      cardInstance._prevRowStates = {};
      cardInstance._prevPanelHtml = {};
      cardInstance._activeList = document.createElement("div");
      cardInstance._expandedLogger = "t.logger";

      // Create path: expanded row renders the panel and wires the toggle.
      cardInstance._updateActiveList();
      let row = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.test"]'
      );
      expect(row.querySelector(".sensor-enabled-toggle")).not.toBeNull();

      // Update path: an attr change replaces the panel HTML and must re-wire.
      cardInstance._hass.states["select.test"].attributes.sensor_enabled = false;
      cardInstance._updateActiveList();
      row = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.test"]'
      );
      const toggle = row.querySelector(".sensor-enabled-toggle");
      expect(toggle.checked).toBe(false);

      toggle.checked = true;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      expect(cardInstance._hass.callService).toHaveBeenCalledWith(
        "log_manager",
        "set_sensor_enabled",
        { logger_name: "t.logger", enabled: true }
      );

      cardInstance._expandedLogger = null;
    });
  });

  describe("audit trail panel", () => {
    beforeEach(() => {
      cardInstance._hass = {
        states: {
          "select.test": {
            state: "INFO",
            attributes: {
              logger_name: "t.logger",
              count_level: "WARNING",
              alert_threshold: 0,
              alert_level: "ERROR",
              audit: [
                { ts: 1700000000, source: "ui", old_level: "NOTSET", new_level: "INFO" },
                { ts: 1699999900, source: "ui", old_level: "INFO", new_level: "DEBUG" },
              ],
            },
          },
        },
        callService: jest.fn(),
      };
      cardInstance._counters = {
        "t.logger": { warning: 0, error: 0, recent_logs: [], levels: {} },
      };
    });

    test("renders a history line with source labels and levels", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain("Level changes:");
      expect(html).toContain("by UI NOTSET");
      expect(html).toContain("by UI INFO");
    });

    test("omits the history line when there are no entries", () => {
      cardInstance._hass.states["select.test"].attributes.audit = [];
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).not.toContain("Level changes:");
    });

    test("shows at most three entries", () => {
      cardInstance._hass.states["select.test"].attributes.audit = [
        { ts: 1, source: "ui", old_level: "A", new_level: "B" },
        { ts: 2, source: "ui", old_level: "B", new_level: "C" },
        { ts: 3, source: "ui", old_level: "C", new_level: "D" },
        { ts: 4, source: "ui", old_level: "D", new_level: "E" },
      ];
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain("A \u2192 B");
      expect(html).not.toContain("D \u2192 E");
    });
  });

  describe("core-pinned rows", () => {
    const pinnedTitle = "Managed by Home Assistant";

    beforeEach(() => {
      cardInstance._hass = {
        states: {
          "select.pinned": {
            state: "DEBUG",
            attributes: {
              logger_name: "p.logger",
              friendly_name: "Pinned",
              count_level: "WARNING",
              core_pinned: true,
              options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
            },
          },
          "select.free": {
            state: "INFO",
            attributes: {
              logger_name: "f.logger",
              friendly_name: "Free",
              count_level: "WARNING",
              core_pinned: false,
              options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
            },
          },
        },
        callService: jest.fn(),
      };
      cardInstance._counters = {};
      cardInstance._prevRowStates = {};
      cardInstance._activeList = document.createElement("div");
    });

    test("pinned rows render a disabled selector with a tooltip", () => {
      cardInstance._expandedLogger = null;
      cardInstance._updateActiveList();
      const row = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.pinned"]'
      );
      const select = row.querySelector(".level-select");
      expect(select.disabled).toBe(true);
      expect(select.title).toContain(pinnedTitle);
      expect(row.querySelector(".pinned-tag").textContent).toBe("Pinned");
    });

    test("unpinned rows keep an enabled selector and no tag", () => {
      cardInstance._expandedLogger = null;
      cardInstance._updateActiveList();
      const row = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.free"]'
      );
      expect(row.querySelector(".level-select").disabled).toBe(false);
      expect(row.querySelector(".pinned-tag")).toBeNull();
    });

    test("flipping the pin updates the row in place without rebuilding it", () => {
      cardInstance._expandedLogger = null;
      cardInstance._updateActiveList();
      const before = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.free"]'
      );
      expect(before.querySelector(".pinned-tag")).toBeNull();

      cardInstance._hass.states["select.free"].attributes.core_pinned = true;
      cardInstance._updateActiveList();

      const after = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.free"]'
      );
      expect(after).toBe(before);
      expect(after.querySelector(".pinned-tag").textContent).toBe("Pinned");
      const select = after.querySelector(".level-select");
      expect(select.disabled).toBe(true);
      expect(select.title).toContain(pinnedTitle);
    });
  });

  describe("effective-level chip", () => {
    beforeEach(() => {
      cardInstance._hass = {
        states: {
          "select.inherit": {
            state: "NOTSET",
            attributes: {
              logger_name: "i.logger",
              friendly_name: "Inherit",
              count_level: "WARNING",
              core_pinned: false,
              effective_level: "DEBUG",
              effective_source: "i.parent",
              options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
            },
          },
          "select.explicit": {
            state: "INFO",
            attributes: {
              logger_name: "e.logger",
              friendly_name: "Explicit",
              count_level: "WARNING",
              core_pinned: false,
              effective_level: "INFO",
              effective_source: null,
              options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
            },
          },
        },
        callService: jest.fn(),
      };
      cardInstance._counters = {};
      cardInstance._prevRowStates = {};
      cardInstance._activeList = document.createElement("div");
    });

    test("NOTSET rows show the effective level with its source", () => {
      cardInstance._expandedLogger = null;
      cardInstance._updateActiveList();
      const row = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.inherit"]'
      );
      const chip = row.querySelector(".effective-line");
      expect(chip).not.toBeNull();
      expect(chip.textContent).toContain("effective:");
      expect(chip.textContent).toContain("DEBUG");
      expect(chip.title).toContain("i.parent");
    });

    test("explicit-level rows show no chip", () => {
      cardInstance._expandedLogger = null;
      cardInstance._updateActiveList();
      const row = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.explicit"]'
      );
      expect(row.querySelector(".effective-line")).toBeNull();
    });

    test("changing the effective level updates the chip in place", () => {
      cardInstance._expandedLogger = null;
      cardInstance._updateActiveList();
      const before = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.inherit"]'
      );
      expect(before.querySelector(".effective-line").textContent).toContain("DEBUG");

      cardInstance._hass.states["select.inherit"].attributes.effective_level = "INFO";
      cardInstance._updateActiveList();

      const after = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.inherit"]'
      );
      expect(after).toBe(before);
      expect(after.querySelector(".effective-line").textContent).toContain("INFO");
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

  describe("recording profiles", () => {
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
          "select.other": {
            attributes: {
              logger_name: "other.logger",
              friendly_name: "Other",
            },
            state: "INFO",
          },
        },
        connection: { sendMessagePromise: jest.fn(() => Promise.resolve({ profiles: [] })) },
        callService: jest.fn(),
      };
      rec._loggerChecklist = document.createElement("div");
      rec._recordingSetupDialog = document.createElement("div");
      rec._recordingSetupStart = { disabled: false };
      rec._profileSelect = document.createElement("select");
      rec._profileSaveRow = document.createElement("div");
      rec._profileNameInput = document.createElement("input");
      rec._profileDeleteBtn = document.createElement("button");
      rec._openRecordingSetup();
    });

    test("loads profiles into the select on open", async () => {
      expect(rec._hass.connection.sendMessagePromise).toHaveBeenCalledWith({
        type: "log_manager/profiles_get",
      });
      await Promise.resolve();
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        profiles: [{ name: "p1", loggers: [], level_overrides: {}, max_duration: 60 }],
      });
      rec._loadProfiles();
      await Promise.resolve();
      expect(rec._profileSelect.innerHTML).toContain("p1");
    });

    test("applying a profile checks its loggers and levels", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        profiles: [{
          name: "p1",
          loggers: ["test.logger"],
          level_overrides: { "test.logger": "DEBUG" },
          max_duration: 60,
        }],
      });
      rec._applyProfile("p1");
      await Promise.resolve();
      await Promise.resolve();

      const boxes = rec._loggerChecklist.querySelectorAll(
        "input[type='checkbox']:not(#select-all-checkbox)"
      );
      const byLogger = {};
      boxes.forEach(cb => { byLogger[cb.dataset.logger] = cb; });
      expect(byLogger["test.logger"].checked).toBe(true);
      expect(byLogger["other.logger"].checked).toBe(false);
      const levelSelect = byLogger["test.logger"]
        .closest(".checklist-item")
        .querySelector(".recording-level-select");
      expect(levelSelect.value).toBe("DEBUG");
    });

    test("saving sends the current selection", async () => {
      const boxes = rec._loggerChecklist.querySelectorAll(
        "input[type='checkbox']:not(#select-all-checkbox)"
      );
      boxes.forEach(cb => {
        cb.checked = cb.dataset.logger === "test.logger";
      });
      rec._profileNameInput.value = "p1";
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({ profiles: [] });

      rec._saveProfile();
      await Promise.resolve();

      expect(rec._hass.connection.sendMessagePromise).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "log_manager/profile_save",
          name: "p1",
          loggers: ["test.logger"],
        })
      );
    });
  });

  describe("recording exclusions", () => {
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
      rec._openRecordingSetup();
      rec._loggerChecklist
        .querySelector("input[type='checkbox']:not(#select-all-checkbox)")
        .checked = true;
    });

    test("toggle reveals the exclusion input", () => {
      const area = rec._loggerChecklist.querySelector(".exclude-area");
      expect(area.style.display).toBe("none");

      rec._loggerChecklist.querySelector(".exclude-toggle").click();
      expect(area.style.display).toBe("block");
    });

    test("Enter adds a chip for a valid child path", () => {
      const inp = rec._loggerChecklist.querySelector(".exclude-input");
      inp.value = "test.logger.noisy";
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      const chips = rec._loggerChecklist.querySelectorAll(".exclude-chip");
      expect(chips.length).toBe(1);
      expect(chips[0].dataset.path).toBe("test.logger.noisy");
      expect(inp.value).toBe("");
    });

    test("non-child paths are rejected and flagged", () => {
      const inp = rec._loggerChecklist.querySelector(".exclude-input");
      inp.value = "other.logger";
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(rec._loggerChecklist.querySelectorAll(".exclude-chip").length).toBe(0);
      expect(inp.classList.contains("exclude-invalid")).toBe(true);
    });

    test("editing clears a stale invalid flag", () => {
      const inp = rec._loggerChecklist.querySelector(".exclude-input");
      inp.value = "other.logger";
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(inp.classList.contains("exclude-invalid")).toBe(true);

      inp.value = "test.logger.";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      expect(inp.classList.contains("exclude-invalid")).toBe(false);
    });

    test("collecting excludes returns chips of checked loggers only", () => {
      const inp = rec._loggerChecklist.querySelector(".exclude-input");
      inp.value = "test.logger.noisy";
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(rec._collectRecordingExcludes()).toEqual({
        "test.logger": ["test.logger.noisy"],
      });
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
