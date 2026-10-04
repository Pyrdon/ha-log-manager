import { jest } from "@jest/globals";
import { setupCard, cardStylesSource, addForm, utils } from "./setup.js";

// Module-direct tests for card-add-form.js. The element instance supplies the
// add/edit form state; the concern functions own the behaviour.

let cardInstance;

beforeAll(async () => {
  await setupCard();
  cardInstance = document.createElement("log-manager-card");
});

describe("card-add-form", () => {
  describe("sessionStorage persistence", () => {
    beforeEach(() => {
      sessionStorage.clear();
    });

    test("persistState writes to sessionStorage", () => {
      cardInstance._pathInput = { value: "test.path" };
      cardInstance._friendlyNameInput = { value: "Test Name" };

      addForm.persistState(cardInstance);

      expect(sessionStorage.getItem("logManagerPath")).toBe("test.path");
      expect(sessionStorage.getItem("logManagerName")).toBe("Test Name");
    });

    test("clearState removes sessionStorage items", () => {
      cardInstance._pathInput = { value: "existing.path" };
      cardInstance._friendlyNameInput = { value: "Existing" };

      sessionStorage.setItem("logManagerPath", "existing.path");
      sessionStorage.setItem("logManagerName", "Existing");

      addForm.clearState(cardInstance);

      expect(sessionStorage.getItem("logManagerPath")).toBeNull();
      expect(sessionStorage.getItem("logManagerName")).toBeNull();
      expect(cardInstance._pathInput.value).toBe("");
      expect(cardInstance._friendlyNameInput.value).toBe("");
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
      addForm.renderDropdown(rec);
    });

    test("ranks an exact substring match first", () => {
      addForm.filterDropdown(rec, "pyscript.file");
      expect(visible()[0]).toBe("pyscript.file");
    });

    test("finds pyscript.file from a separator-less query", () => {
      addForm.filterDropdown(rec, "pyscriptfile");
      expect(visible()).toContain("pyscriptfile");
      expect(visible()).toContain("pyscript.file");
    });
  });

  describe("fuzzy highlight readability", () => {
    test("highlighted options keep their text colour and fuzzy hits stand out", () => {
      const highlightRule = cardStylesSource.match(/\.option-item\.highlight\s*\{([^}]*)\}/);
      expect(highlightRule).not.toBeNull();
      expect(highlightRule[1]).not.toContain("color:");
      const fuzzyRule = cardStylesSource.match(/\.fuzzy-hit\s*\{([^}]*)\}/);
      expect(fuzzyRule).not.toBeNull();
      expect(fuzzyRule[1]).toContain("text-decoration: underline");
      expect(fuzzyRule[1]).toContain("background");
      expect(fuzzyRule[1]).toContain("color: var(--primary-color)");
    });

    test("highlightMatch wraps matched characters in the fuzzy-hit class", () => {
      const html = addForm.highlightMatch(cardInstance, "pyscript.file", "pys");
      expect(html).toContain('class="fuzzy-hit"');
    });

    test("tintConfigurePane colours the pane then clears it", () => {
      const card = document.createElement("log-manager-card");
      const wrapper = document.createElement("div");
      const pane = document.createElement("div");
      pane.className = "add-section";
      wrapper.appendChild(pane);
      card._addSectionWrapper = wrapper;

      addForm.tintConfigurePane(card, "ERROR");
      expect(pane.style.borderLeft).toContain(utils.levelColors("ERROR").color);
      expect(pane.style.background).not.toBe("");

      addForm.tintConfigurePane(card, null);
      expect(pane.style.borderLeft).toBe("");
      expect(pane.style.background).toBe("");
    });

    test("tintConfigurePane tolerates a missing pane", () => {
      const card = document.createElement("log-manager-card");
      card._addSectionWrapper = document.createElement("div");
      expect(() => addForm.tintConfigurePane(card, "INFO")).not.toThrow();
    });
  });

  describe("managed row level options (item 2)", () => {
    test("NOTSET renders as 'Not set' while keeping its value", () => {
      const rec = document.createElement("log-manager-card");
      const options = ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];
      rec._hass = {
        states: {
          "select.t": { state: "NOTSET", attributes: { logger_name: "t.logger", friendly_name: "T", options } },
        },
        callService: jest.fn(),
      };
      rec._counters = {};
      rec._prevRowStates = {};
      rec._activeList = document.createElement("div");
      rec._recordingState = null;
      rec._recordingLoggers = [];
      rec._recordingCounts = {};
      rec._recordingLevelOverrides = {};
      rec._recordingRestoreLevels = {};
      rec._expandedLogger = null;

      addForm.updateActiveList(rec);

      const notset = rec._activeList.querySelector('.level-select option[value="NOTSET"]');
      expect(notset).not.toBeNull();
      expect(notset.textContent).toBe("Not set");
    });
  });

  describe("shared bulk-control disabled rule (items 3 + 10)", () => {
    const mk = (hasLoggers, recordingState) => {
      const rec = document.createElement("log-manager-card");
      rec._hass = { states: hasLoggers ? { "select.t": { attributes: { logger_name: "t.logger" } } } : {} };
      rec._recordingState = recordingState;
      rec._setAllLevel = { disabled: null, title: "" };
      rec._setAllDefaultTitle = "Set all levels";
      rec._recordBtn = { disabled: null, title: "" };
      return rec;
    };

    test("truth table: managed loggers x recording state", () => {
      const cases = [
        { hasLoggers: true, state: null, setAll: false, record: false },
        { hasLoggers: true, state: "recording", setAll: true, record: false },
        { hasLoggers: true, state: "stopping", setAll: true, record: false },
        { hasLoggers: false, state: null, setAll: true, record: true },
        // A recording keeps Record enabled as the stop control even with no
        // managed loggers.
        { hasLoggers: false, state: "recording", setAll: true, record: false },
        // A finished recording keeps Record enabled to reopen its results.
        { hasLoggers: false, state: "completed", setAll: true, record: false },
        { hasLoggers: false, state: "results", setAll: true, record: false },
      ];
      for (const c of cases) {
        const rec = mk(c.hasLoggers, c.state);
        addForm.refreshSetupControls(rec);
        const label = `loggers=${c.hasLoggers} state=${c.state}`;
        expect([label, rec._setAllLevel.disabled]).toEqual([label, c.setAll]);
        expect([label, rec._recordBtn.disabled]).toEqual([label, c.record]);
      }
    });

    test("bulk controls show a disabled hint and restore their defaults", () => {
      const recording = mk(true, "recording");
      addForm.refreshSetupControls(recording);
      expect(recording._setAllLevel.title).toBe("Set all is unavailable while a recording is active.");

      const empty = mk(false, null);
      addForm.refreshSetupControls(empty);
      expect(empty._setAllLevel.title).toBe("Add a logger to use Set all.");
      expect(empty._setAllLevel.disabled).toBe(true);
      expect(empty._recordBtn.title).toBe("Add at least one logger to record log events.");

      // Idle with loggers restores the captured markup default.
      const idle = mk(true, null);
      addForm.refreshSetupControls(idle);
      expect(idle._setAllLevel.title).toBe("Set all levels");
      expect(idle._setAllLevel.disabled).toBe(false);

      // A completed recording with zero loggers leaves Record enabled.
      const completed = mk(false, "completed");
      addForm.refreshSetupControls(completed);
      expect(completed._recordBtn.disabled).toBe(false);
    });

    test("updateActiveList drives the same rule for the empty state", () => {
      const rec = mk(false, null);
      rec._counters = {};
      rec._prevRowStates = {};
      rec._recordingLoggers = [];
      rec._recordingCounts = {};
      rec._activeList = document.createElement("div");
      addForm.updateActiveList(rec);
      expect(rec._setAllLevel.disabled).toBe(true);
      expect(rec._recordBtn.disabled).toBe(true);
    });
  });

  describe("reactive configure-pane retint (item 2)", () => {
    test("a level change repaints an open, edited pane", () => {
      const card = document.createElement("log-manager-card");
      const editor = document.createElement("div");
      editor.className = "add-section";
      const wrapper = document.createElement("div");
      wrapper.appendChild(editor);
      card._addSectionWrapper = wrapper;
      card._isAddSectionVisible = true;
      card._editingPath = "t.logger";

      addForm.tintConfigurePane(card, "INFO");
      expect(editor.style.borderLeft).toContain(utils.levelColors("INFO").color);

      // A later level change is handled by updateActiveList's else-branch; call
      // tintConfigurePane with the new level as the reactive path does.
      addForm.tintConfigurePane(card, "ERROR");
      expect(editor.style.borderLeft).toContain(utils.levelColors("ERROR").color);
      expect(editor.style.background).not.toBe("");
    });
  });
});
