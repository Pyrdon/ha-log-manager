"""Log recording handler: buffers events at each logger's configured level."""

import collections
import logging
import threading

from homeassistant.core import HomeAssistant

from .const import DOMAIN, match_managed_logger


class LogRecordingHandler(logging.Handler):
    """Buffer log events at each logger's configured level for export."""

    MAX_BUFFER_SIZE = 10000

    def __init__(
        self,
        hass: HomeAssistant,
        logger_names: frozenset,
        level_overrides: dict[str, str] | None = None,
        excludes: dict[str, list[str]] | None = None,
    ) -> None:
        super().__init__(logging.DEBUG)
        self.hass = hass
        self.logger_names = logger_names
        self.buffer: collections.deque = collections.deque(
            maxlen=self.MAX_BUFFER_SIZE
        )
        self.level_overrides = level_overrides or {}
        self.excludes: dict[str, frozenset[str]] = {
            name: frozenset(paths) for name, paths in (excludes or {}).items()
        }
        self.logger_counts: dict[str, int] = {}
        self._next_entry_id: int = 0
        self._lock = threading.Lock()

    def _is_excluded(self, name: str) -> bool:
        """Return True when an event's logger is under an exclusion path."""
        for logger_name, paths in self.excludes.items():
            if not name.startswith(logger_name + "."):
                continue
            for path in paths:
                if name == path or name.startswith(path + "."):
                    return True
        return False

    def emit(self, record: logging.LogRecord) -> None:
        try:
            matched = self._match_logger(record.name)
            if matched is None:
                return

            if self._is_excluded(record.name):
                return

            # Check override first, then fall back to stored config.
            # ALL applies no additional floor: capture everything the logger
            # emits. NOTSET resolves to DEBUG, matching the stored default.
            raw_level = self.level_overrides.get(
                matched,
                self.hass.data[DOMAIN]["loggers"].get(matched, {}).get("level", "NOTSET"),
            )
            if raw_level == "ALL":
                min_level = 0
            elif raw_level == "NOTSET":
                min_level = logging.DEBUG
            else:
                min_level = getattr(logging, raw_level, logging.DEBUG)
            if record.levelno < min_level:
                return

            entry = {
                "id": self._next_entry_id,
                "timestamp": record.created,
                "level": record.levelname,
                "levelno": record.levelno,
                "logger": record.name,
                "message": record.getMessage(),
                "source": (
                    f"{record.pathname}:{record.lineno}"
                    if record.pathname
                    else ""
                ),
            }
            with self._lock:
                self._next_entry_id += 1
                self.buffer.append(entry)
                self.logger_counts[matched] = self.logger_counts.get(matched, 0) + 1
        except Exception:
            self.handleError(record)

    def _match_logger(self, name: str) -> str | None:
        return match_managed_logger(name, self.logger_names)

    def snapshot(self) -> list[dict]:
        """Return a thread-safe copy of the buffered entries (oldest first)."""
        with self._lock:
            return list(self.buffer)

    def counts_snapshot(self) -> dict[str, int]:
        """Return a thread-safe copy of the per-logger entry counts."""
        with self._lock:
            return dict(self.logger_counts)

    def count(self) -> int:
        """Return the current number of buffered entries."""
        with self._lock:
            return len(self.buffer)

    def clear(self) -> None:
        """Clear the buffer and per-logger counts, restarting entry ids at 0.

        The recording session itself is unaffected; new entries continue to be
        captured from id 0.
        """
        with self._lock:
            self.buffer.clear()
            self.logger_counts.clear()
            self._next_entry_id = 0

    def entries_after(self, after_id: int) -> tuple[list[dict], int]:
        """Return entries newer than or equal to ``after_id`` plus the next id.

        The client advances ``after_id`` to the previously returned ``next_id``
        (one past the last delivered entry id), so ``>=`` delivers exactly the
        new entries and still includes entry id 0 on the first poll.
        """
        with self._lock:
            result = []
            for entry in reversed(self.buffer):
                if entry["id"] < after_id:
                    break
                result.append(entry)
            result.reverse()
            return result, self._next_entry_id
