import { jest } from "@jest/globals";
import { setupCard, selection, liveView, results } from "./setup.js";

// Module-direct tests for card-selection.js. The element supplies the state
// (selection set, anchor row, preview container); the concern functions own the
// behaviour and are called directly.

beforeAll(async () => {
  await setupCard();
});

describe("card-selection", () => {
  describe("explicit row selection", () => {
    const mkBuf = () => [
      { id: 0, timestamp: 1700000000, logger: "a.logger", level: "ERROR", message: "one", source: "m.py" },
      { id: 1, timestamp: 1700000001, logger: "a.logger", level: "INFO", message: "two", source: "m.py" },
      { id: 2, timestamp: 1700000002, logger: "a.logger", level: "WARNING", message: "three", source: "m.py" },
    ];
    let rec;
    let container;
    const rows = () => Array.from(container.querySelectorAll(".log-preview-line"));

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      container = document.createElement("div");
      document.body.appendChild(container);
      rec._livePreview = container;
      rec._liveLevelFilter = { value: "ALL" };
      rec._loggerFilterSelected = new Set();
      rec._recordingBuffer = mkBuf();
      // Flat rows keep the row order deterministic for range checks.
      rec._liveDedupOverride = false;
      rec._liveSavePlainBtn = { disabled: false, title: "" };
      rec._liveSaveJsonlBtn = { disabled: false, title: "" };
      rec._liveCopyBtn = { disabled: false, title: "", textContent: "Copy" };
      liveView.rebuildLivePreview(rec);
    });

    afterEach(() => {
      container.remove();
    });

    test("plain click selects one row", () => {
      selection.handleSelectionClick(rec, container, rows()[0], {});
      expect(rows()[0].classList.contains("selected")).toBe(true);
      expect(rows()[1].classList.contains("selected")).toBe(false);
    });

    test("a plain re-click on the sole selected row clears the selection", () => {
      selection.handleSelectionClick(rec, container, rows()[0], {});
      expect(rows()[0].classList.contains("selected")).toBe(true);

      selection.handleSelectionClick(rec, container, rows()[0], {});
      expect(rows()[0].classList.contains("selected")).toBe(false);
      expect(rec._selectedKeys.size).toBe(0);
    });

    test("ctrl-click adds and removes rows", () => {
      selection.handleSelectionClick(rec, container, rows()[0], {});
      selection.handleSelectionClick(rec, container, rows()[1], { ctrlKey: true });
      expect(rows()[0].classList.contains("selected")).toBe(true);
      expect(rows()[1].classList.contains("selected")).toBe(true);
      selection.handleSelectionClick(rec, container, rows()[1], { ctrlKey: true });
      expect(rows()[1].classList.contains("selected")).toBe(false);
    });

    test("shift-click selects a range", () => {
      selection.handleSelectionClick(rec, container, rows()[0], {});
      selection.handleSelectionClick(rec, container, rows()[2], { shiftKey: true });
      expect(rows().every(r => r.classList.contains("selected"))).toBe(true);
    });

    test("press-and-drag extends the selection and suppresses native selection", () => {
      const preventDefault = jest.fn();
      selection.onSelectionMouseDown(rec, container, { button: 0, target: rows()[0], preventDefault });
      expect(preventDefault).toHaveBeenCalled();
      rows()[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      expect(rows().every(r => r.classList.contains("selected"))).toBe(true);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    test("selection survives a rebuild", () => {
      selection.handleSelectionClick(rec, container, rows()[0], {});
      liveView.rebuildLivePreview(rec);
      const selected = Array.from(container.querySelectorAll(".log-preview-line"))
        .filter(el => el.classList.contains("selected"));
      expect(selected.length).toBe(1);
      expect(selected[0].dataset.id).toBe("0");
    });

    test("copying uses the selection when one exists", async () => {
      navigator.clipboard = { writeText: jest.fn(() => Promise.resolve()) };
      try {
        selection.handleSelectionClick(rec, container, rows()[1], {});
        results.copyLogsToClipboard(rec);
        await Promise.resolve();
        await Promise.resolve();
        const text = navigator.clipboard.writeText.mock.calls[0][0];
        expect(text).toContain("two");
        expect(text).not.toContain("one");
      } finally {
        navigator.clipboard = undefined;
      }
    });
  });

  describe("dialog controls do not clear the selection (item 7)", () => {
    const buildDialogCard = () => {
      const rec = document.createElement("log-manager-card");
      const dialog = document.createElement("div");
      dialog.id = "recording-live-dialog";
      const topBar = document.createElement("div");
      topBar.id = "live-top-bar";
      const pause = document.createElement("button");
      topBar.appendChild(pause);
      const dedupRow = document.createElement("label");
      dedupRow.className = "dedup-row";
      const toggle = document.createElement("input");
      dedupRow.appendChild(toggle);
      const preview = document.createElement("div");
      preview.className = "log-preview";
      dialog.append(topBar, dedupRow, preview);
      rec._recordingLiveDialog = dialog;
      rec._livePreview = preview;
      rec._liveBtn = document.createElement("button");
      rec._liveCloseBtn = document.createElement("button");
      rec._livePauseBtn = document.createElement("button");
      rec._liveLevelFilter = document.createElement("select");
      rec._loggerFilterOpen = false;
      rec._selectedKeys = new Set(["k1"]);
      rec._hass = { states: {}, connection: { sendMessagePromise: jest.fn() } };
      return { rec, dialog, pause, toggle };
    };

    test("clicking Pause or the grouping toggle leaves the selection intact", () => {
      const { rec, pause, toggle } = buildDialogCard();
      liveView.attachLiveView(rec);

      pause.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(rec._selectedKeys.size).toBe(1);

      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(rec._selectedKeys.size).toBe(1);
    });

    test("clicking the dialog body still clears the selection", () => {
      const { rec, dialog } = buildDialogCard();
      liveView.attachLiveView(rec);

      // A plain area of the dialog that is not a control or the table.
      const body = document.createElement("div");
      dialog.appendChild(body);
      body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(rec._selectedKeys.size).toBe(0);
    });
  });
});
