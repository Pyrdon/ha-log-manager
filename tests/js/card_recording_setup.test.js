import { jest } from "@jest/globals";
import { setupCard, cardSource, cardStylesSource, cardMarkupSource, recordingSetup, recordingSession, loggers } from "./setup.js";

let cardInstance;

beforeAll(async () => {
  await setupCard();
  cardInstance = document.createElement("log-manager-card");
});

describe("LogManagerCard", () => {
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

    test("offers the ALL + named capture set and preselects ALL for an unset logger", () => {
      recordingSetup.openRecordingSetup(rec);

      const options = Array.from(
        rec._loggerChecklist.querySelectorAll(".recording-level-select option")
      ).map((o) => o.value);
      expect(options).toEqual(["ALL", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);
      expect(options).not.toContain("NOTSET");

      const select = rec._loggerChecklist.querySelector(".recording-level-select");
      expect(select.value).toBe("ALL");
      const allOption = rec._loggerChecklist.querySelector('.recording-level-select option[value="ALL"]');
      expect(allOption.textContent).toContain("All levels");
      expect(allOption.title).toContain("everything");
    });

    test("preselects the current level for a non-NOTSET logger", () => {
      rec._hass.states["select.test_logger"].state = "WARNING";
      recordingSetup.openRecordingSetup(rec);

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
      recordingSetup.openRecordingSetup(rec);
    });

    test("loads profiles into the select on open", async () => {
      expect(rec._hass.connection.sendMessagePromise).toHaveBeenCalledWith({
        type: "log_manager/profiles_get",
      });
      await Promise.resolve();
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        profiles: [{ name: "p1", loggers: [], level_overrides: {}, max_duration: 60 }],
      });
      recordingSetup.loadProfiles(rec);
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
      recordingSetup.applyProfile(rec, "p1");
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

    test("applying a profile whose override is ALL does not prompt to raise", async () => {
      rec._hass.states["select.test_logger"].entity_id = "select.test_logger";
      rec._hass.states["select.test_logger"].state = "INFO";
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({
        profiles: [{
          name: "p1",
          loggers: ["test.logger"],
          level_overrides: { "test.logger": "ALL" },
          max_duration: 60,
        }],
      });
      const promptSpy = jest.spyOn(recordingSession, "promptRaiseSequence").mockImplementation(() => {});
      recordingSetup.applyProfile(rec, "p1");
      await Promise.resolve();
      await Promise.resolve();

      // ALL is a capture sentinel, not a settable logger level: no raise.
      expect(promptSpy).toHaveBeenCalledWith(rec, []);
      promptSpy.mockRestore();
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
      recordingSetup.applyProfile(rec, "p1");
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
      jest.spyOn(recordingSetup, "collectRecordingExcludes")
        .mockReturnValue({ "test.logger": ["test.logger.noisy"] });
      rec._profiles = [];
      rec._profileNameInput.value = "p1";
      jest.spyOn(recordingSetup, "sendProfileSave").mockImplementation(() => {});

      recordingSetup.saveProfile(rec);

      expect(recordingSetup.sendProfileSave).toHaveBeenCalledWith(
        rec,
        "p1",
        ["test.logger"],
        { "test.logger": "DEBUG" },
        { "test.logger": ["test.logger.noisy"] }
      );
      recordingSetup.collectRecordingExcludes.mockRestore();
      recordingSetup.sendProfileSave.mockRestore();
    });

    test("a retained profile is applied when the setup re-opens", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValue({
        profiles: [{ name: "p1", loggers: ["test.logger"], level_overrides: {}, max_duration: 60 }],
      });
      // First render populates the options; the retained value applies on re-open.
      recordingSetup.renderProfileOptions(rec, [{ name: "p1" }]);
      rec._profileSelect.value = "p1";
      recordingSetup.renderProfileOptions(rec, [{ name: "p1" }]);
      await Promise.resolve();
      await Promise.resolve();
      const cb = rec._loggerChecklist.querySelector("input[data-logger='test.logger']");
      expect(cb.checked).toBe(true);
    });

    test("no profiles disables the selector and shows a placeholder", () => {
      recordingSetup.renderProfileOptions(rec, []);
      expect(rec._profileSelect.disabled).toBe(true);
      expect(rec._profileSelect.innerHTML).toContain("No profiles yet");
    });

    test("with profiles there is no None option and the shown profile is applied", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValue({
        profiles: [{ name: "p1", loggers: ["test.logger"], level_overrides: {}, max_duration: 60 }],
      });
      recordingSetup.renderProfileOptions(rec, [{ name: "p1" }]);
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
      jest.spyOn(recordingSetup, "collectRecordingExcludes")
        .mockReturnValue({ "test.logger": ["test.logger.noisy"] });
      rec._hass.connection.sendMessagePromise.mockResolvedValueOnce({ profiles: [] });

      recordingSetup.saveProfile(rec);
      await Promise.resolve();

      expect(rec._hass.connection.sendMessagePromise).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "log_manager/profile_save",
          name: "p1",
          loggers: ["test.logger"],
          excludes: { "test.logger": ["test.logger.noisy"] },
        })
      );
      recordingSetup.collectRecordingExcludes.mockRestore();
    });

    test("editing settings marks the shown profile as modified", async () => {
      rec._hass.connection.sendMessagePromise.mockResolvedValue({
        profiles: [{ name: "p1", loggers: ["test.logger"], level_overrides: {}, max_duration: 60 }],
      });
      recordingSetup.renderProfileOptions(rec, [{ name: "p1" }], "p1");
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
      recordingSetup.renderProfileOptions(rec, [{ name: "p1" }], "p1");
      await Promise.resolve();
      await Promise.resolve();

      const cb = rec._loggerChecklist.querySelector("input[data-logger='other.logger']");
      cb.checked = true;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
      expect(rec._profileDirty).toBe(true);

      jest.spyOn(loggers, "showDeleteConfirm").mockImplementation((card, message, onConfirm) => onConfirm());
      rec._profileSelect.value = "p1";
      recordingSetup.onProfileSelectChange(rec);
      await Promise.resolve();
      await Promise.resolve();

      expect(loggers.showDeleteConfirm).toHaveBeenCalled();
      expect(rec._profileDirty).toBe(false);
      expect(rec._profileSelect.value).toBe("p1");
      expect(cb.checked).toBe(false);
      loggers.showDeleteConfirm.mockRestore();
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
      recordingSetup.openRecordingSetup(rec);

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

    test("clicking another row closes an open area, but clicks inside it do not (delegated, item 15)", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.a": { attributes: { logger_name: "a.logger", friendly_name: "A" }, state: "INFO" },
          "select.b": { attributes: { logger_name: "b.logger", friendly_name: "B" }, state: "INFO" },
        },
        connection: { sendMessagePromise: jest.fn(() => Promise.resolve({ profiles: [] })) },
      };
      rec._loggerChecklist = document.createElement("div");
      rec._recordingSetupDialog = document.createElement("div");
      rec._recordingSetupStart = document.createElement("button");
      rec._recordingSetupStart.disabled = false;
      // The delegated listener lives in attachRecordingSetup, not open.
      rec._recordingSetupCancel = document.createElement("button");
      const stubBtn = () => document.createElement("button");
      rec._profileSelect = document.createElement("select");
      rec._profileSaveBtn = stubBtn();
      rec._profileSaveNewBtn = stubBtn();
      rec._profileAbortBtn = stubBtn();
      rec._profileConfirmBtn = stubBtn();
      rec._profileDeleteBtn = stubBtn();
      rec._profileSaveRow = document.createElement("div");
      rec._profileRow = document.createElement("div");
      rec._profileNameInput = document.createElement("input");
      recordingSetup.attachRecordingSetup(rec);
      recordingSetup.openRecordingSetup(rec);

      rec._loggerChecklist
        .querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)")
        .forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); });

      const toggles = rec._loggerChecklist.querySelectorAll(".exclude-toggle");
      const areas = rec._loggerChecklist.querySelectorAll(".exclude-area");
      toggles[0].click();
      expect(areas[0].style.display).toBe("block");

      // A click inside the open area (the input) must not close it.
      const inp = areas[0].querySelector(".exclude-input");
      inp.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(areas[0].style.display).toBe("block");

      // A click on the other row closes it and resets the toggle label.
      const otherLabel = areas[1].closest(".checklist-item").querySelector(".logger-label");
      otherLabel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(areas[0].style.display).toBe("none");
      expect(toggles[0].textContent).toBe("+ exclusions");
    });

    test("clicking outside an open editor collapses the field and resets the toggle", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.a": { attributes: { logger_name: "a.logger", friendly_name: "A" }, state: "INFO" },
        },
        connection: { sendMessagePromise: jest.fn(() => Promise.resolve({ profiles: [] })) },
      };
      rec._loggerChecklist = document.createElement("div");
      rec._recordingSetupDialog = document.createElement("div");
      // Production nests the checklist inside the dialog; the dialog listener
      // catches clicks outside the checklist.
      rec._recordingSetupDialog.appendChild(rec._loggerChecklist);
      rec._recordingSetupStart = document.createElement("button");
      rec._recordingSetupStart.disabled = false;
      rec._recordingSetupCancel = document.createElement("button");
      const stubBtn = () => document.createElement("button");
      rec._profileSelect = document.createElement("select");
      rec._profileSaveBtn = stubBtn();
      rec._profileSaveNewBtn = stubBtn();
      rec._profileAbortBtn = stubBtn();
      rec._profileConfirmBtn = stubBtn();
      rec._profileDeleteBtn = stubBtn();
      rec._profileSaveRow = document.createElement("div");
      rec._profileRow = document.createElement("div");
      rec._profileNameInput = document.createElement("input");
      recordingSetup.attachRecordingSetup(rec);
      recordingSetup.openRecordingSetup(rec);

      const cb = rec._loggerChecklist.querySelector("input[type='checkbox']:not(#select-all-checkbox)");
      cb.checked = true;
      cb.dispatchEvent(new Event("change", { bubbles: true }));

      const toggle = rec._loggerChecklist.querySelector(".exclude-toggle");
      const area = rec._loggerChecklist.querySelector(".exclude-area");
      const inp = area.querySelector(".exclude-input");
      toggle.click();
      expect(area.style.display).toBe("block");
      inp.value = "a.";
      inp.dispatchEvent(new Event("input", { bubbles: true }));

      // A click elsewhere in the dialog is outside the editor.
      const elsewhere = document.createElement("div");
      rec._recordingSetupDialog.appendChild(elsewhere);
      elsewhere.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(area.style.display).toBe("none");
      expect(toggle.textContent).toBe("+ exclusions");
      expect(inp.value).toBe("");
    });

    test("removing a chip leaves another row's open editor open", () => {
      const rec = document.createElement("log-manager-card");
      rec._hass = {
        states: {
          "select.a": { attributes: { logger_name: "a.logger", friendly_name: "A" }, state: "INFO" },
          "select.b": { attributes: { logger_name: "b.logger", friendly_name: "B" }, state: "INFO" },
        },
        connection: { sendMessagePromise: jest.fn(() => Promise.resolve({ profiles: [] })) },
      };
      rec._loggerChecklist = document.createElement("div");
      rec._recordingSetupDialog = document.createElement("div");
      rec._recordingSetupStart = document.createElement("button");
      rec._recordingSetupStart.disabled = false;
      rec._recordingSetupCancel = document.createElement("button");
      const stubBtn = () => document.createElement("button");
      rec._profileSelect = document.createElement("select");
      rec._profileSaveBtn = stubBtn();
      rec._profileSaveNewBtn = stubBtn();
      rec._profileAbortBtn = stubBtn();
      rec._profileConfirmBtn = stubBtn();
      rec._profileDeleteBtn = stubBtn();
      rec._profileSaveRow = document.createElement("div");
      rec._profileRow = document.createElement("div");
      rec._profileNameInput = document.createElement("input");
      recordingSetup.attachRecordingSetup(rec);
      recordingSetup.openRecordingSetup(rec);

      rec._loggerChecklist
        .querySelectorAll("input[type='checkbox']:not(#select-all-checkbox)")
        .forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); });

      const areas = rec._loggerChecklist.querySelectorAll(".exclude-area");
      rec._loggerChecklist.querySelectorAll(".exclude-toggle")[1].click();
      expect(areas[1].style.display).toBe("block");

      // Add then remove a chip in row A: the delegated close listener must
      // ignore the chips line, so row B's editor stays open.
      const inpA = areas[0].querySelector(".exclude-input");
      inpA.value = "a.logger.noisy";
      inpA.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      areas[0].closest(".checklist-item").querySelector(".exclude-chip-remove").click();
      expect(areas[1].style.display).toBe("block");
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
      recordingSetup.openRecordingSetup(rec);
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

      expect(recordingSetup.collectRecordingExcludes(rec)).toEqual({
        "test.logger": ["test.logger.noisy"],
      });
    });

    test("chips render in the always-visible line with a relative label and full-path title (item 1)", () => {
      const inp = rec._loggerChecklist.querySelector(".exclude-input");
      const item = inp.closest(".checklist-item");
      const chips = item.querySelector(".exclude-chips");
      // The chips line lives outside the collapsible area and exists up front.
      expect(chips).not.toBeNull();
      expect(chips.closest(".exclude-area")).toBeNull();
      expect(item.querySelector(".exclude-area").style.display).toBe("none");

      inp.value = "test.logger.noisy";
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      const chip = chips.querySelector(".exclude-chip");
      expect(chip).not.toBeNull();
      expect(chip.dataset.path).toBe("test.logger.noisy");
      // The visible label is the path relative to the parent logger; the full
      // path is available on hover.
      expect(chip.querySelector("span").textContent).toBe("noisy");
      expect(chip.querySelector("span").title).toBe("test.logger.noisy");
      // The legacy "Excluded:" summary text is gone.
      expect(item.querySelector(".exclude-summary")).toBeNull();
    });

    test("the exclusions button stays on the logger row when a chip is added", () => {
      const inp = rec._loggerChecklist.querySelector(".exclude-input");
      const item = inp.closest(".checklist-item");
      const toggle = item.querySelector(".exclude-toggle");
      const select = item.querySelector(".recording-level-select");
      expect(toggle.previousElementSibling).toBe(select);

      inp.value = "test.logger.noisy";
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      // Same node, still directly after the recording-level select: the chips
      // line is a separate full-width row, so it never displaces the button.
      expect(item.querySelector(".exclude-toggle")).toBe(toggle);
      expect(toggle.previousElementSibling).toBe(select);
    });

    test("removing a chip updates the always-visible line", () => {
      const inp = rec._loggerChecklist.querySelector(".exclude-input");
      const item = inp.closest(".checklist-item");
      inp.value = "test.logger.noisy";
      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(item.querySelectorAll(".exclude-chip").length).toBe(1);

      item.querySelector(".exclude-chip-remove").click();
      expect(item.querySelectorAll(".exclude-chip").length).toBe(0);
    });

    test("restoring profile chips repopulates the always-visible line", () => {
      const item = rec._loggerChecklist.querySelector(".checklist-item");
      recordingSetup.setExcludeChips(rec, item, "test.logger", ["test.logger.a", "test.logger.b"]);
      const chips = item.querySelector(".exclude-chips").querySelectorAll(".exclude-chip");
      expect(chips.length).toBe(2);
      expect(Array.from(chips).map(c => c.querySelector("span").textContent)).toEqual(["a", "b"]);

      recordingSetup.setExcludeChips(rec, item, "test.logger", []);
      expect(item.querySelectorAll(".exclude-chip").length).toBe(0);
    });

    test("excludeRelativeLabel strips the parent logger prefix", () => {
      expect(recordingSetup.excludeRelativeLabel("a.logger", "a.logger.noisy.child")).toBe("noisy.child");
      expect(recordingSetup.excludeRelativeLabel("a.logger", "other.path")).toBe("other.path");
    });

    test("suggestion rows show the relative label but carry the full path", () => {
      rec._availableLoggers = ["test.logger.noisy.child", "test.logger.other"];
      const inp = rec._loggerChecklist.querySelector(".exclude-input");
      recordingSetup.showExcludeSuggestions(rec, inp);
      const options = inp.parentElement.querySelectorAll(".option-item");
      expect(options.length).toBe(2);
      // The visible label is the path relative to the parent logger; the full
      // path stays on data-path so the chip keeps the absolute value.
      expect(options[0].dataset.path).toBe("test.logger.noisy.child");
      expect(options[0].textContent).toBe("noisy.child");
    });

    test("adding a suggestion keeps the remaining suggestions visible", () => {
      rec._availableLoggers = ["test.logger.noisy", "test.logger.other"];
      const inp = rec._loggerChecklist.querySelector(".exclude-input");
      const box = inp.parentElement.querySelector(".exclude-options");
      recordingSetup.showExcludeSuggestions(rec, inp);
      box.querySelector(".option-item").dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true })
      );
      // The chosen path became a chip; the box re-shows the remainder.
      expect(rec._loggerChecklist.querySelectorAll(".exclude-chip").length).toBe(1);
      expect(box.style.display).toBe("block");
      expect(box.querySelectorAll(".option-item").length).toBe(1);
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
      recordingSetup.openRecordingSetup(rec);

      const row = rec._loggerChecklist.querySelector(".select-all-row");
      expect(row.tagName).toBe("LABEL");
      expect(row.getAttribute("for")).toBe("select-all-checkbox");
    });

    test("uses a moderate dialog width and a growth-friendly checklist", () => {
      expect(cardStylesSource).toMatch(/\.dialog-box\.recording-setup-box\s*\{[^}]*max-width:\s*580px/);
      // The checklist grows instead of scrolling internally; the dialog's own
      // scroll handles overflow so exclusion dropdowns are not clipped.
      const rule = cardStylesSource.match(/\.logger-checklist\s*\{([^}]*)\}/);
      expect(rule).not.toBeNull();
      expect(rule[1]).not.toContain("max-height");
      expect(rule[1]).not.toContain("overflow-y");
      expect(cardMarkupSource).toContain('class="dialog-box recording-setup-box"');
    });

    test("expanded group items are dimmed more", () => {
      expect(cardStylesSource).toMatch(/\.log-preview-group-item\s*\{[^}]*opacity:\s*0\.4/);
    });

    test("exclusion chips stack and the column resize handle is visible", () => {
      const chips = cardStylesSource.match(/\.exclude-chips\s*\{([^}]*)\}/);
      expect(chips).not.toBeNull();
      expect(chips[1]).toContain("flex-direction: column");
      const handle = cardStylesSource.match(
        /\.log-preview-header \.resizable-col::after\s*\{([^}]*)\}/
      );
      expect(handle).not.toBeNull();
      expect(handle[1]).toContain("border-right: 1px solid var(--divider-color)");
    });

    test("Save as new starts from an empty name, unlike Save profile", () => {
      const rec = document.createElement("log-manager-card");
      rec._profileRow = document.createElement("div");
      rec._profileSaveRow = document.createElement("div");
      rec._profileNameInput = document.createElement("input");
      rec._profileSelect = document.createElement("select");
      const savedName = document.createElement("option");
      savedName.value = "Existing";
      rec._profileSelect.appendChild(savedName);
      rec._profileSelect.value = "Existing";
      const saveNewBtn = document.createElement("button");
      const saveBtn = document.createElement("button");
      rec._profileSaveNewBtn = saveNewBtn;
      rec._profileSaveBtn = saveBtn;
      rec._profileAbortBtn = document.createElement("button");
      rec._profileConfirmBtn = document.createElement("button");
      rec._profileDeleteBtn = document.createElement("button");
      rec._hass = { states: {}, callService: jest.fn(), connection: { sendMessagePromise: jest.fn() } };
      // attachRecordingSetup wires every dialog control; stub the ones this
      // case does not exercise.
      rec._recordingSetupDialog = document.createElement("div");
      rec._recordingSetupCancel = document.createElement("button");
      rec._recordingSetupStart = document.createElement("button");
      rec._loggerChecklist = document.createElement("div");

      recordingSetup.attachRecordingSetup(rec);

      saveNewBtn.click();
      expect(rec._profileSaveRow.style.display).toBe("flex");
      expect(rec._profileNameInput.value).toBe("");
    });

    test("Save on a modified profile goes straight to the overwrite confirmation", () => {
      const rec = document.createElement("log-manager-card");
      rec._profileRow = document.createElement("div");
      rec._profileSaveRow = document.createElement("div");
      rec._profileNameInput = document.createElement("input");
      rec._profileSelect = document.createElement("select");
      const modified = document.createElement("option");
      modified.value = "__modified__";
      modified.textContent = "My Profile *";
      rec._profileSelect.appendChild(modified);
      rec._profileSelect.value = "__modified__";
      rec._modifiedBaseName = "My Profile";
      rec._profiles = [{ name: "My Profile" }];
      rec._profileSaveBtn = document.createElement("button");
      rec._profileSaveNewBtn = document.createElement("button");
      rec._profileAbortBtn = document.createElement("button");
      rec._profileConfirmBtn = document.createElement("button");
      rec._profileDeleteBtn = document.createElement("button");
      rec._hass = { states: {}, callService: jest.fn(), connection: { sendMessagePromise: jest.fn() } };
      rec._recordingSetupDialog = document.createElement("div");
      rec._recordingSetupCancel = document.createElement("button");
      rec._recordingSetupStart = document.createElement("button");
      rec._loggerChecklist = document.createElement("div");
      rec._loggerChecklist.innerHTML = `<label class="checklist-item"><input type="checkbox" data-logger="t.logger" checked><select class="recording-level-select" data-logger="t.logger"><option value="INFO" selected>INFO</option></select></label>`;
      const confirmSpy = jest.spyOn(loggers, "showDeleteConfirm").mockImplementation(() => {});

      recordingSetup.attachRecordingSetup(rec);

      rec._profileSaveBtn.click();
      // The sentinel is not a real name: the target is the base name, and the
      // save goes straight to the overwrite confirm — no name step.
      expect(rec._profileNameInput.value).toBe("My Profile");
      expect(confirmSpy).toHaveBeenCalled();
      expect(confirmSpy.mock.calls[0][1]).toContain("Overwrite");
      expect(rec._profileSaveRow.style.display).not.toBe("flex");
      confirmSpy.mockRestore();
    });

    test("Save on a shown (unmodified) profile saves directly, no name step", () => {
      const rec = document.createElement("log-manager-card");
      rec._profileRow = document.createElement("div");
      rec._profileSaveRow = document.createElement("div");
      rec._profileNameInput = document.createElement("input");
      rec._profileSelect = document.createElement("select");
      const opt = document.createElement("option");
      opt.value = "Existing";
      rec._profileSelect.appendChild(opt);
      rec._profileSelect.value = "Existing";
      rec._modifiedBaseName = "";
      rec._profiles = [{ name: "Existing" }];
      rec._profileSaveBtn = document.createElement("button");
      rec._profileSaveNewBtn = document.createElement("button");
      rec._profileAbortBtn = document.createElement("button");
      rec._profileConfirmBtn = document.createElement("button");
      rec._profileDeleteBtn = document.createElement("button");
      rec._hass = { states: {}, callService: jest.fn(), connection: { sendMessagePromise: jest.fn() } };
      rec._recordingSetupDialog = document.createElement("div");
      rec._recordingSetupCancel = document.createElement("button");
      rec._recordingSetupStart = document.createElement("button");
      rec._loggerChecklist = document.createElement("div");
      rec._loggerChecklist.innerHTML = `<label class="checklist-item"><input type="checkbox" data-logger="t.logger" checked><select class="recording-level-select" data-logger="t.logger"><option value="INFO" selected>INFO</option></select></label>`;
      const confirmSpy = jest.spyOn(loggers, "showDeleteConfirm").mockImplementation(() => {});

      recordingSetup.attachRecordingSetup(rec);

      rec._profileSaveBtn.click();
      expect(rec._profileNameInput.value).toBe("Existing");
      expect(rec._profileSaveRow.style.display).not.toBe("flex");
      expect(confirmSpy).toHaveBeenCalled();
      confirmSpy.mockRestore();
    });
  });
});
