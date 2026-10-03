// Static shadow-DOM styles for the Log Manager card.
// Split by UI surface into sibling modules to keep each file navigable; the
// module concatenates them in the original order. The exact whitespace of the
// original inline <style> block is preserved so the concatenated
// shadowRoot.innerHTML is byte-identical.
import { CARD_STYLES_BASE } from "./card-styles-base.js";
import { CARD_STYLES_DIALOGS } from "./card-styles-dialogs.js";
import { CARD_STYLES_RECORDING } from "./card-styles-recording.js";
import { CARD_STYLES_SELECTION } from "./card-styles-selection.js";

export const CARD_STYLES =
  CARD_STYLES_BASE +
  CARD_STYLES_DIALOGS +
  CARD_STYLES_RECORDING +
  CARD_STYLES_SELECTION;
