import { jest } from "@jest/globals";
import { setupCard, cardSource, cardStylesSource, cardMarkupSource, recordingSetup, loggers } from "./setup.js";

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

    test("uses a moderate dialog width and taller checklist", () => {
      expect(cardStylesSource).toMatch(/\.dialog-box\.recording-setup-box\s*\{[^}]*max-width:\s*580px/);
      expect(cardStylesSource).toMatch(/\.logger-checklist\s*\{[^}]*max-height:\s*380px/);
      expect(cardMarkupSource).toContain('class="dialog-box recording-setup-box"');
    });

    test("expanded group items are dimmed more", () => {
      expect(cardStylesSource).toMatch(/\.log-preview-group-item\s*\{[^}]*opacity:\s*0\.4/);
    });
  });
});
