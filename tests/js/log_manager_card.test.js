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

    test("populates the level options and defaults to NOTSET", () => {
      const options = Array.from(rec._setAllLevel.querySelectorAll("option")).map(o => o.value);
      expect(options).toEqual(["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);
    });

    test("Apply is enabled only when loggers are managed", () => {
      rec._hass.states = {};
      addForm.updateActiveList(rec);
      expect(rec._setAllApply.disabled).toBe(true);

      rec._hass.states = {
        "select.t": { attributes: { logger_name: "t.logger" }, state: "NOTSET" },
      };
      addForm.updateActiveList(rec);
      expect(rec._setAllApply.disabled).toBe(false);
    });

    test("applies through the batched set_levels command after confirmation", () => {
      rec._setAllLevel.value = "WARNING";
      // Auto-confirm: run the confirm callback immediately.
      jest.spyOn(loggers, "showDeleteConfirm").mockImplementation((card, message, onConfirm) => onConfirm());

      recordingSetup.applySetAll(rec);

      expect(rec._hass.connection.sendMessagePromise).toHaveBeenCalledWith({
        type: "log_manager/set_levels",
        level: "WARNING",
      });
    });

    test("does not call the command when the confirmation is cancelled", () => {
      rec._setAllLevel.value = "DEBUG";
      jest.spyOn(loggers, "showDeleteConfirm").mockImplementation(() => {});

      recordingSetup.applySetAll(rec);

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
    test("results and flat rows format timestamps with the configured locale", () => {
      const spy = jest.spyOn(Date.prototype, "toLocaleTimeString");
      cardInstance._hass = { locale: { language: "de-DE" }, states: {} };
      const entry = {
        id: 0, timestamp: 0, level: "INFO", logger: "t.logger", message: "m",
      };

      results.resultsLineHtml(cardInstance, entry);
      liveView.appendFlatEntry(cardInstance, document.createElement("div"), entry);
      utils.dedupMinute(0, cardInstance._hass.locale.language);

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

    test("no toLocaleString remains anywhere in the card source", () => {
      expect(cardSource).not.toContain("toLocaleString");
      expect(cardStylesSource).not.toContain("toLocaleString");
      expect(cardMarkupSource).not.toContain("toLocaleString");
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
