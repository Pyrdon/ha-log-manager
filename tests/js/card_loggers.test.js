import { jest } from "@jest/globals";
import { setupCard, utils, loggers, addForm } from "./setup.js";

let cardInstance;

beforeAll(async () => {
  await setupCard();
  cardInstance = document.createElement("log-manager-card");
});

describe("LogManagerCard", () => {
  describe("_renderCounterBadgeHtml", () => {
    test("returns empty string when no warnings or errors", () => {
      const result = loggers.renderCounterBadgeHtml(cardInstance, "test.logger");
      expect(result).toBe("");
    });

    test("renders warning badge with count", () => {
      cardInstance._counters = { "test.logger": { warning: 3, error: 0 } };
      const result = loggers.renderCounterBadgeHtml(cardInstance, "test.logger");
      expect(result).toContain("warning-badge");
      expect(result).toContain("3");
      expect(result).not.toContain("error-badge");
    });

    test("renders error badge with count", () => {
      cardInstance._counters = { "test.logger": { warning: 0, error: 2 } };
      const result = loggers.renderCounterBadgeHtml(cardInstance, "test.logger");
      expect(result).toContain("error-badge");
      expect(result).toContain("2");
      expect(result).not.toContain("warning-badge");
    });

    test("renders both badges when both present", () => {
      cardInstance._counters = { "test.logger": { warning: 1, error: 4 } };
      const result = loggers.renderCounterBadgeHtml(cardInstance, "test.logger");
      expect(result).toContain("warning-badge");
      expect(result).toContain("error-badge");
      expect(result).toContain("1");
      expect(result).toContain("4");
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

    test("_buildLoggerTree compresses unary chains and branches at splits", () => {
      const tree = loggers.buildLoggerTree(cardInstance, [
        "homeassistant.core.a",
        "homeassistant.core.b",
        "custom_components.hacs",
      ]);
      expect(tree.map((t) => `${t.kind}:${t.key}`)).toEqual([
        "row:custom_components.hacs",
        "group:homeassistant.core",
        "row:homeassistant.core.a",
        "row:homeassistant.core.b",
      ]);
      expect(tree[1].label).toBe("homeassistant.core");
      expect(tree[1].count).toBe(2);
      expect(tree[0].depth).toBe(0);
      expect(tree[2].depth).toBe(1);
      expect(tree[2].ancestors).toEqual(["homeassistant.core"]);
    });

    test("a single managed logger renders as a flat row with no header", () => {
      cardInstance._hass.states = {
        "select.only": {
          state: "INFO",
          attributes: {
            logger_name: "custom_components.log_manager",
            friendly_name: "Log Manager",
            options: ["INFO"],
          },
        },
      };
      addForm.updateActiveList(cardInstance);
      expect(cardInstance._activeList.querySelector(".log-group-header")).toBeNull();
      expect(cardInstance._activeList.querySelectorAll(".log-row").length).toBe(1);
    });

    test("log_manager alone flattens; adding test makes custom_components branch", () => {
      const attrs = (logger, name) => ({
        state: "INFO",
        attributes: { logger_name: logger, friendly_name: name, options: ["INFO"] },
      });
      cardInstance._hass.states = {
        "select.lm": attrs("custom_components.log_manager", "Log Manager"),
        "select.lm_sel": attrs("custom_components.log_manager.select", "LM Select"),
        "select.lm_num": attrs("custom_components.log_manager.number", "LM Number"),
      };
      addForm.updateActiveList(cardInstance);
      // custom_components is a unary chain: no header; log_manager is the row.
      let headers = Array.from(cardInstance._activeList.querySelectorAll(".log-group-header"));
      expect(headers.map((h) => h.dataset.group)).toEqual([]);
      let order = Array.from(cardInstance._activeList.children).map(
        (el) => el.dataset.entityId || el.dataset.group
      );
      // Children are ordered by path segment: number before select.
      expect(order).toEqual(["select.lm", "select.lm_num", "select.lm_sel"]);

      cardInstance._hass.states["select.test"] = attrs("custom_components.test", "Test");
      addForm.updateActiveList(cardInstance);
      headers = Array.from(cardInstance._activeList.querySelectorAll(".log-group-header"));
      expect(headers.map((h) => h.dataset.group)).toEqual(["custom_components"]);
      order = Array.from(cardInstance._activeList.children).map(
        (el) => el.dataset.entityId || el.dataset.group
      );
      expect(order).toEqual([
        "custom_components",
        "select.lm",
        "select.lm_num",
        "select.lm_sel",
        "select.test",
      ]);
      const lmRow = cardInstance._activeList.querySelector('.log-row[data-entity-id="select.lm"]');
      const selRow = cardInstance._activeList.querySelector('.log-row[data-entity-id="select.lm_sel"]');
      expect(lmRow.style.marginLeft).toBe("12px");
      expect(selRow.style.marginLeft).toBe("24px");
    });

    test("a lone flat namespace renders without a group header", () => {
      const attrs = (logger, name) => ({
        state: "INFO",
        attributes: { logger_name: logger, friendly_name: name, options: ["INFO"] },
      });
      cardInstance._hass.states = {
        "select.lm": attrs("custom_components.log_manager", "Log Manager"),
        "select.py": attrs("custom_components.pyscript", "Pyscript"),
        "select.vs": attrs("custom_components.voice_satellite", "Voice Satellite"),
      };
      addForm.updateActiveList(cardInstance);
      expect(cardInstance._activeList.querySelector(".log-group-header")).toBeNull();
      expect(cardInstance._activeList.querySelectorAll(".log-row").length).toBe(3);
    });

    test("grouped headers show the descendant count", () => {
      addForm.updateActiveList(cardInstance);
      const header = cardInstance._activeList.querySelector(
        '.log-group-header[data-group="homeassistant.core"]'
      );
      expect(header.querySelector(".log-group-count").textContent).toBe("(2)");
      expect(header.querySelector(".log-group-name").textContent).toBe("homeassistant.core");
    });

    test("group_by_prefix false renders a flat list", () => {
      cardInstance.config = { type: "custom:log-manager-card", group_by_prefix: false };
      addForm.updateActiveList(cardInstance);
      expect(cardInstance._activeList.querySelector(".log-group-header")).toBeNull();
      const rows = Array.from(
        cardInstance._activeList.querySelectorAll(":scope > .log-row")
      );
      expect(rows.map((r) => r.dataset.entityId)).toEqual([
        "select.core_a",
        "select.core_b",
        "select.hacs",
      ]);
    });

    test("collapsing a header hides its descendants and persists", () => {
      addForm.updateActiveList(cardInstance);
      const header = cardInstance._activeList.querySelector(
        '.log-group-header[data-group="homeassistant.core"]'
      );
      header.click();
      const child = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.core_a"]'
      );
      expect(child.style.display).toBe("none");
      expect(
        JSON.parse(window.localStorage.getItem("log_manager_collapsed_groups"))
      ).toEqual({ "homeassistant.core": true });

      // A fresh render keeps the same row node but still hides it.
      addForm.updateActiveList(cardInstance);
      const after = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.core_a"]'
      );
      expect(after).toBe(child);
      expect(after.style.display).toBe("none");
    });

    test("removing the last sibling contracts the branch back to a row", () => {
      addForm.updateActiveList(cardInstance);
      delete cardInstance._hass.states["select.core_b"];
      addForm.updateActiveList(cardInstance);
      expect(cardInstance._activeList.querySelector(".log-group-header")).toBeNull();
      const rows = Array.from(cardInstance._activeList.querySelectorAll(".log-row"));
      // Grouped mode orders by path, not friendly name: custom_components first.
      expect(rows.map((r) => r.dataset.entityId)).toEqual([
        "select.hacs",
        "select.core_a",
      ]);
    });

    test("a corrupt collapsed-groups value degrades to all expanded", () => {
      window.localStorage.setItem("log_manager_collapsed_groups", "null");
      addForm.updateActiveList(cardInstance);
      const rows = Array.from(cardInstance._activeList.querySelectorAll(".log-row"));
      expect(rows.length).toBe(3);
      rows.forEach((row) => {
        expect(row.style.display).not.toBe("none");
      });
    });

    test("the in-list edit form stays beneath the logger being edited", () => {
      const attrs = (logger, name) => ({
        state: "INFO",
        attributes: { logger_name: logger, friendly_name: name, options: ["INFO"] },
      });
      cardInstance._hass.states = {
        "select.a": attrs("homeassistant.core.a", "Core A"),
        "select.b": attrs("homeassistant.core.b", "Core B"),
        "select.c": attrs("custom_components.hacs", "HACS"),
      };
      addForm.updateActiveList(cardInstance);

      const wrapper = document.createElement("div");
      wrapper.id = "add-section-wrapper";
      cardInstance._addSectionWrapper = wrapper;
      const rowA = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.a"]'
      );
      cardInstance._editingPath = "homeassistant.core.a";
      // Simulate the edit button moving the form beneath row A.
      cardInstance._activeList.insertBefore(wrapper, rowA.nextSibling);

      // A hass update re-runs the ordered layout.
      addForm.updateActiveList(cardInstance);

      expect(wrapper.parentElement).toBe(cardInstance._activeList);
      expect(wrapper.previousElementSibling).toBe(rowA);
      expect(cardInstance._activeList.lastElementChild).not.toBe(wrapper);
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
      loggers.updateBadgesInPlace(cardInstance, row, "t.logger");

      const updated = row.querySelector(".warning-badge");
      expect(updated).toBe(badge);
      expect(updated.textContent).toContain("5");
    });

    test("removes badge and container when all counts drop to zero", () => {
      cardInstance._counters = { "t.logger": { warning: 0, error: 0 } };
      loggers.updateBadgesInPlace(cardInstance, row, "t.logger");

      expect(row.querySelector(".warning-badge")).toBeNull();
      expect(row.querySelector(".counter-badges")).toBeNull();
    });

    test("creates an error badge when only errors are present", () => {
      cardInstance._counters = { "t.logger": { warning: 0, error: 3 } };
      loggers.updateBadgesInPlace(cardInstance, row, "t.logger");

      const badge = row.querySelector(".error-badge");
      expect(badge).not.toBeNull();
      expect(badge.textContent).toContain("3");
    });

    test("updates badge text via textContent, not HTML entities", () => {
      cardInstance._counters = { "t.logger": { warning: 7, error: 0 } };
      loggers.updateBadgesInPlace(cardInstance, row, "t.logger");

      const badge = row.querySelector(".warning-badge");
      expect(badge.textContent).toBe("\u26A0 7");
      expect(badge.textContent).not.toContain("&#9888;");
    });
  });

  describe("counting panel", () => {
    beforeEach(() => {
      cardInstance._hass = {
        states: {
          "select.test": {
            state: "WARNING",
            attributes: {
              logger_name: "t.logger",
              effective_level: "WARNING",
            },
          },
        },
        callService: jest.fn(),
      };
      cardInstance._counters = {
        "t.logger": {
          warning: 2,
          error: 1,
          recent_logs: [
            {
              timestamp: 1700000000,
              level: "WARNING",
              logger: "t.logger",
              message: "some warning",
              source: "",
            },
            {
              timestamp: 1700000001,
              level: "ERROR",
              logger: "t.logger",
              message: "some error",
              source: "",
            },
          ],
          levels: { WARNING: 1, ERROR: 1 },
        },
      };
    });

    test("offers no counting-level control or per-severity line", () => {
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).not.toContain("count-level-select");
      expect(html).not.toContain("severity-line");
    });

    test("disclaimer states counting is WARNING and above", () => {
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).toContain("WARNING and above");
    });

    test("renders the captured WARNING+ entries", () => {
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).toContain("log-level-warning");
      expect(html).toContain(">W</span>");
      expect(html).toContain("log-level-error");
      expect(html).toContain(">E</span>");
      expect(html).toContain("some warning");
      expect(html).toContain("some error");
    });

    test("no suppression tooltip while the logger's level is WARNING", () => {
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).not.toContain("discarded before the counters");
    });

    test("explains in the disclaimer tooltip when the logger is above WARNING", () => {
      cardInstance._hass.states["select.test"].attributes.effective_level = "ERROR";

      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).toContain("discards these events before the counter handler runs");
      expect(html).toContain("ERROR");
      expect(html).toContain("WARNING and above");
    });

    test("per-logger controls share one row without a counting control", () => {
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).toContain('class="panel-controls-row"');
      const controls = html.slice(html.indexOf("panel-controls-row"));
      expect(controls).not.toContain("count-level-select");
      expect(controls).not.toContain("sensor-enabled-toggle");
      expect(controls).toContain("alert-threshold-input");
      expect(controls).toContain("history-btn");
    });

    test("shows a discoverable multi-select hint", () => {
      expect(loggers.renderLogPanelHtml(cardInstance, "t.logger")).toContain("Ctrl/Cmd-click or drag");
    });

    test("reset action names the captured entries as well as the counts", () => {
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).toContain('class="reset-btn"');
      expect(html).toContain("Clear");
      expect(html).toContain("re-arms its alert");
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
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).toContain('class="alert-level-select"');
      expect(html).toContain('<option value="WARNING" style="color: #ff9800;" selected>WARNING</option>');
      expect(html).toContain('class="alert-threshold-input"');
      expect(html).toContain('value="5"');
    });

    test("defaults to DISABLED and hides the threshold without entity data", () => {
      cardInstance._hass = { states: {}, callService: jest.fn() };
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).toContain('<option value="DISABLED" style="color: var(--secondary-text-color);" selected>DISABLED</option>');
      expect(html).toContain('class="alert-threshold-input"');
      expect(html).toContain('style="display: none;"');
    });

    test("changing either control calls set_alert_threshold with both values", () => {
      const row = document.createElement("div");
      row.innerHTML = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      loggers.attachAlertHandler(cardInstance, row);

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

    test("committing the threshold with Enter calls set_alert_threshold", () => {
      const row = document.createElement("div");
      row.innerHTML = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      loggers.attachAlertHandler(cardInstance, row);

      const sel = row.querySelector(".alert-level-select");
      const num = row.querySelector(".alert-threshold-input");
      num.value = "9";
      sel.value = "ERROR";
      num.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(cardInstance._hass.callService).toHaveBeenCalledWith(
        "log_manager",
        "set_alert_threshold",
        { logger_name: "t.logger", events: 9, level: "ERROR" }
      );
    });

    test("a zero threshold renders DISABLED with the threshold hidden", () => {
      cardInstance._hass.states["select.test"].attributes.alert_threshold = 0;
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).toContain('value="DISABLED" style="color: var(--secondary-text-color);" selected');
      expect(html).toContain('class="alert-threshold-input"');
      expect(html).toContain('style="display: none;"');
    });

    test("a set threshold renders its severity selected and the input visible", () => {
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).toContain('value="WARNING" style="color: #ff9800;" selected');
      expect(html).not.toContain('style="display: none;"');
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

    test("renders a multi-line history with source labels and levels", () => {
      const title = loggers.auditTitle(cardInstance, "t.logger");
      expect(title).toContain("NOTSET \u2192 INFO by UI");
      expect(title).toContain("INFO \u2192 DEBUG by UI");
      expect(title.split("\n").length).toBe(2);
    });

    test("omits the history when there are no entries", () => {
      cardInstance._hass.states["select.test"].attributes.audit = [];
      expect(loggers.auditTitle(cardInstance, "t.logger")).toBe("");
    });

    test("shows at most three entries", () => {
      cardInstance._hass.states["select.test"].attributes.audit = [
        { ts: 1, source: "ui", old_level: "A", new_level: "B" },
        { ts: 2, source: "ui", old_level: "B", new_level: "C" },
        { ts: 3, source: "ui", old_level: "C", new_level: "D" },
        { ts: 4, source: "ui", old_level: "D", new_level: "E" },
      ];
      const title = loggers.auditTitle(cardInstance, "t.logger");
      expect(title).toContain("A \u2192 B");
      expect(title).not.toContain("D \u2192 E");
      expect(title.split("\n").length).toBe(3);
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
              core_pinned: true,
              options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
            },
          },
          "select.free": {
            state: "INFO",
            attributes: {
              logger_name: "f.logger",
              friendly_name: "Free",
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
      addForm.updateActiveList(cardInstance);
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
      addForm.updateActiveList(cardInstance);
      const row = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.free"]'
      );
      expect(row.querySelector(".level-select").disabled).toBe(false);
      expect(row.querySelector(".pinned-tag")).toBeNull();
    });

    test("flipping the pin updates the row in place without rebuilding it", () => {
      cardInstance._expandedLogger = null;
      addForm.updateActiveList(cardInstance);
      const before = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.free"]'
      );
      expect(before.querySelector(".pinned-tag")).toBeNull();

      cardInstance._hass.states["select.free"].attributes.core_pinned = true;
      addForm.updateActiveList(cardInstance);

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
      addForm.updateActiveList(cardInstance);
      const row = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.inherit"]'
      );
      const chip = row.querySelector(".effective-line");
      expect(chip).not.toBeNull();
      expect(chip.textContent).toContain("Effective:");
      expect(chip.textContent).toContain("DEBUG");
      expect(chip.title).toContain("i.parent");
      // Tinted by the effective level, with a dashed border marking inheritance.
      expect(row.style.borderStyle).toBe("dashed");
      expect(row.style.background).toBe(utils.levelColors("DEBUG").rowBg);
    });

    test("explicit-level rows show no chip", () => {
      cardInstance._expandedLogger = null;
      addForm.updateActiveList(cardInstance);
      const row = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.explicit"]'
      );
      expect(row.querySelector(".effective-line")).toBeNull();
    });

    test("changing the effective level updates the chip in place", () => {
      cardInstance._expandedLogger = null;
      addForm.updateActiveList(cardInstance);
      const before = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.inherit"]'
      );
      expect(before.querySelector(".effective-line").textContent).toContain("DEBUG");

      cardInstance._hass.states["select.inherit"].attributes.effective_level = "INFO";
      addForm.updateActiveList(cardInstance);

      const after = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.inherit"]'
      );
      expect(after).toBe(before);
      const chip = after.querySelector(".effective-line");
      expect(chip.textContent).toContain("INFO");
      // The container colour follows the effective level (jsdom normalises hex).
      const probe = document.createElement("span");
      probe.style.color = utils.levelColors("INFO").color;
      expect(chip.style.color).toBe(probe.style.color);
    });
  });

  describe("_loggerCellHtml", () => {
    test("shows the managed friendly name with the child suffix", () => {
      cardInstance._recordingLoggers = [];
      cardInstance._hass = {
        states: {
          "select.lm": {
            attributes: {
              logger_name: "custom_components.log_manager",
              friendly_name: "Log Manager",
            },
          },
        },
      };
      const html = loggers.loggerCellHtml(cardInstance, "custom_components.log_manager.recording");
      expect(html).toContain("Log Manager");
      expect(html).toContain("recording");
      expect(html).toContain("logger-child");
    });

    test("falls back to the raw path when no managed root matches", () => {
      cardInstance._recordingLoggers = [];
      cardInstance._hass = { states: {} };
      expect(loggers.loggerCellHtml(cardInstance, "orphan.logger")).toBe("orphan.logger");
    });
  });

  describe("level-change history dialog", () => {
    let rec;
    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.t": {
            state: "INFO",
            attributes: {
              logger_name: "t.logger",
              audit: [
                { ts: 1700000000, source: "ui", old_level: "NOTSET", new_level: "INFO" },
                { ts: 1699999900, source: "core", old_level: "INFO", new_level: "DEBUG" },
              ],
            },
          },
        },
      };
      rec._historyDialog = { style: {}, classList: { add: jest.fn() } };
      rec._historyLoggerName = { textContent: "" };
      rec._historyTableBody = { innerHTML: "" };
    });

    test("rows list when, source, from, and to", () => {
      const html = loggers.historyRowsHtml(rec, "t.logger");
      expect(html).toContain("UI");
      expect(html).toContain("Home Assistant");
      expect(html).toContain("NOTSET");
      expect(html).toContain("INFO");
      // Level words are colourised with the shared severity colours.
      expect(html).toContain(utils.levelColors("INFO").color);
      expect(html).toContain(utils.levelColors("DEBUG").color);
      expect((html.match(/<tr>/g) || []).length).toBe(2);
    });

    test("opening populates the dialog and logger name", () => {
      loggers.openHistoryDialog(rec, "t.logger");
      expect(rec._historyLoggerName.textContent).toBe("t.logger");
      expect(rec._historyTableBody.innerHTML).toContain("INFO");
      expect(rec._historyDialog.style.display).toBe("flex");
    });

    test("heading prefers the friendly name and keeps the path as a tooltip", () => {
      rec._hass.states["select.t"].attributes.friendly_name = "My Logger";
      loggers.openHistoryDialog(rec, "t.logger");
      expect(rec._historyLoggerName.textContent).toContain("My Logger");
      expect(rec._historyLoggerName.textContent).toContain("t.logger");
      expect(rec._historyLoggerName.title).toBe("t.logger");
    });

    test("rows are formatted through the locale-aware formatter", () => {
      const spy = jest.spyOn(utils, "formatDateTime").mockReturnValue("WHEN");
      const html = loggers.historyRowsHtml(rec, "t.logger");
      expect(spy).toHaveBeenCalled();
      expect(html).toContain("WHEN");
      spy.mockRestore();
    });

    test("empty history renders a placeholder row", () => {
      rec._hass.states["select.t"].attributes.audit = [];
      expect(loggers.historyRowsHtml(rec, "t.logger")).toContain("No level changes recorded");
    });

    test("history button in the expanded panel opens the dialog", () => {
      const rec2 = document.createElement("log-manager-card");
      rec2._hass = {
        states: {
          "select.t": {
            state: "INFO",
            attributes: {
              logger_name: "t.logger",
              friendly_name: "T",
              options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
              audit: [{ ts: 1700000000, source: "ui", old_level: "NOTSET", new_level: "INFO" }],
            },
          },
        },
        callService: jest.fn(),
      };
      rec2._counters = {};
      rec2._prevRowStates = {};
      rec2._activeList = document.createElement("div");
      rec2._expandedLogger = "t.logger";
      rec2._historyDialog = { style: {}, classList: { add: jest.fn() } };
      rec2._historyLoggerName = { textContent: "" };
      rec2._historyTableBody = { innerHTML: "" };

      addForm.updateActiveList(rec2);
      const btn = rec2._activeList.querySelector(".history-btn");
      expect(btn).not.toBeNull();
      btn.click();
      expect(rec2._historyTableBody.innerHTML).toContain("INFO");
      expect(rec2._historyDialog.style.display).toBe("flex");
    });
  });

  describe("panel refresh after a committed change", () => {
    test("rebuilds the panel even while a control inside it has focus", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.t": {
            state: "INFO",
            attributes: {
              logger_name: "t.logger",
              friendly_name: "T",
              options: ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
              alert_threshold: 0,
              alert_level: "ERROR",
            },
          },
        },
        callService: jest.fn(),
      };
      rec._counters = { "t.logger": { warning: 1, error: 0, recent_logs: [], levels: { INFO: 1 } } };
      rec._prevRowStates = {};
      rec._activeList = document.createElement("div");
      rec._expandedLogger = "t.logger";
      addForm.updateActiveList(rec);

      const panelEl = rec._activeList.querySelector(".log-panel");
      const control = panelEl.querySelector(".alert-level-select");
      Object.defineProperty(rec.shadowRoot, "activeElement", {
        configurable: true,
        get: () => control,
      });
      const before = rec._prevPanelHtml["t.logger"];

      // Focused panel without a forced request: left untouched.
      rec._counters["t.logger"] = { warning: 0, error: 0, recent_logs: [], levels: {} };
      addForm.updateActiveList(rec);
      expect(rec._activeList.querySelector(".log-panel")).toBe(panelEl);
      expect(rec._prevPanelHtml["t.logger"]).toBe(before);

      // A committed change forces the rebuild despite the focus.
      rec._panelRefreshRequested = "t.logger";
      addForm.updateActiveList(rec);
      expect(rec._prevPanelHtml["t.logger"]).not.toBe(before);
      expect(rec._panelRefreshRequested).toBeNull();
    });
  });
});
