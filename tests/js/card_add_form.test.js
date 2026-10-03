import { jest } from "@jest/globals";
import { setupCard, cardStylesSource, addForm } from "./setup.js";

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
  });
});
