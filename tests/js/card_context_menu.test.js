import { jest } from "@jest/globals";
import { setupCard, contextMenu, selection } from "./setup.js";

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
  });
});
