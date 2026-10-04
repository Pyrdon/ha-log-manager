import { jest } from "@jest/globals";
import {
  setupCard,
  cardSource,
  cardStylesSource,
  cardMarkupSource,
  addForm,
  recordingSetup,
  loggers,
  results,
  liveView,
  utils,
  ui,
  selection,
} from "./setup.js";

let cardInstance;

beforeAll(async () => {
  await setupCard();
  cardInstance = document.createElement("log-manager-card");
});

describe("LogManagerCard", () => {
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
      loggers.showDeleteConfirm(cardInstance, "Sure?", onConfirm, "Do it", "Go");
      expect(cardInstance._deleteDialog.style.display).toBe("flex");

      cardInstance.shadowRoot.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape" })
      );

      expect(onConfirm).not.toHaveBeenCalled();
      expect(cardInstance._deleteDialog.style.display).toBe("none");
    });

    test("the confirm button runs the confirm path with the given label", () => {
      const onConfirm = jest.fn();
      loggers.showDeleteConfirm(cardInstance, "Sure?", onConfirm, "Do it", "Go");

      expect(cardInstance.shadowRoot.querySelector(".delete-dialog-title").textContent).toBe("Do it");
      expect(cardInstance.shadowRoot.getElementById("delete-confirm-btn").textContent).toBe("Go");
      cardInstance.shadowRoot.getElementById("delete-confirm-btn").click();

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(cardInstance._deleteDialog.style.display).toBe("none");
    });

    test("the cancel button runs the cancel path", () => {
      const onCancel = jest.fn();
      loggers.showDeleteConfirm(cardInstance, "Sure?", jest.fn(), "Do it", "Go", onCancel);

      cardInstance.shadowRoot.getElementById("delete-cancel-btn").click();

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(cardInstance._deleteDialog.style.display).toBe("none");
    });

    test("Escape routes through the confirm's cancel path", () => {
      const onConfirm = jest.fn();
      const onCancel = jest.fn();
      ui.showConfirm(cardInstance, "sure?", onConfirm, { onCancel });

      cardInstance.shadowRoot.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape" })
      );

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(cardInstance._confirmDialog.style.display).toBe("none");
    });
  });

  describe("recording window wheel", () => {
    function stubLiveCard() {
      const rec = document.createElement("log-manager-card");
      rec._hass = { states: {}, callService: jest.fn(), connection: { sendMessagePromise: jest.fn() } };
      const list = document.createElement("div");
      const dialog = document.createElement("div");
      dialog.appendChild(list);
      rec._livePreview = list;
      rec._recordingLiveDialog = dialog;
      // Other controls attachLiveView wires.
      rec._liveBtn = document.createElement("button");
      rec._liveCloseBtn = document.createElement("button");
      rec._livePauseBtn = document.createElement("button");
      rec._liveLevelFilter = document.createElement("select");
      return rec;
    }

    test("forwards the wheel to the list when it overflows", () => {
      const rec = stubLiveCard();
      Object.defineProperty(rec._livePreview, "scrollHeight", { configurable: true, value: 500 });
      Object.defineProperty(rec._livePreview, "clientHeight", { configurable: true, value: 100 });
      rec._livePreview.scrollTop = 0;
      liveView.attachLiveView(rec);

      const ev = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
      const prevented = !rec._recordingLiveDialog.dispatchEvent(ev);
      expect(prevented).toBe(true);
      expect(rec._livePreview.scrollTop).toBe(40);
    });

    test("leaves the wheel to the page when the list does not overflow", () => {
      const rec = stubLiveCard();
      Object.defineProperty(rec._livePreview, "scrollHeight", { configurable: true, value: 100 });
      Object.defineProperty(rec._livePreview, "clientHeight", { configurable: true, value: 100 });
      rec._livePreview.scrollTop = 0;
      liveView.attachLiveView(rec);

      const ev = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
      const prevented = !rec._recordingLiveDialog.dispatchEvent(ev);
      expect(prevented).toBe(false);
      expect(rec._livePreview.scrollTop).toBe(0);
    });

    test("leaves the wheel over the logger picker to the picker", () => {
      const rec = stubLiveCard();
      Object.defineProperty(rec._livePreview, "scrollHeight", { configurable: true, value: 500 });
      Object.defineProperty(rec._livePreview, "clientHeight", { configurable: true, value: 100 });
      rec._livePreview.scrollTop = 0;
      liveView.attachLiveView(rec);

      const picker = document.createElement("div");
      picker.className = "logger-filter";
      const pickerList = document.createElement("div");
      pickerList.className = "logger-filter-list";
      picker.appendChild(pickerList);
      rec._recordingLiveDialog.appendChild(picker);

      const ev = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
      const prevented = !pickerList.dispatchEvent(ev);
      expect(prevented).toBe(false);
      expect(rec._livePreview.scrollTop).toBe(0);
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

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test("offers the five named levels behind a non-level Set all placeholder", () => {
      const options = Array.from(rec._setAllLevel.querySelectorAll("option")).map(o => o.value);
      expect(options).toEqual(["", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);
      // The control starts on the placeholder, not on a real level.
      expect(rec._setAllLevel.value).toBe("");
    });

    test("has no Apply button; the level select drives the action", () => {
      expect(rec.shadowRoot.getElementById("set-all-apply")).toBeNull();
      expect(rec._setAllLevel).not.toBeNull();
    });

    test("applies through the batched set_levels command after confirmation", () => {
      rec._setAllLevel.value = "WARNING";
      // Auto-confirm: run the confirm callback immediately.
      jest.spyOn(ui, "showConfirm").mockImplementation((card, message, onConfirm) => onConfirm());

      recordingSetup.applySetAll(rec, "WARNING");

      expect(rec._hass.connection.sendMessagePromise).toHaveBeenCalledWith({
        type: "log_manager/set_levels",
        level: "WARNING",
      });
    });

    test("returns to the placeholder after a confirmed apply, so the same level can be re-picked", async () => {
      rec._setAllLevel.value = "WARNING";
      jest.spyOn(ui, "showConfirm").mockImplementation((card, message, onConfirm) => onConfirm());

      recordingSetup.applySetAll(rec, "WARNING");
      await Promise.resolve();
      await Promise.resolve();

      expect(rec._setAllLevel.value).toBe("");
    });

    test("no-ops while a recording is active (Set all lock, item 10)", () => {
      rec._recordingState = "recording";
      rec._setAllLevel.value = "WARNING";
      const confirmSpy = jest.spyOn(ui, "showConfirm").mockImplementation(() => {});

      recordingSetup.applySetAll(rec, "WARNING");

      const called = rec._hass.connection.sendMessagePromise.mock.calls
        .some(([msg]) => msg && msg.type === "log_manager/set_levels");
      expect(called).toBe(false);
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    test("does not call the command when the confirmation is cancelled", () => {
      rec._setAllLevel.value = "DEBUG";
      jest.spyOn(ui, "showConfirm").mockImplementation((card, message, onConfirm, opts) => {
        opts && opts.onCancel && opts.onCancel();
      });

      recordingSetup.applySetAll(rec, "DEBUG");

      const called = rec._hass.connection.sendMessagePromise.mock.calls
        .some(([msg]) => msg && msg.type === "log_manager/set_levels");
      expect(called).toBe(false);
      // Cancelling returns the control to the placeholder.
      expect(rec._setAllLevel.value).toBe("");
    });

    test("routes a partial result to the non-destructive notice", async () => {
      rec._setAllLevel.value = "WARNING";
      rec._hass.connection.sendMessagePromise = jest.fn(() => Promise.resolve({ changed: 2, skipped: 1 }));
      jest.spyOn(ui, "showConfirm").mockImplementation((card, message, onConfirm) => onConfirm());
      const deleteSpy = jest.spyOn(loggers, "showDeleteConfirm").mockImplementation(() => {});
      const noticeSpy = jest.spyOn(ui, "showNotice").mockImplementation(() => {});

      recordingSetup.applySetAll(rec, "WARNING");
      await Promise.resolve();
      await Promise.resolve();

      expect(noticeSpy).toHaveBeenCalledTimes(1);
      expect(noticeSpy.mock.calls[0][1]).toBe("2 loggers updated; 1 pinned logger skipped.");
      expect(noticeSpy.mock.calls[0][2]).toEqual({ title: "Set all levels" });
      expect(deleteSpy).not.toHaveBeenCalled();
      noticeSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    test("routes a failure to the non-destructive notice and resets the control", async () => {
      rec._setAllLevel.value = "WARNING";
      rec._hass.connection.sendMessagePromise = jest.fn(() => Promise.reject(new Error("boom")));
      jest.spyOn(ui, "showConfirm").mockImplementation((card, message, onConfirm) => onConfirm());
      jest.spyOn(console, "error").mockImplementation(() => {});
      const deleteSpy = jest.spyOn(loggers, "showDeleteConfirm").mockImplementation(() => {});
      const noticeSpy = jest.spyOn(ui, "showNotice").mockImplementation(() => {});

      recordingSetup.applySetAll(rec, "WARNING");
      await Promise.resolve();
      await Promise.resolve();

      expect(noticeSpy).toHaveBeenCalledTimes(1);
      expect(noticeSpy.mock.calls[0][1]).toBe("Couldn't set all levels.");
      expect(rec._setAllLevel.value).toBe("");
      expect(deleteSpy).not.toHaveBeenCalled();
      noticeSpy.mockRestore();
      deleteSpy.mockRestore();
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
      const html = loggers.renderLogPanelHtml(cardInstance, "t.logger");
      expect(html).not.toContain("sensor-enabled-toggle");
      expect(cardInstance._attachSensorHandler).toBeUndefined();
    });
  });

























  describe("locale-aware row timestamps", () => {
    test("results and flat rows format timestamps through the locale-aware helper", () => {
      cardInstance._hass = { locale: { language: "de-DE", time_format: "24" }, states: {} };
      const clockSpy = jest.spyOn(utils, "formatClockTime");
      const entry = {
        id: 0, timestamp: 0, level: "INFO", logger: "t.logger", message: "m",
      };

      results.resultsLineHtml(cardInstance, entry);
      liveView.appendFlatEntry(cardInstance, document.createElement("div"), entry);

      expect(clockSpy).toHaveBeenCalledWith(entry.timestamp, cardInstance._hass);
      clockSpy.mockRestore();
    });

    test("formatClockTime honours the 12/24-hour convention", () => {
      const ts = new Date(2023, 4, 7, 13, 5, 9).getTime() / 1000;
      expect(utils.formatClockTime(ts, { locale: { language: "en-GB", time_format: "24" } }))
        .toContain("13:05:09");
      expect(utils.formatClockTime(ts, { locale: { language: "en-US", time_format: "12" } }))
        .toMatch(/01:05:09\s?(PM|pm)/);
    });
  });

  describe("reusable card helpers (phase 2)", () => {
    const withLocale = (locale) => {
      const rec = document.createElement("log-manager-card");
      rec._hass = { locale, states: {} };
      return rec;
    };

    test("no toLocaleString remains anywhere in the card source", () => {
      expect(cardSource).not.toContain("toLocaleString");
      expect(cardStylesSource).not.toContain("toLocaleString");
      expect(cardMarkupSource).not.toContain("toLocaleString");
    });

  });

  describe("copy shortcut (item 12)", () => {
    const buildCard = () => {
      const rec = document.createElement("log-manager-card");
      const mockRoot = document.createElement("div");
      mockRoot.getElementById = function (id) { return this.querySelector(`#${id}`); };
      rec.shadowRoot = mockRoot;
      rec._hass = { states: {}, connection: { sendMessagePromise: jest.fn() }, callService: jest.fn() };
      rec._buildUI();
      return rec;
    };

    test("Ctrl+C copies the selected buffer entries when a selection resolves", async () => {
      const rec = buildCard();
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const entry = { id: 0, timestamp: 1, level: "INFO", logger: "t.logger", message: "m", source: "" };
      rec._recordingBuffer = [entry];
      rec._selectedKeys = new Set([selection.entryKey(rec, entry)]);

      const ev = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
      rec.shadowRoot.dispatchEvent(ev);

      expect(ev.defaultPrevented).toBe(true);
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0][0]).toContain("t.logger");
    });

    test("Ctrl+C falls through to native copy when nothing is selected", () => {
      const rec = buildCard();
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      rec._selectedKeys = new Set();

      const ev = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
      rec.shadowRoot.dispatchEvent(ev);

      expect(writeText).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    });

    test("Ctrl+C is ignored while a text input is focused", () => {
      const rec = buildCard();
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const entry = { id: 0, timestamp: 1, level: "INFO", logger: "t.logger", message: "m", source: "" };
      rec._recordingBuffer = [entry];
      rec._selectedKeys = new Set([selection.entryKey(rec, entry)]);

      const input = rec.shadowRoot.querySelector("#path-input");
      Object.defineProperty(rec.shadowRoot, "activeElement", { configurable: true, value: input });
      const ev = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
      rec.shadowRoot.dispatchEvent(ev);

      expect(writeText).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    });
  });

  describe("post-load paint", () => {
    test("assigning hass twice after the graph resolves builds the UI", async () => {
      const card = document.createElement("log-manager-card");
      const hass = {
        states: {},
        connection: { sendMessagePromise: jest.fn(() => Promise.resolve([])) },
        locale: { language: "en" },
      };
      expect(() => {
        card.hass = hass;
        card.hass = hass;
      }).not.toThrow();

      await Promise.resolve();
      await new Promise((resolve) => global.requestAnimationFrame(resolve));

      expect(card._uiBuilt).toBe(true);
      expect(card.shadowRoot.getElementById("live-btn")).not.toBeNull();
    });
  });
});
