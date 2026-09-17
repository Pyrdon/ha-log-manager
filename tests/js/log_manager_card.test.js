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

  describe("confirm dialog", () => {
    beforeEach(() => {
      const mockRoot = document.createElement("div");
      mockRoot.getElementById = function (id) {
        return this.querySelector(`#${id}`);
      };
      cardInstance.shadowRoot = mockRoot;
      cardInstance._buildUI();
    });

    test("Escape hides the dialog", () => {
      const onConfirm = jest.fn();
      cardInstance._showDeleteConfirm("Sure?", onConfirm, "Do it", "Go");
      expect(cardInstance._deleteDialog.style.display).toBe("flex");

      cardInstance.shadowRoot.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape" })
      );

      expect(onConfirm).not.toHaveBeenCalled();
      expect(cardInstance._deleteDialog.style.display).toBe("none");
    });

    test("the confirm button runs the confirm path with the given label", () => {
      const onConfirm = jest.fn();
      cardInstance._showDeleteConfirm("Sure?", onConfirm, "Do it", "Go");

      expect(cardInstance.shadowRoot.querySelector(".delete-dialog-title").textContent).toBe("Do it");
      expect(cardInstance.shadowRoot.getElementById("delete-confirm-btn").textContent).toBe("Go");
      cardInstance.shadowRoot.getElementById("delete-confirm-btn").click();

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(cardInstance._deleteDialog.style.display).toBe("none");
    });

    test("the cancel button runs the cancel path", () => {
      const onCancel = jest.fn();
      cardInstance._showDeleteConfirm("Sure?", jest.fn(), "Do it", "Go", onCancel);

      cardInstance.shadowRoot.getElementById("delete-cancel-btn").click();

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(cardInstance._deleteDialog.style.display).toBe("none");
    });
  });

  describe("set all levels", () => {
    let rec;

    beforeEach(() => {
      const mockRoot = document.createElement("div");
      mockRoot.getElementById = function (id) {
        return this.querySelector(`#${id}`);
      };
      rec = document.createElement("log-manager-card");
      rec.shadowRoot = mockRoot;
      rec._hass = {
        states: {},
        connection: { sendMessagePromise: jest.fn(() => Promise.resolve({ changed: 3, already: 0, skipped: 0 })) },
        callService: jest.fn(),
      };
      rec._buildUI();
    });

    test("populates the level options and defaults to NOTSET", () => {
      const options = Array.from(rec._setAllLevel.querySelectorAll("option")).map(o => o.value);
      expect(options).toEqual(["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);
    });

    test("Apply is enabled only when loggers are managed", () => {
      rec._hass.states = {};
      rec._updateActiveList();
      expect(rec._setAllApply.disabled).toBe(true);

      rec._hass.states = {
        "select.t": { attributes: { logger_name: "t.logger" }, state: "NOTSET" },
      };
      rec._updateActiveList();
      expect(rec._setAllApply.disabled).toBe(false);
    });

    test("applies through the batched set_levels command after confirmation", () => {
      rec._setAllLevel.value = "WARNING";
      // Auto-confirm: run the confirm callback immediately.
      rec._showDeleteConfirm = jest.fn((message, onConfirm) => onConfirm());

      rec._applySetAll();

      expect(rec._hass.connection.sendMessagePromise).toHaveBeenCalledWith({
        type: "log_manager/set_levels",
        level: "WARNING",
      });
    });

    test("does not call the command when the confirmation is cancelled", () => {
      rec._setAllLevel.value = "DEBUG";
      rec._showDeleteConfirm = jest.fn();

      rec._applySetAll();

      const called = rec._hass.connection.sendMessagePromise.mock.calls
        .some(([msg]) => msg && msg.type === "log_manager/set_levels");
      expect(called).toBe(false);
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

    test("_buildLoggerTree compresses unary chains and branches at splits", () => {
      const tree = cardInstance._buildLoggerTree([
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
      cardInstance._updateActiveList();
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
      cardInstance._updateActiveList();
      // custom_components is a unary chain: no header; log_manager is the row.
      let headers = Array.from(cardInstance._activeList.querySelectorAll(".log-group-header"));
      expect(headers.map((h) => h.dataset.group)).toEqual([]);
      let order = Array.from(cardInstance._activeList.children).map(
        (el) => el.dataset.entityId || el.dataset.group
      );
      // Children are ordered by path segment: number before select.
      expect(order).toEqual(["select.lm", "select.lm_num", "select.lm_sel"]);

      cardInstance._hass.states["select.test"] = attrs("custom_components.test", "Test");
      cardInstance._updateActiveList();
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
      cardInstance._updateActiveList();
      expect(cardInstance._activeList.querySelector(".log-group-header")).toBeNull();
      expect(cardInstance._activeList.querySelectorAll(".log-row").length).toBe(3);
    });

    test("grouped headers show the descendant count", () => {
      cardInstance._updateActiveList();
      const header = cardInstance._activeList.querySelector(
        '.log-group-header[data-group="homeassistant.core"]'
      );
      expect(header.querySelector(".log-group-count").textContent).toBe("(2)");
      expect(header.querySelector(".log-group-name").textContent).toBe("homeassistant.core");
    });

    test("group_by_prefix false renders a flat list", () => {
      cardInstance.config = { type: "custom:log-manager-card", group_by_prefix: false };
      cardInstance._updateActiveList();
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
      cardInstance._updateActiveList();
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
      cardInstance._updateActiveList();
      const after = cardInstance._activeList.querySelector(
        '.log-row[data-entity-id="select.core_a"]'
      );
      expect(after).toBe(child);
      expect(after.style.display).toBe("none");
    });

    test("removing the last sibling contracts the branch back to a row", () => {
      cardInstance._updateActiveList();
      delete cardInstance._hass.states["select.core_b"];
      cardInstance._updateActiveList();
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
      cardInstance._updateActiveList();
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
      cardInstance._updateActiveList();

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
      cardInstance._updateActiveList();

      expect(wrapper.parentElement).toBe(cardInstance._activeList);
      expect(wrapper.previousElementSibling).toBe(rowA);
      expect(cardInstance._activeList.lastElementChild).not.toBe(wrapper);
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

    test("clicking the group chevron expands and collapses its occurrences", () => {
      cardInstance._appendLiveEntries([mk(0, 0, "a.logger"), mk(1, 5, "a.logger")]);
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
      cardInstance._appendLiveEntries([mk(0, 0, "a.logger"), mk(1, 5, "a.logger")]);
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

      test("results render oldest-first and filter changes keep that order", () => {
        cardInstance._recordingBuffer = [
          mk(0, 0, "a.logger"),
          mk(1, 1, "a.logger"),
          mk(2, 2, "b.logger", "ERROR", "other"),
        ];
        cardInstance._showRecordingResults();
        let groups = cardInstance._livePreview.querySelectorAll(".log-preview-group");
        expect(groups.length).toBe(1);

        // Changing filters must not flip results away from live ordering.
        cardInstance._liveLoggerFilter = { value: "" };
        cardInstance._applyLiveFilters();
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
      const inBuffer = cardInstance._entryKey(cardInstance._recordingBuffer[0]);
      cardInstance._selectedKeys = new Set([inBuffer, "panel-entry-not-in-buffer"]);
      cardInstance._updateExportButtonState();
      expect(cardInstance._liveCopyBtn.title).toBe("Copy 1 selected entry to clipboard");

      cardInstance._selectedKeys = new Set(["panel-entry-not-in-buffer"]);
      cardInstance._updateExportButtonState();
      expect(cardInstance._liveCopyBtn.title).toContain("Copy all recorded entries");
    });

    test("export labels name the dynamic scope and the save format", () => {
      cardInstance._recordingBuffer = buf();
      cardInstance._selectedKeys = new Set();
      cardInstance._updateExportButtonState();
      expect(cardInstance._liveCopyBtn.textContent).toBe("Copy all");
      expect(cardInstance._liveSavePlainBtn.textContent).toBe("Save all as .log");
      expect(cardInstance._liveSaveJsonlBtn.textContent).toBe("Save all as JSONL");

      const keys = cardInstance._recordingBuffer
        .slice(0, 2)
        .map(entry => cardInstance._entryKey(entry));
      cardInstance._selectedKeys = new Set(keys);
      cardInstance._updateExportButtonState();
      expect(cardInstance._liveCopyBtn.textContent).toBe("Copy 2 selected");
      expect(cardInstance._liveSavePlainBtn.textContent).toBe("Save 2 selected as .log");
      expect(cardInstance._liveSaveJsonlBtn.textContent).toBe("Save 2 selected as JSONL");
    });

    test("_summarizeResults totals severity, loggers, and repeats", () => {
      const summary = cardInstance._summarizeResults(buf());
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
      const summary = cardInstance._summarizeResults(logs);
      expect(summary.loggers.top).toHaveLength(5);
      expect(summary.loggers.more).toBe(2);
      expect(summary.repeats.top).toHaveLength(5);
      expect(summary.repeats.more).toBe(2);
    });

    test("results show a read-only summary block below the table", () => {
      cardInstance._recordingBuffer = buf();
      cardInstance._recordingLogCount = 4;
      cardInstance._showRecordingResults();
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
      cardInstance._showRecordingResults();
      const block = cardInstance._livePreview.parentElement.querySelector("#results-summary");
      const row = block.querySelector(".summary-row");
      expect(row.tagName).toBe("DIV");
      expect(row.getAttribute("role")).toBeNull();
      expect(row.onclick).toBeNull();
    });

    test("empty captures show no summary block", () => {
      cardInstance._recordingBuffer = [];
      cardInstance._recordingLogCount = 0;
      cardInstance._showRecordingResults();
      const block = cardInstance._livePreview.parentElement.querySelector("#results-summary");
      expect(block === null || block.style.display === "none").toBe(true);
    });

    test("an empty capture shows a single empty-state message", () => {
      cardInstance._recordingBuffer = [];
      cardInstance._recordingLogCount = 0;
      cardInstance._showRecordingResults();
      // The summary owns the empty-state message; the table stays blank.
      expect(cardInstance._liveSummary.textContent).toContain("No log events matched");
      expect(cardInstance._livePreview.innerHTML).toBe("");
    });

    test("summary follows the filter on the flat (non-dedup) path", () => {
      cardInstance.config = { type: "custom:log-manager-card", live_dedup: false };
      cardInstance._recordingBuffer = buf();
      cardInstance._recordingLogCount = 4;
      cardInstance._showRecordingResults();

      cardInstance._liveLevelFilter.value = "ERROR";
      cardInstance._applyLiveFilters();

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
      cardInstance._showRecordingResults();
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
      cardInstance._showRecordingResults();
      const block = cardInstance._livePreview.parentElement.querySelector("#results-summary");
      expect(block.textContent).toContain("NOTSET 1");
      expect(block.querySelector('[data-filter-value="NOTSET"]')).toBeNull();
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

    test("_checkExistingRecording adopts the session's pending level reverts", async () => {
      rec._updateRecordingUI = jest.fn();
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
      rec._checkExistingRecording();
      await Promise.resolve();

      expect(rec._recordingState).toBe("recording");
      expect(rec._recordingRestoreLevels["rec.logger"]).toEqual({
        entityId: "select.rec",
        level: "INFO",
        raisedTo: "DEBUG",
      });
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

    test("_entryMatchesFilter matches only the exact logger, not its children", () => {
      const child = { logger: "rec.logger.child", level: "INFO" };
      const parent = { logger: "rec.logger", level: "INFO" };
      expect(cardInstance._entryMatchesFilter(parent, "ALL", "rec.logger")).toBe(true);
      expect(cardInstance._entryMatchesFilter(child, "ALL", "rec.logger")).toBe(false);
      expect(cardInstance._entryMatchesFilter(child, "ALL", "other.logger")).toBe(false);
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
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).not.toContain("count-level-select");
      expect(html).not.toContain("severity-line");
    });

    test("disclaimer states counting is WARNING and above", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain("WARNING and above");
    });

    test("renders the captured WARNING+ entries", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain("log-level-warning");
      expect(html).toContain(">W</span>");
      expect(html).toContain("log-level-error");
      expect(html).toContain(">E</span>");
      expect(html).toContain("some warning");
      expect(html).toContain("some error");
    });

    test("no suppression tooltip while the logger's level is WARNING", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).not.toContain("discarded before the counters");
    });

    test("explains in the disclaimer tooltip when the logger is above WARNING", () => {
      cardInstance._hass.states["select.test"].attributes.effective_level = "ERROR";

      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain("discards these events before the counter handler runs");
      expect(html).toContain("ERROR");
      expect(html).toContain("WARNING and above");
    });

    test("per-logger controls share one row without a counting control", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('class="panel-controls-row"');
      const controls = html.slice(html.indexOf("panel-controls-row"));
      expect(controls).not.toContain("count-level-select");
      expect(controls).not.toContain("sensor-enabled-toggle");
      expect(controls).toContain("alert-threshold-input");
      expect(controls).toContain("history-btn");
    });

    test("shows a discoverable multi-select hint", () => {
      expect(cardInstance._renderLogPanelHtml("t.logger")).toContain("Ctrl/Cmd-click or drag");
    });

    test("reset action names the captured entries as well as the counts", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
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
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('class="alert-level-select"');
      expect(html).toContain('<option value="WARNING" style="color: #ff9800;" selected>WARNING</option>');
      expect(html).toContain('class="alert-threshold-input"');
      expect(html).toContain('value="5"');
    });

    test("defaults to DISABLED and hides the threshold without entity data", () => {
      cardInstance._hass = { states: {}, callService: jest.fn() };
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('<option value="DISABLED" style="color: var(--secondary-text-color);" selected>DISABLED</option>');
      expect(html).toContain('class="alert-threshold-input"');
      expect(html).toContain('style="display: none;"');
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

    test("committing the threshold with Enter calls set_alert_threshold", () => {
      const row = document.createElement("div");
      row.innerHTML = cardInstance._renderLogPanelHtml("t.logger");
      cardInstance._attachAlertHandler(row);

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
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('value="DISABLED" style="color: var(--secondary-text-color);" selected');
      expect(html).toContain('class="alert-threshold-input"');
      expect(html).toContain('style="display: none;"');
    });

    test("a set threshold renders its severity selected and the input visible", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).toContain('value="WARNING" style="color: #ff9800;" selected');
      expect(html).not.toContain('style="display: none;"');
    });
  });

  describe("counter sensor controls", () => {
    beforeEach(() => {
      cardInstance._hass = {
        states: {
          "select.test": {
            state: "INFO",
            attributes: {
              logger_name: "t.logger",
              alert_threshold: 0,
              alert_level: "ERROR",
            },
          },
        },
        callService: jest.fn(),
      };
      cardInstance._counters = {
        "t.logger": { warning: 0, error: 0, recent_logs: [], levels: {} },
      };
    });

    test("sensors are auto-managed with no per-row toggle", () => {
      const html = cardInstance._renderLogPanelHtml("t.logger");
      expect(html).not.toContain("sensor-enabled-toggle");
      expect(cardInstance._attachSensorHandler).toBeUndefined();
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
      const title = cardInstance._auditTitle("t.logger");
      expect(title).toContain("NOTSET \u2192 INFO by UI");
      expect(title).toContain("INFO \u2192 DEBUG by UI");
      expect(title.split("\n").length).toBe(2);
    });

    test("omits the history when there are no entries", () => {
      cardInstance._hass.states["select.test"].attributes.audit = [];
      expect(cardInstance._auditTitle("t.logger")).toBe("");
    });

    test("shows at most three entries", () => {
      cardInstance._hass.states["select.test"].attributes.audit = [
        { ts: 1, source: "ui", old_level: "A", new_level: "B" },
        { ts: 2, source: "ui", old_level: "B", new_level: "C" },
        { ts: 3, source: "ui", old_level: "C", new_level: "D" },
        { ts: 4, source: "ui", old_level: "D", new_level: "E" },
      ];
      const title = cardInstance._auditTitle("t.logger");
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
      cardInstance._updateActiveList();
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
      expect(row.style.background).toBe(cardInstance._levelColors("DEBUG").rowBg);
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
      const chip = after.querySelector(".effective-line");
      expect(chip.textContent).toContain("INFO");
      // The container colour follows the effective level (jsdom normalises hex).
      const probe = document.createElement("span");
      probe.style.color = cardInstance._levelColors("INFO").color;
      expect(chip.style.color).toBe(probe.style.color);
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

    test("applying a profile restores its exclusion chips", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        profiles: [{
          name: "p1",
          loggers: ["test.logger"],
          level_overrides: {},
          excludes: { "test.logger": ["test.logger.noisy"] },
          max_duration: 60,
        }],
      });
      rec._applyProfile("p1");
      await Promise.resolve();
      await Promise.resolve();

      const cb = rec._loggerChecklist.querySelector("input[data-logger='test.logger']");
      const chips = cb.closest(".checklist-item").querySelectorAll(".exclude-chip");
      expect(chips).toHaveLength(1);
      expect(chips[0].dataset.path).toBe("test.logger.noisy");
    });

    test("saving a profile sends the collected exclusions", () => {
      const cb = rec._loggerChecklist.querySelector("input[data-logger='test.logger']");
      cb.checked = true;
      const levelSelect = cb.closest(".checklist-item").querySelector(".recording-level-select");
      levelSelect.value = "DEBUG";
      rec._collectRecordingExcludes = jest.fn(() => ({ "test.logger": ["test.logger.noisy"] }));
      rec._profiles = [];
      rec._profileNameInput.value = "p1";
      rec._sendProfileSave = jest.fn();

      rec._saveProfile();

      expect(rec._sendProfileSave).toHaveBeenCalledWith(
        "p1",
        ["test.logger"],
        { "test.logger": "DEBUG" },
        { "test.logger": ["test.logger.noisy"] }
      );
    });

    test("a retained profile is applied when the setup re-opens", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValue({
        profiles: [{ name: "p1", loggers: ["test.logger"], level_overrides: {}, max_duration: 60 }],
      });
      // First render populates the options; the retained value applies on re-open.
      rec._renderProfileOptions([{ name: "p1" }]);
      rec._profileSelect.value = "p1";
      rec._renderProfileOptions([{ name: "p1" }]);
      await Promise.resolve();
      await Promise.resolve();
      const cb = rec._loggerChecklist.querySelector("input[data-logger='test.logger']");
      expect(cb.checked).toBe(true);
    });

    test("no profiles disables the selector and shows a placeholder", () => {
      rec._renderProfileOptions([]);
      expect(rec._profileSelect.disabled).toBe(true);
      expect(rec._profileSelect.innerHTML).toContain("No profiles yet");
    });

    test("with profiles there is no None option and the shown profile is applied", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValue({
        profiles: [{ name: "p1", loggers: ["test.logger"], level_overrides: {}, max_duration: 60 }],
      });
      rec._renderProfileOptions([{ name: "p1" }]);
      await Promise.resolve();
      await Promise.resolve();
      expect(rec._profileSelect.disabled).toBe(false);
      expect(rec._profileSelect.innerHTML).not.toContain("None");
      expect(rec._profileSelect.value).toBe("p1");
      const cb = rec._loggerChecklist.querySelector("input[data-logger='test.logger']");
      expect(cb.checked).toBe(true);
    });

    test("saving sends the current selection", async () => {
      const boxes = rec._loggerChecklist.querySelectorAll(
        "input[type='checkbox']:not(#select-all-checkbox)"
      );
      boxes.forEach(cb => {
        cb.checked = cb.dataset.logger === "test.logger";
      });
      rec._profileNameInput.value = "p1";
      rec._collectRecordingExcludes = jest.fn(() => ({ "test.logger": ["test.logger.noisy"] }));
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({ profiles: [] });

      rec._saveProfile();
      await Promise.resolve();

      expect(rec._hass.connection.sendMessagePromise).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "log_manager/profile_save",
          name: "p1",
          loggers: ["test.logger"],
          excludes: { "test.logger": ["test.logger.noisy"] },
        })
      );
    });

    test("editing settings marks the shown profile as modified", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValue({
        profiles: [{ name: "p1", loggers: ["test.logger"], level_overrides: {}, max_duration: 60 }],
      });
      rec._renderProfileOptions([{ name: "p1" }], "p1");
      await Promise.resolve();
      await Promise.resolve();
      expect(rec._profileSelect.value).toBe("p1");

      const cb = rec._loggerChecklist.querySelector("input[data-logger='other.logger']");
      cb.checked = true;
      cb.dispatchEvent(new Event("change", { bubbles: true }));

      expect(rec._profileDirty).toBe(true);
      expect(rec._profileSelect.value).toBe("__modified__");
      expect(rec._profileSelect.textContent).toContain("p1 *");
    });

    test("re-choosing a modified profile confirms then reloads it", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValue({
        profiles: [{ name: "p1", loggers: ["test.logger"], level_overrides: {}, max_duration: 60 }],
      });
      rec._renderProfileOptions([{ name: "p1" }], "p1");
      await Promise.resolve();
      await Promise.resolve();

      const cb = rec._loggerChecklist.querySelector("input[data-logger='other.logger']");
      cb.checked = true;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
      expect(rec._profileDirty).toBe(true);

      rec._showDeleteConfirm = jest.fn((message, onConfirm) => onConfirm());
      rec._profileSelect.value = "p1";
      rec._onProfileSelectChange();
      await Promise.resolve();
      await Promise.resolve();

      expect(rec._showDeleteConfirm).toHaveBeenCalled();
      expect(rec._profileDirty).toBe(false);
      expect(rec._profileSelect.value).toBe("p1");
      expect(cb.checked).toBe(false);
    });
  });

  describe("single open exclusions area", () => {
    test("opening one logger's exclusions closes the other", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.a": { attributes: { logger_name: "a.logger", friendly_name: "A" }, state: "INFO" },
          "select.b": { attributes: { logger_name: "b.logger", friendly_name: "B" }, state: "INFO" },
        },
      };
      rec._loggerChecklist = document.createElement("div");
      rec._recordingSetupDialog = document.createElement("div");
      rec._recordingSetupStart = { disabled: false };
      rec._openRecordingSetup();

      rec._loggerChecklist
        .querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)")
        .forEach(cb => {
          cb.checked = true;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        });

      const toggles = rec._loggerChecklist.querySelectorAll(".exclude-toggle");
      const areas = rec._loggerChecklist.querySelectorAll(".exclude-area");
      toggles[0].click();
      expect(areas[0].style.display).toBe("block");

      toggles[1].click();
      expect(areas[1].style.display).toBe("block");
      expect(areas[0].style.display).toBe("none");
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
      const cb = rec._loggerChecklist.querySelector(
        "input[type='checkbox']:not(#select-all-checkbox)"
      );
      cb.checked = true;
      // Selecting the logger is what enables its exclusions control.
      cb.dispatchEvent(new Event("change", { bubbles: true }));
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

    test("exclusions control is disabled until the logger is selected", () => {
      const cb = rec._loggerChecklist.querySelector(
        "input[type='checkbox']:not(#select-all-checkbox)"
      );
      const toggle = rec._loggerChecklist.querySelector(".exclude-toggle");
      cb.checked = false;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
      expect(toggle.disabled).toBe(true);

      cb.checked = true;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
      expect(toggle.disabled).toBe(false);
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

    test("counts managed roots, not distinct child logger names", () => {
      rec._recordingLoggers = ["custom_components.log_manager"];
      rec._recordingBuffer = [
        { id: 0, logger: "custom_components.log_manager", level: "INFO", message: "x" },
        { id: 1, logger: "custom_components.log_manager.select", level: "INFO", message: "y" },
      ];
      rec._updateLiveSummary();
      expect(rec._liveSummary.textContent).toContain("1 with entry");
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
      expect(rec._liveStatusText.textContent).toBe("Recording complete");
    });
  });

  describe("_togglePauseLive", () => {
    let rec;

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

    test("polling while paused keeps the buffer and summary live but skips rows", async () => {
      // Restore the real poll method (the describe stubs it for the label test).
      delete rec._pollRecordingEntries;
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

      rec._pollRecordingEntries();
      await Promise.resolve();

      // Buffer and summary update while paused; no row is rendered.
      expect(rec._recordingBuffer).toHaveLength(1);
      expect(rec._liveSummary.textContent).toContain("1 entry");
      expect(rec._livePreview.appendChild).not.toHaveBeenCalled();

      // Resuming replays the buffered row.
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({ entries: [], next_id: 1 });
      rec._togglePauseLive();
      expect(rec._livePreview.appendChild).toHaveBeenCalledTimes(1);
    });
  });

  describe("fuzzy logger search", () => {
    let rec;
    const visible = () =>
      Array.from(rec._optionsList.children)
        .filter((el) => el.style.display !== "none")
        .map((el) => el.textContent.replace("★ ", ""));

    beforeEach(() => {
      rec = document.createElement("log-manager-card");
      rec._optionsList = document.createElement("div");
      rec._availableLoggers = ["pyscript.file", "pyscriptfile", "pyscript.file.test"];
      rec._hass = { states: {} };
      rec._renderDropdown();
    });

    test("ranks an exact substring match first", () => {
      rec._filterDropdown("pyscript.file");
      expect(visible()[0]).toBe("pyscript.file");
    });

    test("finds pyscript.file from a separator-less query", () => {
      rec._filterDropdown("pyscriptfile");
      expect(visible()).toContain("pyscriptfile");
      expect(visible()).toContain("pyscript.file");
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
      const html = cardInstance._loggerCellHtml("custom_components.log_manager.recording");
      expect(html).toContain("Log Manager");
      expect(html).toContain("recording");
      expect(html).toContain("logger-child");
    });

    test("falls back to the raw path when no managed root matches", () => {
      cardInstance._recordingLoggers = [];
      cardInstance._hass = { states: {} };
      expect(cardInstance._loggerCellHtml("orphan.logger")).toBe("orphan.logger");
    });
  });

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
      rec._attachCopyPanelHandler(row);
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
      rec._selectedKeys = new Set([rec._entryKey(entry)]);
      rec._attachCopyPanelHandler(row);
      row.querySelector(".copy-panel-btn").click();
      await Promise.resolve();
      await Promise.resolve();
      const text = navigator.clipboard.writeText.mock.calls[0][0];
      expect(text).toContain("second");
      expect(text).not.toContain("first");
    });
  });

  describe("fuzzy highlight readability", () => {
    test("highlighted options keep their text colour and fuzzy hits stand out", () => {
      const highlightRule = cardSource.match(/\.option-item\.highlight\s*\{([^}]*)\}/);
      expect(highlightRule).not.toBeNull();
      expect(highlightRule[1]).not.toContain("color:");
      const fuzzyRule = cardSource.match(/\.fuzzy-hit\s*\{([^}]*)\}/);
      expect(fuzzyRule).not.toBeNull();
      expect(fuzzyRule[1]).toContain("text-decoration: underline");
      expect(fuzzyRule[1]).toContain("background");
      expect(fuzzyRule[1]).toContain("color: var(--primary-color)");
    });

    test("_highlightMatch wraps matched characters in the fuzzy-hit class", () => {
      const html = cardInstance._highlightMatch("pyscript.file", "pys");
      expect(html).toContain('class="fuzzy-hit"');
    });
  });

  describe("recording setup layout", () => {
    test("select-all row is a label bound to the checkbox", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.test_logger": {
            attributes: { logger_name: "test.logger", friendly_name: "Test Logger" },
            state: "NOTSET",
          },
        },
      };
      rec._loggerChecklist = document.createElement("div");
      rec._recordingSetupDialog = { style: {}, classList: { add: jest.fn(), remove: jest.fn() } };
      rec._recordingSetupStart = { disabled: false };
      rec._openRecordingSetup();

      const row = rec._loggerChecklist.querySelector(".select-all-row");
      expect(row.tagName).toBe("LABEL");
      expect(row.getAttribute("for")).toBe("select-all-checkbox");
    });

    test("uses a moderate dialog width and taller checklist", () => {
      expect(cardSource).toMatch(/\.dialog-box\.recording-setup-box\s*\{[^}]*max-width:\s*580px/);
      expect(cardSource).toMatch(/\.logger-checklist\s*\{[^}]*max-height:\s*380px/);
      expect(cardSource).toContain('class="dialog-box recording-setup-box"');
    });

    test("expanded group items are dimmed more", () => {
      expect(cardSource).toMatch(/\.log-preview-group-item\s*\{[^}]*opacity:\s*0\.4/);
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
      rec._rebuildLivePreview();
      expect(rec._livePreview.querySelectorAll(".log-preview-line").length).toBe(2);
      expect(rec._livePreview.querySelector(".log-preview-group")).toBeNull();

      rec._liveDedupOverride = true;
      rec._rebuildLivePreview();
      expect(rec._livePreview.querySelectorAll(".log-preview-group").length).toBe(1);
    });

    test("results view honours the grouping toggle", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._liveLoggerFilter = { value: "" };
      rec._recordingBuffer = buffer();
      rec._liveDedupOverride = false;
      rec._rebuildResultsPreview();
      expect(rec._livePreview.querySelectorAll(".log-preview-line").length).toBe(2);
      expect(rec._livePreview.querySelector(".log-preview-group")).toBeNull();

      rec._liveDedupOverride = true;
      rec._rebuildResultsPreview();
      expect(rec._livePreview.querySelectorAll(".log-preview-group").length).toBe(1);
    });

    test("group row shows a single count plus the first entry id", () => {
      const rec = document.createElement("log-manager-card");
      rec._livePreview = document.createElement("div");
      rec._liveLevelFilter = { value: "ALL" };
      rec._liveLoggerFilter = { value: "" };
      rec._recordingBuffer = buffer();
      rec._appendLiveEntries(rec._recordingBuffer);

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
      rec._liveLoggerFilter = { value: "" };
      rec._recordingBuffer = mkBuf();
      // Flat rows keep the row order deterministic for range checks.
      rec._liveDedupOverride = false;
      rec._liveSavePlainBtn = { disabled: false, title: "" };
      rec._liveSaveJsonlBtn = { disabled: false, title: "" };
      rec._liveCopyBtn = { disabled: false, title: "", textContent: "Copy" };
      rec._rebuildLivePreview();
    });

    afterEach(() => {
      container.remove();
    });

    test("plain click selects one row", () => {
      rec._handleSelectionClick(container, rows()[0], {});
      expect(rows()[0].classList.contains("selected")).toBe(true);
      expect(rows()[1].classList.contains("selected")).toBe(false);
    });

    test("ctrl-click adds and removes rows", () => {
      rec._handleSelectionClick(container, rows()[0], {});
      rec._handleSelectionClick(container, rows()[1], { ctrlKey: true });
      expect(rows()[0].classList.contains("selected")).toBe(true);
      expect(rows()[1].classList.contains("selected")).toBe(true);
      rec._handleSelectionClick(container, rows()[1], { ctrlKey: true });
      expect(rows()[1].classList.contains("selected")).toBe(false);
    });

    test("shift-click selects a range", () => {
      rec._handleSelectionClick(container, rows()[0], {});
      rec._handleSelectionClick(container, rows()[2], { shiftKey: true });
      expect(rows().every(r => r.classList.contains("selected"))).toBe(true);
    });

    test("press-and-drag extends the selection and suppresses native selection", () => {
      const preventDefault = jest.fn();
      rec._onSelectionMouseDown(container, { button: 0, target: rows()[0], preventDefault });
      expect(preventDefault).toHaveBeenCalled();
      rows()[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      expect(rows().every(r => r.classList.contains("selected"))).toBe(true);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    test("selection survives a rebuild", () => {
      rec._handleSelectionClick(container, rows()[0], {});
      rec._rebuildLivePreview();
      const selected = Array.from(container.querySelectorAll(".log-preview-line"))
        .filter(el => el.classList.contains("selected"));
      expect(selected.length).toBe(1);
      expect(selected[0].dataset.id).toBe("0");
    });

    test("copying uses the selection when one exists", async () => {
      navigator.clipboard = { writeText: jest.fn(() => Promise.resolve()) };
      try {
        rec._handleSelectionClick(container, rows()[1], {});
        rec._copyLogsToClipboard();
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

  describe("recording verbosity prompt", () => {
    test("_isMoreVerbose only flags lower severities above NOTSET", () => {
      const rec = document.createElement("log-manager-card");
      expect(rec._isMoreVerbose("DEBUG", "INFO")).toBe(true);
      expect(rec._isMoreVerbose("INFO", "INFO")).toBe(false);
      expect(rec._isMoreVerbose("WARNING", "INFO")).toBe(false);
      expect(rec._isMoreVerbose("DEBUG", "NOTSET")).toBe(false);
      expect(rec._isMoreVerbose("NOTSET", "INFO")).toBe(false);
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
      rec._openRecordingSetup();

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
      rec._showDeleteConfirm = jest.fn((message, onConfirm) => onConfirm());

      rec._handleRecordingLevelChange(sel);

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
      rec._showDeleteConfirm = jest.fn((message, onConfirm, title, confirmLabel, onCancel) => onCancel && onCancel());

      rec._handleRecordingLevelChange(sel);

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

      rec._handleRecordingLevelChange(sel);

      const probeColor = document.createElement("span");
      probeColor.style.color = rec._levelColors("ERROR").color;
      const probeBg = document.createElement("span");
      probeBg.style.background = rec._levelColors("ERROR").rowBg;
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
      rec._showDeleteConfirm = jest.fn((message, onConfirm, title, confirmLabel, onCancel, htmlMessage) => {
        captured = { msg: message, html: htmlMessage };
      });

      rec._handleRecordingLevelChange(sel);

      expect(captured.html).toBe(true);
      expect(captured.msg).toContain("Test Logger");
      expect(captured.msg).not.toContain("This logger");
      expect(captured.msg).toContain(rec._levelColors("WARNING").color);
      expect(captured.msg).toContain(rec._levelColors("DEBUG").color);
    });

    test("cancelling a profile raise restores the select to the configured level", () => {
      const rec = document.createElement("log-manager-card");
      const item = document.createElement("div");
      item.className = "checklist-item";
      item.innerHTML = `<select class="recording-level-select" data-logger="t.logger" data-prev-level="DEBUG"><option value="INFO">INFO</option><option value="DEBUG">DEBUG</option></select>`;
      const sel = item.querySelector(".recording-level-select");
      sel.value = "DEBUG";
      const cancels = [];
      rec._showDeleteConfirm = jest.fn((message, onConfirm, title, confirmLabel, onCancel) => {
        cancels.push(onCancel);
      });
      rec._recordingRaiseIntents = {};

      rec._promptRaiseSequence([
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

      rec._startRecording(["rec.logger"], { "rec.logger": "DEBUG" });

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
      rec._cleanupRecordingIntervals();
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

      rec._startRecording(["rec.logger"], { "rec.logger": "DEBUG" });
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
      rec._cleanupRecordingIntervals();
    });
  });

  describe("raised indicator", () => {
    test("coexists with the effective chip and clears when not recording", () => {
      const rec = document.createElement("log-manager-card");
      rec._recordingRestoreLevels = {
        "t.logger": { entityId: "select.t", level: "INFO", raisedTo: "DEBUG" },
      };
      const chip = rec._renderRaisedChipHtml("t.logger", true);
      expect(chip).toContain("Raised to DEBUG");
      expect(chip).toContain("Restored to INFO");

      const stateObj = {
        state: "NOTSET",
        attributes: { effective_level: "WARNING", effective_source: "root" },
      };
      expect(rec._renderEffectiveChip(stateObj, "NOTSET", false)).toContain("Effective:");
      expect(rec._renderRaisedChipHtml("t.logger", false)).toBe("");
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
      rec._updateActiveList();

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
      rec._updateActiveList();

      const locked = rec._activeList.querySelector('.log-row[data-entity-id="select.rec"] .level-select');
      const free = rec._activeList.querySelector('.log-row[data-entity-id="select.free"] .level-select');
      expect(locked.disabled).toBe(true);
      expect(locked.title).toContain("locked");
      expect(free.disabled).toBe(false);
      expect(free.title || "").not.toContain("locked");
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
      const html = rec._historyRowsHtml("t.logger");
      expect(html).toContain("UI");
      expect(html).toContain("Home Assistant");
      expect(html).toContain("NOTSET");
      expect(html).toContain("INFO");
      // Level words are colourised with the shared severity colours.
      expect(html).toContain(rec._levelColors("INFO").color);
      expect(html).toContain(rec._levelColors("DEBUG").color);
      expect((html.match(/<tr>/g) || []).length).toBe(2);
    });

    test("opening populates the dialog and logger name", () => {
      rec._openHistoryDialog("t.logger");
      expect(rec._historyLoggerName.textContent).toBe("t.logger");
      expect(rec._historyTableBody.innerHTML).toContain("INFO");
      expect(rec._historyDialog.style.display).toBe("flex");
    });

    test("heading prefers the friendly name and keeps the path as a tooltip", () => {
      rec._hass.states["select.t"].attributes.friendly_name = "My Logger";
      rec._openHistoryDialog("t.logger");
      expect(rec._historyLoggerName.textContent).toContain("My Logger");
      expect(rec._historyLoggerName.textContent).toContain("t.logger");
      expect(rec._historyLoggerName.title).toBe("t.logger");
    });

    test("rows are formatted through the locale-aware formatter", () => {
      const spy = jest.spyOn(rec, "_formatDateTime").mockReturnValue("WHEN");
      const html = rec._historyRowsHtml("t.logger");
      expect(spy).toHaveBeenCalled();
      expect(html).toContain("WHEN");
      spy.mockRestore();
    });

    test("empty history renders a placeholder row", () => {
      rec._hass.states["select.t"].attributes.audit = [];
      expect(rec._historyRowsHtml("t.logger")).toContain("No level changes recorded");
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

      rec2._updateActiveList();
      const btn = rec2._activeList.querySelector(".history-btn");
      expect(btn).not.toBeNull();
      btn.click();
      expect(rec2._historyTableBody.innerHTML).toContain("INFO");
      expect(rec2._historyDialog.style.display).toBe("flex");
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
      rec._showContextMenu([
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
      rec._showContextMenu([{ label: "Do", action }], 10, 10);
      rec._contextMenu.querySelector("button").click();
      expect(action).toHaveBeenCalled();
      expect(rec._contextMenu.style.display).toBe("none");
    });

    test("skips the menu over text inputs so cut/copy/paste stays native", () => {
      const input = document.createElement("input");
      const preventDefault = jest.fn();
      rec._handleListContextMenu({ target: input, clientX: 0, clientY: 0, preventDefault });
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

      rec._handleListContextMenu({ target: name, clientX: 0, clientY: 0, preventDefault: jest.fn() });

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
      el.dataset.selKeys = JSON.stringify([rec._entryKey(entry)]);
      panel.appendChild(el);
      row.appendChild(panel);
      rec._counters = { "t.logger": { warning: 0, error: 0, recent_logs: [entry], levels: {} } };

      rec._handleListContextMenu({ target: el, clientX: 0, clientY: 0, preventDefault: jest.fn() });

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

      rec._handleChecklistContextMenu({ target: item, clientX: 0, clientY: 0, preventDefault: jest.fn() });

      const labels = Array.from(rec._contextMenu.querySelectorAll("button")).map(b => b.textContent);
      expect(labels).toContain("Copy logger path");
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
      rec._updateActiveList();

      const panelEl = rec._activeList.querySelector(".log-panel");
      const control = panelEl.querySelector(".alert-level-select");
      Object.defineProperty(rec.shadowRoot, "activeElement", {
        configurable: true,
        get: () => control,
      });
      const before = rec._prevPanelHtml["t.logger"];

      // Focused panel without a forced request: left untouched.
      rec._counters["t.logger"] = { warning: 0, error: 0, recent_logs: [], levels: {} };
      rec._updateActiveList();
      expect(rec._activeList.querySelector(".log-panel")).toBe(panelEl);
      expect(rec._prevPanelHtml["t.logger"]).toBe(before);

      // A committed change forces the rebuild despite the focus.
      rec._panelRefreshRequested = "t.logger";
      rec._updateActiveList();
      expect(rec._prevPanelHtml["t.logger"]).not.toBe(before);
      expect(rec._panelRefreshRequested).toBeNull();
    });
  });

  describe("locale-aware row timestamps", () => {
    test("results and flat rows format timestamps with the configured locale", () => {
      const spy = jest.spyOn(Date.prototype, "toLocaleTimeString");
      cardInstance._hass = { locale: { language: "de-DE" }, states: {} };
      const entry = {
        id: 0, timestamp: 0, level: "INFO", logger: "t.logger", message: "m",
      };

      cardInstance._resultsLineHtml(entry);
      cardInstance._appendFlatEntry(document.createElement("div"), entry);
      cardInstance._dedupMinute(0);

      expect(spy).toHaveBeenCalledWith("de-DE", expect.any(Object));
      spy.mockRestore();
    });
  });

  describe("reusable card helpers (phase 2)", () => {
    const withLocale = (locale) => {
      const rec = document.createElement("log-manager-card");
      rec._hass = { locale, states: {} };
      return rec;
    };

    test("_formatDuration formats minutes, minutes-and-seconds and seconds", () => {
      const rec = withLocale({ language: "en-GB" });
      expect(rec._formatDuration(300)).toBe("5 minutes");
      expect(rec._formatDuration(270)).toBe("4 minutes and 30 seconds");
      expect(rec._formatDuration(1)).toBe("1 second");
      expect(rec._formatDuration(60)).toBe("1 minute");
      expect(rec._formatDuration(0)).toBe("0 seconds");
    });

    test("_formatDateTime honours YMD/MDY/DMY date ordering", () => {
      const date = new Date(2023, 4, 7, 13, 5, 9);
      const ts = date.getTime() / 1000;
      const ymd = withLocale({ language: "en-GB", date_format: "YMD", time_format: "24" });
      const mdy = withLocale({ language: "en-US", date_format: "MDY", time_format: "24" });
      const dmy = withLocale({ language: "en-GB", date_format: "DMY", time_format: "24" });

      expect(ymd._formatDateTime(ts)).toMatch(/^2023[-/.]05[-/.]07 /);
      expect(mdy._formatDateTime(ts)).toMatch(/^05[-/.]07[-/.]2023 /);
      expect(dmy._formatDateTime(ts)).toMatch(/^07[-/.]05[-/.]2023 /);
    });

    test("_formatDateTime honours the 12/24-hour convention", () => {
      const date = new Date(2023, 4, 7, 13, 5, 9);
      const ts = date.getTime() / 1000;
      const h24 = withLocale({ language: "en-GB", date_format: "DMY", time_format: "24" });
      const h12 = withLocale({ language: "en-US", date_format: "MDY", time_format: "12" });

      expect(h24._formatDateTime(ts)).toContain("13:05:09");
      expect(h12._formatDateTime(ts)).toMatch(/01:05:09\s?(PM|pm)/);
    });

    test("_formatFileTimestamp is filesystem-safe", () => {
      const rec = withLocale({ language: "en-GB" });
      const stamp = rec._formatFileTimestamp(new Date(2023, 4, 7, 13, 5, 9));
      expect(stamp).toBe("2023-05-07_13-05-09");
      expect(stamp).not.toMatch(/[^0-9A-Za-z_-]/);
    });

    test("no toLocaleString remains anywhere in the card source", () => {
      expect(cardSource).not.toContain("toLocaleString");
    });

    test("_levelIndex gives ALL a real position and never -1", () => {
      const rec = withLocale({ language: "en-GB" });
      expect(rec._levelIndex("ALL")).toBe(0);
      expect(rec._levelIndex("DEBUG")).toBe(1);
      expect(rec._levelIndex("BOGUS")).toBe(-1);
    });

    test("_isMoreVerbose treats ALL as the most verbose and against ALL as never", () => {
      const rec = withLocale({ language: "en-GB" });
      expect(rec._isMoreVerbose("ALL", "DEBUG")).toBe(true);
      expect(rec._isMoreVerbose("DEBUG", "ALL")).toBe(false);
      expect(rec._isMoreVerbose("DEBUG", "INFO")).toBe(true);
      expect(rec._isMoreVerbose("INFO", "INFO")).toBe(false);
    });

    test("_entrySeverity prefers levelno and falls back to the level name", () => {
      const rec = withLocale({ language: "en-GB" });
      expect(rec._entrySeverity("INFO", 25)).toBe(25);
      expect(rec._entrySeverity("WARNING")).toBe(30);
      expect(rec._entrySeverity("CUSTOM")).toBe(-1);
    });

    test("_compareEntriesBySeverity orders by levelno with a name fallback", () => {
      const rec = withLocale({ language: "en-GB" });
      const entries = [
        { level: "ERROR", levelno: 40 },
        { level: "DEBUG", levelno: 10 },
        { level: "INFO" },
      ];
      const sorted = entries.slice().sort((a, b) => rec._compareEntriesBySeverity(a, b));
      expect(sorted.map(e => e.level)).toEqual(["DEBUG", "INFO", "ERROR"]);
    });
  });
});
