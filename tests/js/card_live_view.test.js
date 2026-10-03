import { jest } from "@jest/globals";
import { setupCard, liveView, results, contextMenu } from "./setup.js";

let cardInstance;

beforeAll(async () => {
  await setupCard();
  cardInstance = document.createElement("log-manager-card");
});

describe("LogManagerCard", () => {
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

    test("consecutive identical entries fold into one group", () => {
      liveView.appendLiveEntries(cardInstance, [mk(0, 0, "a.logger"), mk(1, 5, "a.logger")]);
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
      liveView.appendLiveEntries(cardInstance, [mk(0, 0, "a.logger"), mk(1, 125, "a.logger")]);
      const time = cardInstance._livePreview.querySelector(
        ".log-preview-group .time-col"
      ).textContent;
      expect(time).toBe(`${minuteFmt(ts)}–${minuteFmt(ts + 125)}`);
    });

    test("non-consecutive repeats stay separate", () => {
      liveView.appendLiveEntries(cardInstance, [
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
      liveView.appendLiveEntries(cardInstance, [
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
        liveView.appendLiveEntries(cardInstance, [
          mk(0, 0, "a.logger"),
          mk(1, 1, "a.logger", level, message, source),
        ]);
        expect(
          cardInstance._livePreview.querySelectorAll(".log-preview-line").length
        ).toBe(2);
      }
    });

    test("clicking the group chevron expands and collapses its occurrences", () => {
      liveView.appendLiveEntries(cardInstance, [mk(0, 0, "a.logger"), mk(1, 5, "a.logger")]);
      const group = cardInstance._livePreview.querySelector(".log-preview-group");
      const items = group.nextElementSibling;
      const toggle = group.querySelector(".dedup-toggle");
      expect(items.style.display).toBe("none");
      toggle.click();
      expect(items.style.display).toBe("");
      expect(items.querySelectorAll(".log-preview-group-item").length).toBe(2);
      toggle.click();
      expect(items.style.display).toBe("none");
    });

    test("double-clicking a group and clicking its count badge expand it", () => {
      liveView.appendLiveEntries(cardInstance, [mk(0, 0, "a.logger"), mk(1, 5, "a.logger")]);
      const group = cardInstance._livePreview.querySelector(".log-preview-group");
      const items = group.nextElementSibling;
      group.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(items.style.display).toBe("");
      group.querySelector(".dedup-count").click();
      expect(items.style.display).toBe("none");
    });

    test("live_dedup false renders the raw stream", () => {
      cardInstance.config = { type: "custom:log-manager-card", live_dedup: false };
      cardInstance._liveLoggerFilter = { value: "a.logger" };
      liveView.appendLiveEntries(cardInstance, [
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
      liveView.appendLiveEntries(cardInstance, [
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
      liveView.applyLiveFilters(cardInstance);
      const groups = cardInstance._livePreview.querySelectorAll(".log-preview-group");
      expect(groups.length).toBe(1);
      expect(groups[0].querySelector(".dedup-count").textContent).toBe("×2");
    });

    test("_groupConsecutiveDedup batches newest-first results runs", () => {
      const runs = liveView.groupConsecutiveDedup(cardInstance, [
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

      test("results render oldest-first and filter changes keep that order", () => {
        cardInstance._recordingBuffer = [
          mk(0, 0, "a.logger"),
          mk(1, 1, "a.logger"),
          mk(2, 2, "b.logger", "ERROR", "other"),
        ];
        results.showRecordingResults(cardInstance);
        let groups = cardInstance._livePreview.querySelectorAll(".log-preview-group");
        expect(groups.length).toBe(1);

        // Changing filters must not flip results away from live ordering.
        cardInstance._liveLoggerFilter = { value: "" };
        liveView.applyLiveFilters(cardInstance);
        const rows = Array.from(
          cardInstance._livePreview.querySelectorAll(
            ".log-preview-line, .log-preview-group"
          )
        );
        expect(rows.length).toBe(2);
        // Oldest-first, matching the live view: the folded a.logger pair first.
        expect(rows[0].className).toContain("log-preview-group");
        expect(rows[0].querySelector(".dedup-count").textContent).toBe("×2");
        expect(rows[1].querySelector(".msg-col").textContent).toContain("other");
      });

      test("showing results clears live expansions", () => {
        cardInstance._expandedDedupKeys.add("a.logger\x1fERROR\x1fboom\x1fmod.py");
        cardInstance._recordingBuffer = [mk(0, 0, "a.logger"), mk(1, 5, "a.logger")];
        results.showRecordingResults(cardInstance);
        expect(cardInstance._expandedDedupKeys.size).toBe(0);
        const items = cardInstance._livePreview.querySelector(
          ".log-preview-group-items"
        );
        expect(items.style.display).toBe("none");
      });

      test("copying across a group emits every grouped entry", () => {
        cardInstance._recordingBuffer = [mk(0, 0, "a.logger"), mk(1, 5, "a.logger")];
        results.showRecordingResults(cardInstance);
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
          contextMenu.handlePreviewCopy(cardInstance, event);
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
      liveView.updateLiveSummary(rec);
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
      liveView.updateLiveSummary(rec);
      expect(rec._liveSummary.textContent).toBe(
        "3 entries \u00B7 buffer at 0% \u00B7 3 loggers recording \u00B7 2 with entries"
      );
    });

    test("counts managed roots, not distinct child logger names", () => {
      rec._recordingLoggers = ["custom_components.log_manager"];
      rec._recordingBuffer = [
        { id: 0, logger: "custom_components.log_manager", level: "INFO", message: "x" },
        { id: 1, logger: "custom_components.log_manager.select", level: "INFO", message: "y" },
      ];
      liveView.updateLiveSummary(rec);
      expect(rec._liveSummary.textContent).toContain("1 with entry");
    });

    test("derives with-entries from the buffer, ignoring stale _recordingCounts", () => {
      rec._recordingLoggers = ["a.logger"];
      rec._recordingBuffer = [{ id: 0, logger: "a.logger", level: "INFO", message: "x" }];
      rec._recordingCounts = { "stale.logger": 99 };
      liveView.updateLiveSummary(rec);
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
      liveView.updateLiveTimer(rec);
      expect(rec._liveStatusText.textContent).toBe("Recording");
    });

    test("shows paused status when the view is paused", () => {
      rec._livePaused = true;
      liveView.updateLiveTimer(rec);
      expect(rec._liveStatusText.textContent).toBe("Recording \u00B7 view paused");
    });

    test("shows recording complete when recording has finished", () => {
      rec._recordingState = "completed";
      liveView.updateLiveTimer(rec);
      expect(rec._liveStatusText.textContent).toBe("Recording complete");
    });
  });

  describe("_togglePauseLive", () => {
    let rec;
    let pollSpy;

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      rec._livePaused = false;
      rec._livePauseBtn = {
        textContent: "",
        title: "",
        classList: { toggle: jest.fn(), add: jest.fn(), remove: jest.fn() },
      };
      rec._liveStatusText = { textContent: "" };
      rec._recordingState = "recording";
      pollSpy = jest.spyOn(liveView, "pollRecordingEntries").mockImplementation(() => {});
    });

    afterEach(() => {
      pollSpy.mockRestore();
    });

    test("updates the status text immediately with the paused label", () => {
      liveView.togglePauseLive(rec);
      expect(rec._livePaused).toBe(true);
      expect(rec._livePauseBtn.textContent).toBe("Resume");
      expect(rec._liveStatusText.textContent).toBe("Recording \u00B7 view paused");
      expect(pollSpy).not.toHaveBeenCalled();

      liveView.togglePauseLive(rec);
      expect(rec._livePaused).toBe(false);
      expect(rec._livePauseBtn.textContent).toBe("Pause");
      expect(rec._liveStatusText.textContent).toBe("Recording");
      expect(pollSpy).toHaveBeenCalledTimes(1);
    });

    test("polling while paused keeps the buffer and summary live but skips rows", async () => {
      // Restore the real poll method (the label test stubs it).
      pollSpy.mockRestore();
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
      rec._recordingBuffer = [];
      rec._liveLastId = 0;
      rec._liveSummary = { textContent: "" };
      rec._pausedEntries = [];
      rec._hass = { connection: { sendMessagePromise: jest.fn() } };
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        entries: [{ id: 0, timestamp: 1, level: "INFO", logger: "rec.logger", message: "x" }],
        next_id: 1,
      });
      rec._livePaused = true;

      liveView.pollRecordingEntries(rec);
      await Promise.resolve();

      // Buffer and summary update while paused; no row is rendered.
      expect(rec._recordingBuffer).toHaveLength(1);
      expect(rec._liveSummary.textContent).toContain("1 entry");
      expect(rec._livePreview.appendChild).not.toHaveBeenCalled();

      // Resuming replays the buffered row.
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({ entries: [], next_id: 1 });
      liveView.togglePauseLive(rec);
      expect(rec._livePreview.appendChild).toHaveBeenCalledTimes(1);
    });
  });

  describe("live grouping toggle", () => {
    const buffer = () => [
      { id: 0, timestamp: 1700000000, logger: "a.logger", level: "ERROR", message: "boom", source: "m.py" },
      { id: 1, timestamp: 1700000005, logger: "a.logger", level: "ERROR", message: "boom", source: "m.py" },
    ];

    test("disabling grouping renders flat rows on rebuild", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._liveLoggerFilter = { value: "" };
      rec._recordingBuffer = buffer();
      rec._liveDedupOverride = false;
      liveView.rebuildLivePreview(rec);
      expect(rec._livePreview.querySelectorAll(".log-preview-line").length).toBe(2);
      expect(rec._livePreview.querySelector(".log-preview-group")).toBeNull();

      rec._liveDedupOverride = true;
      liveView.rebuildLivePreview(rec);
      expect(rec._livePreview.querySelectorAll(".log-preview-group").length).toBe(1);
    });

    test("results view honours the grouping toggle", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._liveLoggerFilter = { value: "" };
      rec._recordingBuffer = buffer();
      rec._liveDedupOverride = false;
      results.rebuildResultsPreview(rec);
      expect(rec._livePreview.querySelectorAll(".log-preview-line").length).toBe(2);
      expect(rec._livePreview.querySelector(".log-preview-group")).toBeNull();

      rec._liveDedupOverride = true;
      results.rebuildResultsPreview(rec);
      expect(rec._livePreview.querySelectorAll(".log-preview-group").length).toBe(1);
    });

    test("group row shows a single count plus the first entry id", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._liveLoggerFilter = { value: "" };
      rec._recordingBuffer = buffer();
      liveView.appendLiveEntries(rec, rec._recordingBuffer);

      const group = rec._livePreview.querySelector(".log-preview-group");
      expect(group.querySelectorAll(".dedup-count").length).toBe(1);
      expect(group.querySelector(".dedup-count").textContent).toBe("×2");
      expect(group.querySelector(".dedup-first-id").textContent).toBe("#1");

      group.querySelector(".dedup-toggle").click();
      const items = group.nextElementSibling.querySelectorAll(".log-preview-group-item");
      expect(items.length).toBe(2);
      expect(items[0].style.marginLeft).toBe("24px");
    });
  });

  describe("numeric-severity level filtering (REQ-CARD-089)", () => {
    test("filters custom numeric levels by number", () => {
      const card = document.createElement("log-manager-card");
      // A custom level above WARNING (30) but with no name mapping.
      const entry = { logger: "a.logger", level: "CUSTOM", levelno: 35 };
      expect(liveView.entryMatchesFilter(card, entry, "WARNING", "")).toBe(true);
      expect(liveView.entryMatchesFilter(card, entry, "ERROR", "")).toBe(false);
    });

    test("falls back to the level name when levelno is absent", () => {
      const card = document.createElement("log-manager-card");
      expect(liveView.entryMatchesFilter(card, { logger: "a.logger", level: "INFO" }, "WARNING", "")).toBe(false);
      expect(liveView.entryMatchesFilter(card, { logger: "a.logger", level: "ERROR" }, "WARNING", "")).toBe(true);
    });

    test("ALL applies no floor", () => {
      const card = document.createElement("log-manager-card");
      expect(liveView.entryMatchesFilter(card, { logger: "a.logger", level: "DEBUG", levelno: 10 }, "ALL", "")).toBe(true);
    });
  });
});
