import { setupCard, cardUtilsSource, utils } from "./setup.js";

// Module-direct tests for the pure helpers in card-utils.js. Functions are
// stateless and take locale/hass explicitly, so no element fixture is needed.

beforeAll(async () => {
  await setupCard();
});

const hassWithLocale = (locale) => ({ locale });

describe("card-utils", () => {
describe("escapeAttr", () => {
  test("escapes &, \", <, >", () => {
    expect(utils.escapeAttr('a&b"c<d>e')).toBe("a&amp;b&quot;c&lt;d&gt;e");
  });

  test("passes through safe strings", () => {
    expect(utils.escapeAttr("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(utils.escapeAttr("")).toBe("");
  });
});
describe("escapeHtml", () => {
  test("escapes &, <, > but not quotes", () => {
    expect(utils.escapeHtml('a&b"c<d>e')).toBe("a&amp;b\"c&lt;d&gt;e");
  });

  test("passes through safe strings", () => {
    expect(utils.escapeHtml("normal text")).toBe("normal text");
  });
});
describe("levelColors", () => {
  test("returns correct colors for known levels", () => {
    const debug = utils.levelColors("DEBUG");
    expect(debug.color).toBe("#03a9f4");

    const error = utils.levelColors("ERROR");
    expect(error.color).toBe("#f44336");

    const critical = utils.levelColors("CRITICAL");
    expect(critical.color).toBe("#9c27b0");
  });

  test("returns NOTSET colors for unknown level", () => {
    const unknown = utils.levelColors("BOGUS");
    expect(unknown.color).toBe("var(--primary-text-color)");
  });
});
  test("formatDuration formats minutes, minutes-and-seconds and seconds", () => {
    expect(utils.formatDuration(300)).toBe("5 minutes");
    expect(utils.formatDuration(270)).toBe("4 minutes and 30 seconds");
    expect(utils.formatDuration(1)).toBe("1 second");
    expect(utils.formatDuration(60)).toBe("1 minute");
    expect(utils.formatDuration(0)).toBe("0 seconds");
  });
  test("formatDateTime honours YMD/MDY/DMY date ordering", () => {
    const date = new Date(2023, 4, 7, 13, 5, 9);
    const ts = date.getTime() / 1000;

    expect(utils.formatDateTime(ts, hassWithLocale({ language: "en-GB", date_format: "YMD", time_format: "24" })))
      .toMatch(/^2023[-/.]05[-/.]07 /);
    expect(utils.formatDateTime(ts, hassWithLocale({ language: "en-US", date_format: "MDY", time_format: "24" })))
      .toMatch(/^05[-/.]07[-/.]2023 /);
    expect(utils.formatDateTime(ts, hassWithLocale({ language: "en-GB", date_format: "DMY", time_format: "24" })))
      .toMatch(/^07[-/.]05[-/.]2023 /);
  });
  test("formatDateTime honours the 12/24-hour convention", () => {
    const date = new Date(2023, 4, 7, 13, 5, 9);
    const ts = date.getTime() / 1000;

    expect(utils.formatDateTime(ts, hassWithLocale({ language: "en-GB", date_format: "DMY", time_format: "24" })))
      .toContain("13:05:09");
    expect(utils.formatDateTime(ts, hassWithLocale({ language: "en-US", date_format: "MDY", time_format: "12" })))
      .toMatch(/01:05:09\s?(PM|pm)/);
  });
  test("formatFileTimestamp is filesystem-safe", () => {
    const stamp = utils.formatFileTimestamp(new Date(2023, 4, 7, 13, 5, 9));
    expect(stamp).toBe("2023-05-07_13-05-09");
    expect(stamp).not.toMatch(/[^0-9A-Za-z_-]/);
  });
  test("levelIndex gives ALL a real position and never -1", () => {
    expect(utils.levelIndex("ALL")).toBe(0);
    expect(utils.levelIndex("DEBUG")).toBe(1);
    expect(utils.levelIndex("BOGUS")).toBe(-1);
  });
  test("isMoreVerbose treats ALL as the most verbose and against ALL as never", () => {
    expect(utils.isMoreVerbose("ALL", "DEBUG")).toBe(true);
    expect(utils.isMoreVerbose("DEBUG", "ALL")).toBe(false);
    expect(utils.isMoreVerbose("DEBUG", "INFO")).toBe(true);
    expect(utils.isMoreVerbose("INFO", "INFO")).toBe(false);
  });
  test("entrySeverity prefers levelno and falls back to the level name", () => {
    expect(utils.entrySeverity("INFO", 25)).toBe(25);
    expect(utils.entrySeverity("WARNING")).toBe(30);
    expect(utils.entrySeverity("CUSTOM")).toBe(-1);
  });
  test("compareEntriesBySeverity orders by levelno with a name fallback", () => {
    const entries = [
      { level: "ERROR", levelno: 40 },
      { level: "DEBUG", levelno: 10 },
      { level: "INFO" },
    ];
    const sorted = entries.slice().sort((a, b) => utils.compareEntriesBySeverity(a, b));
    expect(sorted.map(e => e.level)).toEqual(["DEBUG", "INFO", "ERROR"]);
  });
  test("dedupKey separates source but tolerates a missing one", () => {
    const mk = (id, ts, logger, level = "WARNING", message = "boom", source = "m.py") => ({
      id, timestamp: ts, logger, level, message, source,
    });
    const a = mk(0, 0, "a.logger");
    expect(utils.dedupKey(a)).toBe(utils.dedupKey(mk(1, 99, "a.logger")));
    expect(utils.dedupKey(a)).not.toBe(
      utils.dedupKey(mk(0, 0, "a.logger", "ERROR", "boom", "other.py"))
    );
    const noSource = { id: 0, timestamp: 1, logger: "a.logger", level: "ERROR", message: "boom" };
    expect(() => utils.dedupKey(noSource)).not.toThrow();
  });
});
