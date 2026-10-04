import { jest } from "@jest/globals";
import { ui, utils, cardStylesSource } from "./setup.js";

// Minimal confirm-dialog DOM matching the ids card-ui.js queries.
function makeDialogHost() {
  const card = { _confirmDialog: document.createElement("div") };
  card._confirmDialog.innerHTML = `
    <div id="confirm-title"></div>
    <div id="confirm-message"></div>
    <button id="confirm-cancel-btn"></button>
    <button id="confirm-ok-btn"></button>
  `;
  return card;
}

describe("card-ui", () => {
  describe("optionColor", () => {
    test("maps sentinels and severities", () => {
      expect(ui.optionColor("ALL")).toBe("var(--primary-text-color)");
      expect(ui.optionColor("DISABLED")).toBe("var(--secondary-text-color)");
      expect(ui.optionColor("ERROR")).toBe(utils.levelColors("ERROR").color);
    });
  });

  describe("tintLevelOptions", () => {
    test("colours every option and the closed control, idempotently", () => {
      const sel = document.createElement("select");
      ["ALL", "DEBUG", "ERROR"].forEach(v => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v;
        sel.appendChild(o);
      });
      sel.value = "ERROR";

      ui.tintLevelOptions(sel);
      // jsdom normalises hex to rgb(...) and drops `var(...)`, so assert the
      // helper's output plus that each option received a colour.
      expect(ui.optionColor("ERROR")).toBe(utils.levelColors("ERROR").color);
      expect(ui.optionColor("ALL")).toBe("var(--primary-text-color)");
      expect(sel.options[2].style.color).not.toBe("");
      expect(sel.style.color).not.toBe("");

      // Re-running does not change the outcome.
      const first = Array.from(sel.options).map(o => o.style.color);
      ui.tintLevelOptions(sel);
      expect(Array.from(sel.options).map(o => o.style.color)).toEqual(first);
    });

    test("ignores a missing select", () => {
      expect(() => ui.tintLevelOptions(null)).not.toThrow();
    });
  });

  describe("showConfirm", () => {
    test("runs onConfirm directly when no dialog is present", () => {
      const onConfirm = jest.fn();
      ui.showConfirm({}, "sure?", onConfirm);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    test("populates the dialog and resolves confirm", () => {
      const card = makeDialogHost();
      const onConfirm = jest.fn();
      ui.showConfirm(card, "Set all levels?", onConfirm, {
        title: "Set all levels",
        confirmLabel: "Apply",
        cancelLabel: "No",
      });

      expect(card._confirmDialog.style.display).toBe("flex");
      expect(card._confirmDialog.querySelector("#confirm-title").textContent).toBe("Set all levels");
      expect(card._confirmDialog.querySelector("#confirm-ok-btn").textContent).toBe("Apply");

      card._confirmDialog.querySelector("#confirm-ok-btn").click();
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(card._confirmDialog.style.display).toBe("none");
    });

    test("the No button runs onCancel", () => {
      const card = makeDialogHost();
      const onConfirm = jest.fn();
      const onCancel = jest.fn();
      ui.showConfirm(card, "sure?", onConfirm, { onCancel });

      card._confirmDialog.querySelector("#confirm-cancel-btn").click();
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    test("dismissConfirm runs onCancel and reports it closed a dialog", () => {
      const card = makeDialogHost();
      const onCancel = jest.fn();
      ui.showConfirm(card, "sure?", jest.fn(), { onCancel });

      const dismissed = ui.dismissConfirm(card);
      expect(dismissed).toBe(true);
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(card._confirmDialog.style.display).toBe("none");
    });

    test("dismissConfirm is a no-op when nothing is open", () => {
      const card = makeDialogHost();
      expect(ui.dismissConfirm(card)).toBe(false);
    });

    test("renders escaped HTML when requested", () => {
      const card = makeDialogHost();
      ui.showConfirm(card, "<b>hi</b>", jest.fn(), { htmlMessage: true });
      expect(card._confirmDialog.querySelector("#confirm-message").innerHTML).toBe("<b>hi</b>");
    });
  });

  describe("showNotice", () => {
    test("displays an OK-only dialog and closes on OK", () => {
      const card = makeDialogHost();
      ui.showNotice(card, "Saved.", { title: "Set all levels" });

      const dlg = card._confirmDialog;
      expect(dlg.style.display).toBe("flex");
      expect(dlg.querySelector("#confirm-title").textContent).toBe("Set all levels");
      expect(dlg.querySelector("#confirm-message").textContent).toBe("Saved.");
      expect(dlg.querySelector("#confirm-ok-btn").textContent).toBe("OK");
      expect(dlg.querySelector("#confirm-cancel-btn").style.display).toBe("none");

      dlg.querySelector("#confirm-ok-btn").click();
      expect(dlg.style.display).toBe("none");
    });

    test("a notice followed by a confirm restores the cancel button", () => {
      const card = makeDialogHost();
      ui.showNotice(card, "Saved.", { title: "Set all levels" });
      const cancelBtn = card._confirmDialog.querySelector("#confirm-cancel-btn");
      expect(cancelBtn.style.display).toBe("none");

      ui.showConfirm(card, "Delete?", jest.fn(), { cancelLabel: "No" });
      expect(cancelBtn.style.display).toBe("");
      expect(cancelBtn.textContent).toBe("No");
      expect(card._confirmDialog.querySelector("#confirm-ok-btn").textContent).toBe("Yes");
    });

    test("is a no-op when no dialog is present", () => {
      expect(() => ui.showNotice({}, "Saved.")).not.toThrow();
    });
  });

  describe("dialog stacking", () => {
    test("the confirm overlay out-specifies the shared dialog z-index", () => {
      // The confirm element carries both classes; the higher-specificity rule
      // must exist so the later .dialog-overlay z-index cannot win.
      const confirmRule = cardStylesSource.match(
        /\.dialog-overlay\.confirm-dialog-overlay\s*\{([^}]*)\}/
      );
      expect(confirmRule).not.toBeNull();
      expect(confirmRule[1]).toContain("1000000001");

      const sharedRule = cardStylesSource.match(/\.dialog-overlay\s*\{([^}]*)\}/);
      expect(sharedRule).not.toBeNull();
      expect(sharedRule[1]).toContain("999999999");
    });
  });
});
