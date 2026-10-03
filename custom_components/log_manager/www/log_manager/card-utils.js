// Pure generic helpers for the Log Manager card.
// Extracted from the entry card to keep it navigable. These are stateless:
// formatters take the locale explicitly, and the element delegates to them so
// the private method names stay on the card instance for existing callers.

// Escape a string for safe use inside an HTML attribute (quotes included).
export function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Escape a string for safe use as HTML text (quotes left intact).
export function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Background/foreground/row-tint colours for a level token.
export function levelColors(level) {
  const map = {
    "DEBUG":     { bg: "rgba(3, 169, 244, 0.15)", color: "#03a9f4", rowBg: "rgba(3, 169, 244, 0.08)" },
    "INFO":      { bg: "rgba(76, 175, 80, 0.15)",  color: "#4caf50", rowBg: "rgba(76, 175, 80, 0.08)" },
    "WARNING":   { bg: "rgba(255, 152, 0, 0.15)",  color: "#ff9800", rowBg: "rgba(255, 152, 0, 0.08)" },
    "ERROR":     { bg: "rgba(244, 67, 54, 0.15)",  color: "#f44336", rowBg: "rgba(244, 67, 54, 0.08)" },
    "CRITICAL":  { bg: "rgba(156, 39, 176, 0.15)", color: "#9c27b0", rowBg: "rgba(156, 39, 176, 0.08)" },
    "NOTSET":    { bg: "transparent",               color: "var(--primary-text-color)", rowBg: "rgba(var(--rgb-primary-text-color), 0.03)" },
  };
  return map[level] || map["NOTSET"];
}

// Display position of a level token in a selector. ALL is the catch-all
// floor and sits before DEBUG, so it is always "more verbose" and never -1.
export function levelIndex(level) {
  return ["ALL", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"].indexOf(level);
}

// Severity position of an emitted entry. Entries carry their numeric level;
// older buffers without one fall back to the level name. Never use
// levelIndex for entries: it is a display mapping, not a severity ranking.
export function entrySeverity(level, levelno) {
  if (typeof levelno === "number" && !Number.isNaN(levelno)) return levelno;
  const byName = {
    DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50,
  };
  return byName[level] != null ? byName[level] : -1;
}

// Numeric comparator for captured entries, ascending by severity.
export function compareEntriesBySeverity(a, b) {
  return entrySeverity(a.level, a.levelno) - entrySeverity(b.level, b.levelno);
}

// Numeric floor for a level-filter token. ALL means no additional floor.
export function levelFilterFloor(levelFilter) {
  if (!levelFilter || levelFilter === "ALL") return -Infinity;
  const byName = {
    DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50,
  };
  return byName[levelFilter] != null ? byName[levelFilter] : -Infinity;
}

// True when `to` is a strictly more verbose level than `current`.
export function isMoreVerbose(to, current) {
  if (!to || !current) return false;
  // ALL is the catch-all floor: always more verbose than any named level.
  if (to === "ALL") return true;
  if (current === "ALL") return false;
  if (to === "NOTSET" || current === "NOTSET") return false;
  const ti = levelIndex(to);
  const ci = levelIndex(current);
  return ti !== -1 && ci !== -1 && ti < ci;
}

// HA date/time format configuration with safe fallbacks.
export function localeSettings(hass) {
  const locale = (hass && hass.locale) || {};
  return {
    dateFormat: locale.date_format || "language",
    timeFormat: locale.time_format || "24",
  };
}

// Ordered date parts for an explicit HA date format; null means the locale
// decides its own ordering.
export function datePartOrder(dateFormat) {
  if (dateFormat === "DMY") return ["day", "month", "year"];
  if (dateFormat === "MDY") return ["month", "day", "year"];
  if (dateFormat === "YMD") return ["year", "month", "day"];
  return null;
}

// Locale-aware date and time, honouring the region's date ordering and its
// 12/24-hour convention.
export function formatDateTime(ts, hass) {
  const date = new Date((ts || 0) * 1000);
  const locale = (hass && hass.locale && hass.locale.language) || undefined;
  const { dateFormat, timeFormat } = localeSettings(hass);
  const hour12 = timeFormat === "12" ? true : timeFormat === "24" ? false : undefined;
  const order = datePartOrder(dateFormat);

  let dateText;
  if (order) {
    const parts = new Intl.DateTimeFormat(locale, {
      day: "2-digit", month: "2-digit", year: "numeric",
    }).formatToParts(date);
    const byType = {};
    let separator = "/";
    parts.forEach(part => {
      if (part.type === "day" || part.type === "month" || part.type === "year") {
        byType[part.type] = part.value;
      } else if (part.type === "literal" && separator === "/") {
        const trimmed = part.value.trim();
        if (trimmed) separator = trimmed;
      }
    });
    dateText = order.map(k => byType[k]).join(separator);
  } else {
    dateText = new Intl.DateTimeFormat(locale, {
      day: "2-digit", month: "2-digit", year: "numeric",
    }).format(date);
  }

  const timeOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };
  if (hour12 !== undefined) timeOptions.hour12 = hour12;
  const timeText = new Intl.DateTimeFormat(locale, timeOptions).format(date);

  return `${dateText} ${timeText}`;
}

// Sanitized timestamp for download filenames: no path separators or other
// unsafe characters, whitespace collapsed to a single underscore.
export function formatFileTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const raw =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return raw.replace(/[^0-9A-Za-z_-]+/g, "_").replace(/\s+/g, "_");
}

// Human-readable duration, e.g. 300 -> "5 minutes", 270 -> "4 minutes and 30 seconds".
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const parts = [];
  if (minutes > 0) parts.push(plural(minutes, "minute"));
  if (secs > 0 || minutes === 0) parts.push(plural(secs, "second"));
  if (parts.length === 1) return parts[0];
  return `${parts[0]} and ${parts[1]}`;
}

// Stable key for a captured entry, used to fold identical consecutive events.
export function dedupKey(entry) {
  return `${entry.logger}${entry.level}${entry.message}${entry.source || ""}`;
}

// Minute-resolution label for a dedup group timestamp.
export function dedupMinute(ts, locale) {
  return new Date(ts * 1000).toLocaleTimeString(
    locale, { hour: "2-digit", minute: "2-digit", hour12: false }
  );
}

// A group's time span: one minute shows once, a cross-minute run shows a range.
export function dedupRangeText(firstTs, lastTs, locale) {
  const first = dedupMinute(firstTs, locale);
  const last = dedupMinute(lastTs, locale);
  return first === last ? first : `${first}–${last}`;
}

// Mutable API object: the cross-concern call seam and the test stub target.
export const utils = {
  escapeAttr,
  escapeHtml,
  levelColors,
  levelIndex,
  entrySeverity,
  compareEntriesBySeverity,
  levelFilterFloor,
  isMoreVerbose,
  localeSettings,
  datePartOrder,
  formatDateTime,
  formatFileTimestamp,
  formatDuration,
  dedupKey,
  dedupMinute,
  dedupRangeText,
};
