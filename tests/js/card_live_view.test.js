import { jest } from "@jest/globals";
import { setupCard, cardStylesSource, liveView, results, contextMenu, selection } from "./setup.js";

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
      cardInstance._loggerFilterSelected = new Set();
      cardInstance._loggerFilterNames = new Set();
      cardInstance._loggerFilterRendered = null;
      cardInstance._loggerFilterOpen = false;
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
      cardInstance._loggerFilterSelected = new Set(["a.logger"]);
      // b.logger is listed but explicitly unticked, so reconciliation keeps the
      // filter intent instead of auto-ticking it as newly seen.
      cardInstance._loggerFilterNames = new Set(["a.logger", "b.logger"]);
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

    test("clicking a group's chevron or count badge expands it", () => {
      liveView.appendLiveEntries(cardInstance, [mk(0, 0, "a.logger"), mk(1, 5, "a.logger")]);
      const group = cardInstance._livePreview.querySelector(".log-preview-group");
      const items = group.nextElementSibling;
      // A single click on the chevron button expands; no double-click needed.
      group.querySelector(".dedup-toggle").click();
      expect(items.style.display).toBe("");
      // The count badge toggles too.
      group.querySelector(".dedup-count").click();
      expect(items.style.display).toBe("none");
    });

    test("live_dedup false renders the raw stream", () => {
      cardInstance.config = { type: "custom:log-manager-card", live_dedup: false };
      cardInstance._loggerFilterSelected = new Set(["a.logger"]);
      cardInstance._loggerFilterNames = new Set(["a.logger", "b.logger"]);
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

      cardInstance._loggerFilterSelected = new Set(["a.logger"]);
      cardInstance._loggerFilterNames = new Set(["a.logger", "b.logger"]);
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
        cardInstance._loggerFilterSelected = new Set();
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
        "1 entry \u00B7 1 logger recording \u00B7 1 with entry"
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
        "3 entries \u00B7 3 loggers recording \u00B7 2 with entries"
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
      rec._loggerFilterSelected = new Set();
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
      rec._loggerFilterSelected = new Set();
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
      rec._loggerFilterSelected = new Set();
      rec._recordingBuffer = buffer();
      rec._liveDedupOverride = false;
      results.rebuildResultsPreview(rec);
      expect(rec._livePreview.querySelectorAll(".log-preview-line").length).toBe(2);
      expect(rec._livePreview.querySelector(".log-preview-group")).toBeNull();

      rec._liveDedupOverride = true;
      results.rebuildResultsPreview(rec);
      expect(rec._livePreview.querySelectorAll(".log-preview-group").length).toBe(1);
    });

    test("group row shows a single count plus the id range (item 11)", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._loggerFilterSelected = new Set();
      rec._recordingBuffer = buffer();
      liveView.appendLiveEntries(rec, rec._recordingBuffer);

      const group = rec._livePreview.querySelector(".log-preview-group");
      expect(group.querySelectorAll(".dedup-count").length).toBe(1);
      expect(group.querySelector(".dedup-count").textContent).toBe("×2");
      // ids 0 and 1 render 1-based as the range 1–2.
      expect(group.querySelector(".dedup-first-id").textContent).toBe("1\u20132");

      group.querySelector(".dedup-toggle").click();
      const items = group.nextElementSibling.querySelectorAll(".log-preview-group-item");
      expect(items.length).toBe(2);
      expect(items[0].style.marginLeft).toBe("24px");
    });

    test("a single-entry run shows one id, not a range", () => {
      const rec = document.createElement("log-manager-card");
      const run = { key: "k", logger: "a.logger", level: "INFO", message: "m", source: "", firstId: 4, firstTs: 0, lastTs: 0, count: 1, times: [0], ids: [4] };
      expect(liveView.dedupIdRangeText(run)).toBe("5");
    });

    test("the group heading is not selectable and a single click toggles it (REQ-CARD-093)", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._loggerFilterSelected = new Set();
      rec._recordingBuffer = buffer();
      liveView.appendLiveEntries(rec, rec._recordingBuffer);
      const group = rec._livePreview.querySelector(".log-preview-group");
      const items = group.nextElementSibling;
      expect(group.classList.contains("selectable-entry")).toBe(false);
      expect(items.style.display).toBe("none");

      // A single click anywhere on the heading (not the chevron/badge) toggles.
      group.querySelector(".msg-col").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(items.style.display).toBe("");

      // Occurrences remain individually selectable.
      const firstItem = items.querySelector(".log-preview-group-item");
      expect(firstItem.classList.contains("selectable-entry")).toBe(true);
    });

    test("bumping a group updates the id range in place", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._loggerFilterSelected = new Set();
      rec._selectedKeys = new Set();
      rec._expandedDedupKeys = new Set();
      rec._recordingBuffer = buffer();
      liveView.appendLiveEntries(rec, rec._recordingBuffer);
      const group = rec._livePreview.querySelector(".log-preview-group");
      expect(group.querySelector(".dedup-first-id").textContent).toBe("1\u20132");

      const third = { id: 2, timestamp: 1700000010, logger: "a.logger", level: "ERROR", message: "boom", source: "m.py" };
      rec._recordingBuffer.push(third);
      liveView.appendLiveEntries(rec, [third]);
      expect(group.querySelector(".dedup-first-id").textContent).toBe("1\u20133");
    });

    test("bumping a group updates it in place, appending one child (item 11)", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._loggerFilterSelected = new Set();
      rec._selectedKeys = new Set();
      rec._expandedDedupKeys = new Set();
      rec._recordingBuffer = buffer();
      liveView.appendLiveEntries(rec, rec._recordingBuffer);

      const group = rec._livePreview.querySelector(".log-preview-group");
      const items = group.nextElementSibling;
      const rowIdentity = group;
      const toggleIdentity = group.querySelector(".dedup-toggle");
      // Expand so the new child should be visible too.
      toggleIdentity.click();
      expect(items.querySelectorAll(".log-preview-group-item").length).toBe(2);

      const third = { id: 2, timestamp: 1700000010, logger: "a.logger", level: "ERROR", message: "boom", source: "m.py" };
      rec._recordingBuffer.push(third);
      liveView.appendLiveEntries(rec, [third]);

      // The row identity and its toggle listener are preserved (no innerHTML
      // rebuild), the count grew, and exactly one child was appended.
      expect(rec._livePreview.querySelector(".log-preview-group")).toBe(rowIdentity);
      expect(group.querySelector(".dedup-toggle")).toBe(toggleIdentity);
      expect(group.querySelector(".dedup-count").textContent).toBe("×3");
      expect(items.querySelectorAll(".log-preview-group-item").length).toBe(3);
      // Still expanded (state preserved).
      expect(items.style.display).toBe("");
    });

    test("a selection on grouped occurrences survives the grouping toggle (item 8)", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._loggerFilterSelected = new Set();
      rec._selectedKeys = new Set();
      rec._expandedDedupKeys = new Set();
      rec._recordingBuffer = buffer();
      rec._liveDedupOverride = true;
      liveView.rebuildLivePreview(rec);

      // Expand, then select both occurrences (the heading itself is not
      // selectable).
      const group = rec._livePreview.querySelector(".log-preview-group");
      group.querySelector(".dedup-toggle").click();
      const items = rec._livePreview.querySelectorAll(".log-preview-group-item");
      items.forEach(it => JSON.parse(it.dataset.selKeys).forEach(k => rec._selectedKeys.add(k)));
      selection.refreshSelection(rec, rec._livePreview);
      expect(Array.from(items).every(it => it.classList.contains("selected"))).toBe(true);

      // Toggle grouping off — the selected entries are now flat rows.
      rec._liveDedupOverride = false;
      liveView.rebuildLivePreview(rec);
      expect(rec._livePreview.querySelectorAll(".log-preview-line.selected").length).toBe(2);

      // Toggle back on — the run is grouped and its occurrences still selected.
      rec._liveDedupOverride = true;
      liveView.rebuildLivePreview(rec);
      const items2 = rec._livePreview.querySelectorAll(".log-preview-group-item");
      expect(Array.from(items2).every(it => it.classList.contains("selected"))).toBe(true);
    });

    test("a selection survives pause and resume (item 8)", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._loggerFilterSelected = new Set();
      rec._selectedKeys = new Set();
      rec._expandedDedupKeys = new Set();
      rec._recordingBuffer = buffer();
      liveView.rebuildLivePreview(rec);

      const group = rec._livePreview.querySelector(".log-preview-group");
      group.querySelector(".dedup-toggle").click();
      const items = rec._livePreview.querySelectorAll(".log-preview-group-item");
      items.forEach(it => JSON.parse(it.dataset.selKeys).forEach(k => rec._selectedKeys.add(k)));
      selection.refreshSelection(rec, rec._livePreview);

      // Pausing/resuming replays rows through appendLiveEntries, which must not
      // drop the explicit selection.
      liveView.appendLiveEntries(rec, []);
      const items2 = rec._livePreview.querySelectorAll(".log-preview-group-item");
      expect(Array.from(items2).every(it => it.classList.contains("selected"))).toBe(true);
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

  describe("searchable checkbox multi-select logger filter (REQ-CARD-080)", () => {
    const stubPicker = (card) => {
      card._recordingBuffer = [];
      card._loggerFilterNames = new Set();
      card._loggerFilterSelected = new Set();
      card._loggerFilterRendered = null;
      card._loggerFilterOpen = false;
      card._hass = {
        states: {
          "select.a": { attributes: { logger_name: "a.logger", friendly_name: "A Logger" } },
        },
      };
      card._loggerFilterBtn = document.createElement("button");
      card._loggerFilterPanel = document.createElement("div");
      card._loggerFilterSearch = document.createElement("input");
      card._loggerFilterList = document.createElement("div");
      card._livePreview = document.createElement("div");
      card._liveLevelFilter = { value: "ALL" };
      card._resultsShown = false;
    };

    test("accumulates the emitting loggers from the buffer", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      card._recordingBuffer = [
        { logger: "custom_components.log_manager", level: "INFO" },
        { logger: "custom_components.log_manager.select", level: "INFO" },
        { logger: "custom_components.log_manager", level: "INFO" },
      ];
      liveView.accumulateLoggerFilterNames(card);
      expect(liveView.loggerFilterNames(card)).toEqual([
        "custom_components.log_manager",
        "custom_components.log_manager.select",
      ]);
    });

    test("first open ticks every accumulated logger", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      card._recordingBuffer = [{ logger: "a.logger" }, { logger: "b.logger" }];
      liveView.openLoggerFilter(card);
      expect(card._loggerFilterSelected.has("a.logger")).toBe(true);
      expect(card._loggerFilterSelected.has("b.logger")).toBe(true);
      const boxes = card._loggerFilterList.querySelectorAll("input[type='checkbox']");
      expect(boxes.length).toBe(2);
      expect(Array.from(boxes).every(cb => cb.checked)).toBe(true);
    });

    test("labels a known logger with its friendly name and escapes the value", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      card._recordingBuffer = [{ logger: 'we"ird' }, { logger: "a.logger" }];
      liveView.openLoggerFilter(card);
      const html = card._loggerFilterList.innerHTML;
      expect(html).toContain("A Logger");
      expect(html).toContain("we&quot;ird");
    });

    test("unticking a logger filters its entries out", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      const entry = { logger: "a.logger", level: "ERROR" };
      expect(liveView.entryMatchesFilter(card, entry, "ALL", new Set(["a.logger"]))).toBe(true);
      expect(liveView.entryMatchesFilter(card, entry, "ALL", new Set(["b.logger"]))).toBe(false);
      // An empty set means all loggers are shown.
      expect(liveView.entryMatchesFilter(card, entry, "ALL", new Set())).toBe(true);
    });

    test("a managed root that never logs directly no longer yields an empty list", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      // The managed root is what was selected, but only the child emits.
      card._recordingBuffer = [
        { logger: "custom_components.log_manager.select", level: "INFO" },
      ];
      liveView.openLoggerFilter(card);
      const boxes = card._loggerFilterList.querySelectorAll("input[type='checkbox']");
      expect(boxes.length).toBe(1);
      expect(boxes[0].value).toBe("custom_components.log_manager.select");
      expect(liveView.entryMatchesFilter(card, card._recordingBuffer[0], "ALL", card._loggerFilterSelected)).toBe(true);
    });

    test("while open it repaints only when the accumulated set grew", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      card._recordingBuffer = [{ logger: "a.logger" }];
      liveView.openLoggerFilter(card);
      expect(card._loggerFilterList.querySelectorAll("input").length).toBe(1);

      // No new names: nothing is repainted (same node identity retained).
      const firstInput = card._loggerFilterList.querySelector("input");
      liveView.refreshLoggerFilterIfGrown(card);
      expect(card._loggerFilterList.querySelector("input")).toBe(firstInput);

      // A new name arrives: the list grows.
      card._recordingBuffer.push({ logger: "b.logger" });
      liveView.accumulateLoggerFilterNames(card);
      liveView.refreshLoggerFilterIfGrown(card);
      expect(card._loggerFilterList.querySelectorAll("input").length).toBe(2);
    });

    test("while closed it only accumulates, never rendering", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      card._loggerFilterOpen = false;
      card._recordingBuffer = [{ logger: "a.logger" }, { logger: "b.logger" }];
      liveView.accumulateLoggerFilterNames(card);
      liveView.refreshLoggerFilterIfGrown(card);
      expect(card._loggerFilterList.querySelectorAll("input").length).toBe(0);
      expect(liveView.loggerFilterNames(card).length).toBe(2);
    });

    test("the ticked set is remembered across a close and reopen", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      card._recordingBuffer = [{ logger: "a.logger" }, { logger: "b.logger" }];
      liveView.openLoggerFilter(card);
      // Untick b.logger, then close and reopen.
      card._loggerFilterSelected.delete("b.logger");
      liveView.closeLoggerFilter(card);
      card._recordingBuffer.push({ logger: "c.logger" });
      liveView.accumulateLoggerFilterNames(card);
      liveView.openLoggerFilter(card);
      expect(card._loggerFilterSelected.has("a.logger")).toBe(true);
      expect(card._loggerFilterSelected.has("b.logger")).toBe(false);
      // A logger first seen after close is auto-ticked by accumulation. b.logger
      // was already listed when unticked, so it is never "new" again.
      expect(card._loggerFilterSelected.has("c.logger")).toBe(true);
    });

    test("a first-seen logger is auto-ticked by accumulation", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      card._recordingBuffer = [{ logger: "a.logger" }];
      liveView.accumulateLoggerFilterNames(card);
      expect(card._loggerFilterSelected.has("a.logger")).toBe(true);
    });

    test("the filter button counts ticked listed loggers, not a badge-seeded name", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      card._loggerFilterNames = new Set(["a.logger"]);
      // A badge-seeded logger that never emitted is ticked but not listed.
      card._loggerFilterSelected = new Set(["initial.logger", "a.logger"]);
      liveView.updateLoggerFilterButton(card);
      // The listed subset is fully ticked: "All loggers", not "2 loggers".
      expect(card._loggerFilterBtn.textContent).toBe("All loggers");
    });

    test("search hides non-matching loggers without changing ticked state", () => {
      const card = document.createElement("log-manager-card");
      stubPicker(card);
      card._recordingBuffer = [{ logger: "a.logger" }, { logger: "b.logger" }];
      liveView.openLoggerFilter(card);
      card._loggerFilterSearch.value = "a.logger";
      liveView.renderLoggerFilterCheckboxes(card);
      const items = card._loggerFilterList.querySelectorAll(".logger-filter-item");
      const visible = Array.from(items).filter(el => el.style.display !== "none");
      expect(visible.length).toBe(1);
      expect(visible[0].querySelector("input").value).toBe("a.logger");
      // Both remain ticked; only visibility changed.
      expect(card._loggerFilterSelected.size).toBe(2);
    });
  });

  describe("reopen rebuild and pause styling", () => {
    const stubLiveChrome = (rec) => {
      rec._recordingState = "results"; // pollRecordingEntries no-ops
      rec._recordingBuffer = [];
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._loggerFilterSelected = new Set();
      rec._loggerFilterNames = new Set();
      rec._loggerFilterRendered = null;
      rec._loggerFilterOpen = false;
      rec._liveLastGroup = null;
      rec._liveLastSingle = null;
      rec._expandedDedupKeys = new Set();
      rec._recordingDedupToggle = document.createElement("input");
      rec._liveDialogTitle = { textContent: "" };
      rec._liveStatusText = { parentElement: { style: {} }, textContent: "" };
      rec._livePauseBtn = { style: {}, textContent: "", title: "", classList: { add() {}, remove() {}, toggle() {} } };
      rec._liveStopBtn = { style: {} };
      rec._liveCloseBtn = { style: {}, textContent: "", title: "" };
      rec._liveClearBtn = { style: {} };
      rec._liveDiscardBtn = { style: {} };
      rec._liveTimer = { textContent: "" };
      rec._liveStatusDot = { style: {} };
      rec._liveSummary = { textContent: "" };
      rec._liveSavePlainBtn = { disabled: false, title: "" };
      rec._liveSaveJsonlBtn = { disabled: false, title: "" };
      rec._liveCopyBtn = { disabled: false, title: "", textContent: "" };
      rec._recordingLiveDialog = { style: {}, classList: { add() {}, remove() {} } };
      rec._recordingLoggers = [];
      rec._hass = { states: {}, connection: { sendMessagePromise: jest.fn() } };
    };

    test("reopening the live view rebuilds the preview from the buffer (item 8)", () => {
      const rec = document.createElement("log-manager-card");
      stubLiveChrome(rec);
      rec._recordingBuffer = [
        { id: 0, timestamp: 1700000000, logger: "a.logger", level: "ERROR", message: "boom", source: "m.py" },
        { id: 1, timestamp: 1700000001, logger: "b.logger", level: "INFO", message: "other", source: "m.py" },
      ];
      const rafSpy = jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(); return 0; });
      try {
        liveView.openLiveView(rec);
      } finally {
        liveView.cleanupLivePolling(rec);
        rafSpy.mockRestore();
      }
      // Both captured entries appear immediately on open.
      expect(rec._livePreview.querySelectorAll(".log-preview-line").length).toBe(2);
    });

    test("the pause button is green while running and orange when paused (item 9)", () => {
      expect(cardStylesSource).toMatch(/#live-pause-btn\s*\{[^}]*color:\s*#4caf50/);
      const paused = cardStylesSource.match(/#live-pause-btn\.paused\s*\{([^}]*)\}/);
      expect(paused).not.toBeNull();
      // The paused state is orange, matching the paused status it signals.
      expect(paused[1]).toContain("#ff9800");
    });

    test("the summary and status text are not selectable", () => {
      const rule = cardStylesSource.match(
        /#live-summary,\s*#live-status-text,\s*#results-summary\s*\{([^}]*)\}/
      );
      expect(rule).not.toBeNull();
      expect(rule[1]).toContain("user-select: none");
    });
  });
});
