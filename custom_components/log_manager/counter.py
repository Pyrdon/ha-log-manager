"""Warning/error counter handler for managed loggers."""

import copy
import logging
import threading

from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .alerts import _schedule_alert
from .const import ALERT_DISABLED, DEFAULT_ALERT_LEVEL, DOMAIN, match_managed_logger

_LOGGER = logging.getLogger(__name__)


def _empty_counters() -> dict:
    """Return a fresh warning/error counter dict.

    Must return a new ``recent_logs`` list on every call — the list is mutated
    in place by ``LogCounterHandler.emit`` and a shallow copy would be shared
    across all managed loggers.
    """
    return {
        "warning": 0,
        "error": 0,
        "last_warning": "",
        "last_error": "",
        "recent_logs": [],
        "levels": {},
        "alert_fired": False,
    }


class LogCounterHandler(logging.Handler):
    """Count WARNING and above events for managed loggers."""

    MAX_RECENT = 10

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(logging.WARNING)
        self.hass = hass
        self._lock = threading.RLock()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            loggers = self.hass.data.get(DOMAIN, {}).get("loggers", {})
            if not loggers:
                return

            # Match the record against managed loggers, including child loggers.
            # e.g. "custom_components.voice_satellite.sensor" matches
            # the managed logger "custom_components.voice_satellite".
            matched_name = match_managed_logger(record.name, loggers)

            if matched_name is None:
                return

            if record.levelno < logging.WARNING:
                return

            msg = record.getMessage()
            level_name = record.levelname
            source = f"{record.pathname}:{record.lineno}" if record.pathname else ""

            entry = {
                "timestamp": record.created,
                "logger": record.name,
                "level": level_name,
                "message": msg,
                "source": source,
            }

            with self._lock:
                counters = self.hass.data[DOMAIN]["counters"]
                if matched_name not in counters:
                    counters[matched_name] = _empty_counters()

                recent = counters[matched_name]["recent_logs"]
                recent.insert(0, entry)
                if len(recent) > self.MAX_RECENT:
                    del recent[self.MAX_RECENT:]

                counters[matched_name]["levels"][level_name] = (
                    counters[matched_name]["levels"].get(level_name, 0) + 1
                )

                if record.levelno >= logging.ERROR:
                    counters[matched_name]["error"] += 1
                    counters[matched_name]["last_error"] = msg
                elif record.levelno >= logging.WARNING:
                    counters[matched_name]["warning"] += 1
                    counters[matched_name]["last_warning"] = msg

                self._maybe_alert(matched_name, counters[matched_name])

            self._notify_update()
        except Exception:
            self.handleError(record)

    def _notify_update(self) -> None:
        """Push a counters-changed signal onto the event loop (thread-safe)."""

        def _dispatch() -> None:
            async_dispatcher_send(self.hass, f"{DOMAIN}_counters_updated")

        try:
            self.hass.loop.call_soon_threadsafe(_dispatch)
        except RuntimeError:
            pass

    def _maybe_alert(self, logger_name: str, counter: dict) -> None:
        """Fire a notification the first time events cross the alert threshold."""
        if counter["alert_fired"]:
            return
        info = self.hass.data.get(DOMAIN, {}).get("loggers", {}).get(logger_name, {})
        threshold = info.get("alert_threshold", ALERT_DISABLED)
        if not threshold:
            return
        alert_level = info.get("alert_level", DEFAULT_ALERT_LEVEL)
        if alert_level not in ("WARNING", "ERROR", "CRITICAL"):
            alert_level = DEFAULT_ALERT_LEVEL
        alert_min = getattr(logging, alert_level, logging.ERROR)
        qualifying = sum(
            count
            for level_name, count in counter["levels"].items()
            if getattr(logging, level_name, 0) >= alert_min
        )
        if qualifying < threshold:
            return
        counter["alert_fired"] = True
        _schedule_alert(self.hass, logger_name, qualifying, alert_level)

    def check_alert(self, logger_name: str) -> None:
        """Evaluate the alert threshold once (e.g. after reconfiguration)."""
        with self._lock:
            counter = (
                self.hass.data.get(DOMAIN, {}).get("counters", {}).get(logger_name)
            )
            if counter:
                self._maybe_alert(logger_name, counter)

    def snapshot(self) -> dict:
        """Return a thread-safe copy of the current counters.

        The internal alert re-arm flag is stripped: it is not part of the
        public websocket payload.
        """
        with self._lock:
            counters = copy.deepcopy(self.hass.data[DOMAIN]["counters"])
        for counter in counters.values():
            counter.pop("alert_fired", None)
        return counters

    def values_for(self, logger_name: str) -> tuple[int, int]:
        """Return (warning, error) counts for one managed logger."""
        with self._lock:
            counter = self.hass.data.get(DOMAIN, {}).get("counters", {}).get(
                logger_name
            )
            if not counter:
                return (0, 0)
            return (counter["warning"], counter["error"])

    def reset(self, logger_name: str | None = None) -> None:
        """Reset warning and error counters for one or all managed loggers."""
        did_reset = False
        with self._lock:
            counters = self.hass.data[DOMAIN]["counters"]
            if logger_name:
                if logger_name in counters:
                    counters[logger_name] = _empty_counters()
                    did_reset = True
            else:
                for name in counters:
                    counters[name] = _empty_counters()
                did_reset = True
        # Log only after releasing the lock: this logger may itself be managed,
        # and a log call while holding the lock re-enters emit() and deadlocks.
        if did_reset:
            if logger_name:
                _LOGGER.info("Reset counters for '%s'.", logger_name)
            else:
                _LOGGER.info("Reset counters for all loggers.")
        self._notify_update()
