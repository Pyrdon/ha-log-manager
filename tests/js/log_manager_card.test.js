const fs = require("fs");
const path = require("path");

const cardSource = fs.readFileSync(
  path.resolve(__dirname, "../../custom_components/log_manager/www/log_manager/log_manager_card.js"),
  "utf8"
);

let cardInstance;

beforeAll(() => {
  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function () {
    const root = document.createElement("div");
    root.className = "shadow-root";
    this.shadowRoot = root;
    return root;
  };

  // Only define the custom element once.
  if (!customElements.get("log-manager-card")) {
    eval(cardSource);
  }

  Element.prototype.attachShadow = originalAttachShadow;

  cardInstance = document.createElement("log-manager-card");
});

describe("LogManagerCard", () => {
  describe("_escapeAttr", () => {
    test("escapes &, \", <, >", () => {
      expect(cardInstance._escapeAttr('a&b"c<d>e')).toBe("a&amp;b&quot;c&lt;d&gt;e");
    });

    test("passes through safe strings", () => {
      expect(cardInstance._escapeAttr("hello world")).toBe("hello world");
    });

    test("handles empty string", () => {
      expect(cardInstance._escapeAttr("")).toBe("");
    });
  });

  describe("_escapeHtml", () => {
    test("escapes &, <, > but not quotes", () => {
      expect(cardInstance._escapeHtml('a&b"c<d>e')).toBe("a&amp;b\"c&lt;d&gt;e");
    });

    test("passes through safe strings", () => {
      expect(cardInstance._escapeHtml("normal text")).toBe("normal text");
    });
  });

  describe("_levelColors", () => {
    test("returns correct colors for known levels", () => {
      const debug = cardInstance._levelColors("DEBUG");
      expect(debug.color).toBe("#03a9f4");

      const error = cardInstance._levelColors("ERROR");
      expect(error.color).toBe("#f44336");

      const critical = cardInstance._levelColors("CRITICAL");
      expect(critical.color).toBe("#9c27b0");
    });

    test("returns NOTSET colors for unknown level", () => {
      const unknown = cardInstance._levelColors("BOGUS");
      expect(unknown.color).toBe("var(--primary-text-color)");
    });
  });

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

  describe("sessionStorage persistence", () => {
    beforeEach(() => {
      sessionStorage.clear();
    });

    test("_persistState writes to sessionStorage", () => {
      cardInstance._pathInput = { value: "test.path" };
      cardInstance._friendlyNameInput = { value: "Test Name" };

      cardInstance._persistState();

      expect(sessionStorage.getItem("logManagerPath")).toBe("test.path");
      expect(sessionStorage.getItem("logManagerName")).toBe("Test Name");
    });

    test("_clearState removes sessionStorage items", () => {
      cardInstance._pathInput = { value: "existing.path" };
      cardInstance._friendlyNameInput = { value: "Existing" };

      sessionStorage.setItem("logManagerPath", "existing.path");
      sessionStorage.setItem("logManagerName", "Existing");

      cardInstance._clearState();

      expect(sessionStorage.getItem("logManagerPath")).toBeNull();
      expect(sessionStorage.getItem("logManagerName")).toBeNull();
      expect(cardInstance._pathInput.value).toBe("");
      expect(cardInstance._friendlyNameInput.value).toBe("");
    });
  });

  describe("_renderCounterBadgeHtml", () => {
    test("returns empty string when no warnings or errors", () => {
      const result = cardInstance._renderCounterBadgeHtml("test.logger");
      expect(result).toBe("");
    });

    test("renders warning badge with count", () => {
      cardInstance._counters = { "test.logger": { warning: 3, error: 0 } };
      const result = cardInstance._renderCounterBadgeHtml("test.logger");
      expect(result).toContain("warning-badge");
      expect(result).toContain("3");
      expect(result).not.toContain("error-badge");
    });

    test("renders error badge with count", () => {
      cardInstance._counters = { "test.logger": { warning: 0, error: 2 } };
      const result = cardInstance._renderCounterBadgeHtml("test.logger");
      expect(result).toContain("error-badge");
      expect(result).toContain("2");
      expect(result).not.toContain("warning-badge");
    });

    test("renders both badges when both present", () => {
      cardInstance._counters = { "test.logger": { warning: 1, error: 4 } };
      const result = cardInstance._renderCounterBadgeHtml("test.logger");
      expect(result).toContain("warning-badge");
      expect(result).toContain("error-badge");
      expect(result).toContain("1");
      expect(result).toContain("4");
    });
  });
});
