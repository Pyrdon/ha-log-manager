import { jest } from "@jest/globals";
import { setupCard, results, liveView, selection } from "./setup.js";

let cardInstance;

beforeAll(async () => {
  await setupCard();
  cardInstance = document.createElement("log-manager-card");
});

describe("LogManagerCard", () => {
  describe("results summary", () => {
    const ts = 1700000000;
    const mk = (id, dt, logger, level = "ERROR", message = "boom", source = "mod.py") => ({
      id,
      timestamp: ts + dt,
      logger,
      level,
      message,
      source,
    });
    const buf = () => [
      mk(0, 0, "a.logger", "ERROR", "boom"),
      mk(1, 5, "a.logger", "ERROR", "boom"),
      mk(2, 6, "a.logger", "WARNING", "careful"),
      mk(3, 7, "b.logger", "INFO", "hello"),
    ];

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
    };

    let rafSpy;
    beforeEach(() => {
      delete cardInstance.config;
      const wrap = document.createElement("div");
      cardInstance._livePreview = document.createElement("div");
      wrap.appendChild(cardInstance._livePreview);
      document.body.appendChild(wrap);
      cardInstance._liveLevelFilter = { value: "ALL" };
      cardInstance._liveLoggerFilter = { value: "" };
      cardInstance._recordingBuffer = [];
      cardInstance._liveLastGroup = null;
      cardInstance._liveLastSingle = null;
      cardInstance._expandedDedupKeys = new Set();
      cardInstance._resultsShown = false;
      stubResultsChrome();
      rafSpy = jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        cb();
        return 0;
      });
    });

    afterEach(() => {
      rafSpy.mockRestore();
      delete cardInstance.config;
      cardInstance._livePreview.parentElement.remove();
    });

    test("copy button ignores selections that are not in the recording buffer", () => {
      cardInstance._recordingBuffer = buf();
      const inBuffer = selection.entryKey(cardInstance, cardInstance._recordingBuffer[0]);
      cardInstance._selectedKeys = new Set([inBuffer, "panel-entry-not-in-buffer"]);
      results.updateExportButtonState(cardInstance);
      expect(cardInstance._liveCopyBtn.title).toBe("Copy 1 selected entry to clipboard");

      cardInstance._selectedKeys = new Set(["panel-entry-not-in-buffer"]);
      results.updateExportButtonState(cardInstance);
      expect(cardInstance._liveCopyBtn.title).toContain("Copy all recorded entries");
    });

    test("export labels name the dynamic scope and the save format", () => {
      cardInstance._recordingBuffer = buf();
      cardInstance._selectedKeys = new Set();
      results.updateExportButtonState(cardInstance);
      expect(cardInstance._liveCopyBtn.textContent).toBe("Copy all");
      expect(cardInstance._liveSavePlainBtn.textContent).toBe("Save all as .log");
      expect(cardInstance._liveSaveJsonlBtn.textContent).toBe("Save all as JSONL");

      const keys = cardInstance._recordingBuffer
        .slice(0, 2)
        .map(entry => selection.entryKey(cardInstance, entry));
      cardInstance._selectedKeys = new Set(keys);
      results.updateExportButtonState(cardInstance);
      expect(cardInstance._liveCopyBtn.textContent).toBe("Copy 2 selected");
      expect(cardInstance._liveSavePlainBtn.textContent).toBe("Save 2 selected as .log");
      expect(cardInstance._liveSaveJsonlBtn.textContent).toBe("Save 2 selected as JSONL");
    });

    test("_summarizeResults totals severity, loggers, and repeats", () => {
      const summary = results.summarizeResults(cardInstance, buf());
      expect(summary.total).toBe(4);
      expect(summary.severity).toEqual([
        { level: "INFO", count: 1 },
        { level: "WARNING", count: 1 },
        { level: "ERROR", count: 2 },
      ]);
      expect(summary.loggers.top).toEqual([
        { label: "a.logger", logger: "a.logger", count: 3, sortKey: "a.logger" },
        { label: "b.logger", logger: "b.logger", count: 1, sortKey: "b.logger" },
      ]);
      expect(summary.loggers.more).toBe(0);
      expect(summary.repeats.top[0].count).toBe(2);
      expect(summary.repeats.top[0].message).toBe("boom");
    });

    test("_summarizeResults caps lists at five with overflow notes", () => {
      const logs = [];
      for (let i = 0; i < 7; i++) {
        logs.push(mk(i, i, `l${i}.mod`, "ERROR", `msg${i}`));
      }
      const summary = results.summarizeResults(cardInstance, logs);
      expect(summary.loggers.top).toHaveLength(5);
      expect(summary.loggers.more).toBe(2);
      expect(summary.repeats.top).toHaveLength(5);
      expect(summary.repeats.more).toBe(2);
    });

    test("results show a read-only summary block below the table", () => {
      cardInstance._recordingBuffer = buf();
      cardInstance._recordingLogCount = 4;
      results.showRecordingResults(cardInstance);
      const block = cardInstance._livePreview.parentElement.querySelector("#results-summary");
      expect(block.style.display).not.toBe("none");
      expect(block.textContent).toContain("a.logger");
      expect(block.textContent).toContain("ERROR 2");
      // No interactive filter rows: the summary is display-only.
      expect(block.querySelector('[data-filter-type]')).toBeNull();
      expect(block.querySelector(".summary-row")).not.toBeNull();
      // Rendered after the preview, not before it.
      expect(
        cardInstance._livePreview.compareDocumentPosition(block) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    test("summary rows are not clickable buttons", () => {
      cardInstance._recordingBuffer = buf();
      cardInstance._recordingLogCount = 4;
      results.showRecordingResults(cardInstance);
      const block = cardInstance._livePreview.parentElement.querySelector("#results-summary");
      const row = block.querySelector(".summary-row");
      expect(row.tagName).toBe("DIV");
      expect(row.getAttribute("role")).toBeNull();
      expect(row.onclick).toBeNull();
    });

    test("empty captures show no summary block", () => {
      cardInstance._recordingBuffer = [];
      cardInstance._recordingLogCount = 0;
      results.showRecordingResults(cardInstance);
      const block = cardInstance._livePreview.parentElement.querySelector("#results-summary");
      expect(block === null || block.style.display === "none").toBe(true);
    });

    test("an empty capture shows a single empty-state message", () => {
      cardInstance._recordingBuffer = [];
      cardInstance._recordingLogCount = 0;
      results.showRecordingResults(cardInstance);
      // The summary owns the empty-state message; the table stays blank.
      expect(cardInstance._liveSummary.textContent).toContain("No log events matched");
      expect(cardInstance._livePreview.innerHTML).toBe("");
    });

    test("summary follows the filter on the flat (non-dedup) path", () => {
      cardInstance.config = { type: "custom:log-manager-card", live_dedup: false };
      cardInstance._recordingBuffer = buf();
      cardInstance._recordingLogCount = 4;
      results.showRecordingResults(cardInstance);

      cardInstance._liveLevelFilter.value = "ERROR";
      liveView.applyLiveFilters(cardInstance);

      const block = cardInstance._livePreview.parentElement.querySelector("#results-summary");
      // Only the two ERROR entries from a.logger remain in the summary.
      expect(block.textContent).toContain("ERROR 2");
      expect(block.textContent).not.toContain("INFO 1");
      expect(block.textContent).not.toContain("WARNING 1");
      delete cardInstance.config;
    });

    test("hostile strings are escaped and long messages truncate with full title", () => {
      const long = "x".repeat(100);
      cardInstance._recordingBuffer = [
        { id: 0, timestamp: ts, logger: `a".logger`, level: "ERROR", message: `<b>${long}</b>`, source: "m.py" },
      ];
      cardInstance._recordingLogCount = 1;
      results.showRecordingResults(cardInstance);
      const block = cardInstance._livePreview.parentElement.querySelector("#results-summary");
      const html = block.innerHTML;
      // Quotes are escaped in attributes; angle brackets inside quoted
      // attribute values are literal text, not markup: no <b> ELEMENT parses.
      expect(html).toContain("a&quot;.logger");
      expect(block.querySelector("b")).toBeNull();
      expect(block.textContent).toContain("<b>");
      const row = block.querySelector(".summary-message").closest(".summary-row");
      expect(row.textContent).toContain("…");
      expect(row.title).toContain(`<b>${long}</b>`);
    });

    test("non-standard levels render as plain text", () => {
      cardInstance._recordingBuffer = [
        { id: 0, timestamp: ts, logger: "a.logger", level: "NOTSET", message: "m", source: "" },
      ];
      cardInstance._recordingLogCount = 1;
      results.showRecordingResults(cardInstance);
      const block = cardInstance._livePreview.parentElement.querySelector("#results-summary");
      expect(block.textContent).toContain("NOTSET 1");
      expect(block.querySelector('[data-filter-value="NOTSET"]')).toBeNull();
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
        results.downloadLogs(rec, "plain");
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
        results.downloadLogs(rec, "jsonl");
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
      await results.copyLogsToClipboard(rec);

      const text = navigator.clipboard.writeText.mock.calls[0][0];
      expect(text).toContain("INFO");
      expect(text).toContain("rec.logger");
      expect(text).toContain("hello world");
      expect(rec._liveCopyBtn.textContent).toBe("Copied!");
    });
  });
});
