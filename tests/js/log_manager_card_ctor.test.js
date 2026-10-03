import { jest } from "@jest/globals";
import { LogManagerCard } from "../../custom_components/log_manager/www/log_manager/log_manager_card.js";

// Regression for the constructor pre-load hazard: Home Assistant may construct
// the element (document.createElement("log-manager-card")) in the same tick the
// entry module is evaluated, before the async sibling imports resolve. The
// constructor must not dereference an unloaded sibling module.
//
// This file never awaits whenCardModulesLoaded(), so the sibling module
// variables are still null when the constructor runs. A synchronous
// `new LogManagerCard()` therefore exercises the exact production ordering.
test("constructor does not throw before sibling modules resolve", () => {
  expect(() => new LogManagerCard()).not.toThrow();

  const card = new LogManagerCard();
  // Column widths must be a usable default without the live-view module.
  expect(typeof card._colWidths).toBe("object");
  expect(card._colWidths).not.toBeNull();
});
