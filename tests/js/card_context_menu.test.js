import { jest } from "@jest/globals";
import { setupCard, contextMenu, selection, loggers } from "./setup.js";

// Module-direct tests for card-context-menu.js. The element supplies counters,
// selection state and the menu container; the concern functions own behaviour.

beforeAll(async () => {
  await setupCard();
});

describe("card-context-menu", () => {
  describe("panel copy selection", () => {
    let rec;
    const makeRow = () => {
      const row = document.createElement("div");
      row.innerHTML = `
        <button class="copy-panel-btn" data-logger="t.logger">Copy</button>
        <div class="log-entries">
          <div class="log-entry" data-entry-index="0">first</div>
          <div class="log-entry" data-entry-index="1">second</div>
        </div>`;
      return row;
    };

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      rec._counters = {
        "t.logger": {
          recent_logs: [
            { timestamp: 0, level: "INFO", logger: "t.logger", message: "first", source: "" },
            { timestamp: 1, level: "ERROR", logger: "t.logger", message: "second", source: "" },
          ],
        },
      };
      navigator.clipboard = { writeText: jest.fn(() => Promise.resolve()) };
    });

    afterEach(() => {
      navigator.clipboard = undefined;
    });

    test("copies all captured entries when nothing is selected", async () => {
      const row = makeRow();
      contextMenu.attachCopyPanelHandler(rec, row);
      row.querySelector(".copy-panel-btn").click();
      await Promise.resolve();
      await Promise.resolve();
      const text = navigator.clipboard.writeText.mock.calls[0][0];
      expect(text).toContain("first");
      expect(text).toContain("second");
    });

    test("copies only the selected entries when a selection exists", async () => {
      const row = makeRow();
      const entry = rec._counters["t.logger"].recent_logs[1];
      rec._selectedKeys = new Set([selection.entryKey(rec, entry)]);
      contextMenu.attachCopyPanelHandler(rec, row);
      row.querySelector(".copy-panel-btn").click();
      await Promise.resolve();
      await Promise.resolve();
      const text = navigator.clipboard.writeText.mock.calls[0][0];
      expect(text).toContain("second");
      expect(text).not.toContain("first");
    });
  });

  describe("context menu", () => {
    let rec;

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      rec._contextMenu = document.createElement("div");
      rec._hass = { states: {}, callService: jest.fn() };
    });

    test("builds a button per item and honours disabled items", () => {
      contextMenu.showContextMenu(rec, [
        { label: "Copy", action: jest.fn() },
        { label: "Nope", disabled: true, action: jest.fn() },
      ], 10, 10);

      const buttons = rec._contextMenu.querySelectorAll("button");
      expect(buttons.length).toBe(2);
      expect(buttons[1].disabled).toBe(true);
      expect(rec._contextMenu.style.display).toBe("block");
    });

    test("clicking an item runs its action and hides the menu", () => {
      const action = jest.fn();
      contextMenu.showContextMenu(rec, [{ label: "Do", action }], 10, 10);
      rec._contextMenu.querySelector("button").click();
      expect(action).toHaveBeenCalled();
      expect(rec._contextMenu.style.display).toBe("none");
    });

    test("skips the menu over text inputs so cut/copy/paste stays native", () => {
      const input = document.createElement("input");
      const preventDefault = jest.fn();
      contextMenu.handleListContextMenu(rec, { target: input, clientX: 0, clientY: 0, preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(rec._contextMenu.children.length).toBe(0);
    });

    test("logger rows offer copy and management actions", () => {
      const row = document.createElement("div");
      row.className = "log-row";
      row.dataset.loggerName = "t.logger";
      const name = document.createElement("div");
      name.className = "log-name";
      row.appendChild(name);
      const edit = document.createElement("button");
      edit.className = "edit-btn";
      row.appendChild(edit);
      const remove = document.createElement("button");
      remove.className = "remove-btn";
      row.appendChild(remove);

      contextMenu.handleListContextMenu(rec, { target: name, clientX: 0, clientY: 0, preventDefault: jest.fn() });

      const labels = Array.from(rec._contextMenu.querySelectorAll("button")).map(b => b.textContent);
      expect(labels).toContain("Copy logger path");
      expect(labels).toContain("Copy friendly name");
      expect(labels).toContain("Edit logger");
      expect(labels).toContain("Remove logger");
    });

    test("entry rows offer entry copy actions", () => {
      const entry = { timestamp: 1, level: "INFO", logger: "t.logger", message: "hi", source: "" };
      const row = document.createElement("div");
      row.className = "log-row";
      row.dataset.loggerName = "t.logger";
      const panel = document.createElement("div");
      const el = document.createElement("div");
      el.className = "selectable-entry";
      el.dataset.selKeys = JSON.stringify([selection.entryKey(rec, entry)]);
      panel.appendChild(el);
      row.appendChild(panel);
      rec._counters = { "t.logger": { warning: 0, error: 0, recent_logs: [entry], levels: {} } };

      contextMenu.handleListContextMenu(rec, { target: el, clientX: 0, clientY: 0, preventDefault: jest.fn() });

      const labels = Array.from(rec._contextMenu.querySelectorAll("button")).map(b => b.textContent);
      expect(labels).toContain("Copy entry");
      expect(labels).toContain("Copy all captured entries");
    });

    test("checklist rows offer the logger path", () => {
      const item = document.createElement("label");
      item.className = "checklist-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.logger = "t.logger";
      item.appendChild(cb);

      contextMenu.handleChecklistContextMenu(rec, { target: item, clientX: 0, clientY: 0, preventDefault: jest.fn() });

      const labels = Array.from(rec._contextMenu.querySelectorAll("button")).map(b => b.textContent);
      expect(labels).toContain("Copy logger path");
    });

    test("the results summary offers a themed Copy summary", () => {
      const rec = document.createElement("log-manager-card");
      rec._contextMenu = document.createElement("div");
      rec._hass = { states: {}, callService: jest.fn() };
      const summary = document.createElement("div");
      summary.id = "results-summary";
      summary.textContent = "ERROR 2 · a.logger ×3";
      const items = contextMenu.summaryMenuItems(rec, summary);
      expect(items.map(i => i.label)).toEqual(["Copy summary"]);
      expect(items[0].disabled).toBe(false);
      // The action copies the element's own text.
      const originalClipboard = navigator.clipboard;
      navigator.clipboard = { writeText: jest.fn(() => Promise.resolve()) };
      try {
        items[0].action();
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ERROR 2 · a.logger ×3");
      } finally {
        navigator.clipboard = originalClipboard;
      }
    });

    test("a failed copy surfaces a visible fallback", async () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = { states: {}, callService: jest.fn() };
      const fallbackSpy = jest.spyOn(loggers, "showDeleteConfirm").mockImplementation(() => {});
      navigator.clipboard = { writeText: jest.fn(() => Promise.reject(new Error("nope"))) };
      try {
        contextMenu.copyTextWithFallback(rec, "text");
        await Promise.resolve();
        await Promise.resolve();
        expect(fallbackSpy).toHaveBeenCalled();
      } finally {
        navigator.clipboard = undefined;
        fallbackSpy.mockRestore();
      }
    });

    test("group headers get their own themed menu", () => {
      const rec = document.createElement("log-manager-card");
      rec._contextMenu = document.createElement("div");
      rec._hass = { states: {}, callService: jest.fn() };
      rec._activeList = document.createElement("div");
      const header = document.createElement("div");
      header.className = "log-group-header";
      header.dataset.group = "custom_components";
      rec._activeList.appendChild(header);
      const preventDefault = jest.fn();

      contextMenu.handleListContextMenu(rec, {
        target: header, clientX: 0, clientY: 0, preventDefault,
      });

      expect(preventDefault).toHaveBeenCalled();
      const labels = Array.from(rec._contextMenu.querySelectorAll("button")).map(b => b.textContent);
      expect(labels).toContain("Copy path prefix");
      expect(labels).toContain("Collapse or expand section");
    });
  });

  describe("live dialog context menu (item 5)", () => {
    const build = () => {
      const rec = document.createElement("log-manager-card");
      rec._contextMenu = document.createElement("div");
      rec._hass = { states: {}, callService: jest.fn() };
      rec._recordingBuffer = [];
      const dialog = document.createElement("div");
      dialog.id = "recording-live-dialog";
      const input = document.createElement("input");
      const plain = document.createElement("div");
      plain.textContent = "plain";
      const preview = document.createElement("div");
      preview.className = "log-preview";
      const summary = document.createElement("div");
      summary.id = "results-summary";
      summary.textContent = "ERROR 2 · a.logger ×3";
      dialog.append(input, plain, preview, summary);
      rec._recordingLiveDialog = dialog;
      rec._livePreview = preview;
      rec._activeList = document.createElement("div");
      rec._loggerChecklist = document.createElement("div");
      rec._historyTableBody = document.createElement("div");
      contextMenu.attachContextMenu(rec);
      return { rec, input, plain, preview, summary };
    };

    test("keeps the native menu on text-entry controls", () => {
      const { input } = build();
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });

    test("suppresses the native menu elsewhere in the dialog with no themed menu", () => {
      const { rec, plain } = build();
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      plain.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(rec._contextMenu.style.display).not.toBe("block");
    });

    test("the entry table keeps its themed preview menu", () => {
      const { rec, preview } = build();
      preview.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      const labels = Array.from(rec._contextMenu.querySelectorAll("button")).map(b => b.textContent);
      expect(labels.some(l => l.includes("Save as .log"))).toBe(true);
    });

    test("the results summary offers a themed Copy summary", () => {
      const { rec, summary } = build();
      summary.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      const labels = Array.from(rec._contextMenu.querySelectorAll("button")).map(b => b.textContent);
      expect(labels).toContain("Copy summary");
      expect(labels).not.toContain("Select all");
    });
  });
});
