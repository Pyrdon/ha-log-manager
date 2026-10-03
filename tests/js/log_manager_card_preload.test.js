import { jest } from "@jest/globals";
import { LogManagerCard } from "../../custom_components/log_manager/www/log_manager/log_manager_card.js";

// Regression for the pre-load hazard: Home Assistant may assign `hass` a
// second time before the sibling dynamic imports (card-add-form.js,
// card-recording-session.js) resolve.
//
// This file imports the entry directly and runs one synchronous test, before
// awaiting `whenCardModulesLoaded()` anywhere, so the sibling module variables
// are still null (the loader's callbacks have not run synchronously after
// import — verified separately). The `hass` setter must gate on readiness and
// the rAF scheduler must null-guard the accessors rather than throw.

function bareCard() {
  // Skip the constructor: it reads `liveViewModule()` at line 208, which is
  // itself only safe post-load. We exercise the `hass` setter / scheduler in
  // isolation instead. `_hass` is intentionally incomplete so a
  // not-yet-loaded module must not be dereferenced.
  const card = Object.create(LogManagerCard.prototype);
  card._uiBuilt = true;
  card._modulesLoaded = false;
  card._updateScheduled = false;
  card._hass = {};
  return card;
}

test("hass before siblings resolve neither throws nor schedules", () => {
  const card = bareCard();
  let scheduled = false;
  const origRaf = global.requestAnimationFrame;
  global.requestAnimationFrame = (cb) => { scheduled = true; cb(); };
  try {
    // First assignment builds the readiness gate, second hits the unloaded
    // branch. Neither may throw.
    expect(() => {
      card.hass = { a: 1 };
      card.hass = { a: 2 };
    }).not.toThrow();
    expect(scheduled).toBe(false);

    // Even a direct scheduler call while the graph is unresolved must not
    // dereference a null module (the rAF callback runs synchronously here).
    card._modulesLoaded = true;
    expect(() => card._scheduleUpdate()).not.toThrow();
  } finally {
    global.requestAnimationFrame = origRaf;
  }
  expect(scheduled).toBe(true);
  expect(card._updateScheduled).toBe(false);
});
