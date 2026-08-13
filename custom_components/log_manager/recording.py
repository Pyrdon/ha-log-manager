"""Log recording subsystem for the Log Manager integration.

Buffers log events from the selected managed loggers during a recording
session and exposes start/stop/status/entries websocket commands.
"""

import collections
import logging
import threading
import time

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.event import async_call_later

from .const import DOMAIN, LOG_LEVELS_LIST, match_managed_logger

_LOGGER = logging.getLogger(__name__)


class LogRecordingHandler(logging.Handler):
    """Buffer log events at each logger's configured level for export."""

    MAX_BUFFER_SIZE = 10000

    def __init__(
        self,
        hass: HomeAssistant,
        logger_names: frozenset,
        level_overrides: dict[str, str] | None = None,
    ) -> None:
        super().__init__(logging.DEBUG)
        self.hass = hass
        self.logger_names = logger_names
        self.buffer: collections.deque = collections.deque(
            maxlen=self.MAX_BUFFER_SIZE
        )
        self.level_overrides = level_overrides or {}
        self.logger_counts: dict[str, int] = {}
        self._next_entry_id: int = 0
        self._lock = threading.Lock()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            matched = self._match_logger(record.name)
            if matched is None:
                return

            # Check override first, then fall back to stored config.
            raw_level = self.level_overrides.get(
                matched,
                self.hass.data[DOMAIN]["loggers"].get(matched, {}).get("level", "NOTSET"),
            )
            min_level = (
                getattr(logging, raw_level, logging.DEBUG)
                if raw_level != "NOTSET"
                else logging.DEBUG
            )
            if record.levelno < min_level:
                return

            entry = {
                "id": self._next_entry_id,
                "timestamp": record.created,
                "level": record.levelname,
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


def async_register_recording_commands(hass: HomeAssistant) -> None:
    """Register the recording websocket commands."""
    websocket_api.async_register_command(hass, ws_start_recording)
    websocket_api.async_register_command(hass, ws_stop_recording)
    websocket_api.async_register_command(hass, ws_recording_status)
    websocket_api.async_register_command(hass, ws_recording_entries)


def async_stop_recording_session(hass: HomeAssistant) -> None:
    """Remove any active recording handler and clear the session state."""
    recording = hass.data.get(DOMAIN, {}).get("recording", {})
    if recording.get("status") == "recording":
        cancel_timer = recording.get("cancel_timer")
        if cancel_timer:
            cancel_timer()
        handler = recording.get("handler")
        if handler:
            logging.root.removeHandler(handler)
    hass.data.get(DOMAIN, {}).pop("recording", None)


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/start_recording",
    vol.Required("loggers"): vol.All(cv.ensure_list, [cv.string]),
    vol.Optional("max_duration", default=300): vol.All(
        vol.Coerce(int), vol.Range(min=10, max=3600)
    ),
    vol.Optional("level_overrides", default={}): vol.Schema(
        {cv.string: vol.In(LOG_LEVELS_LIST)}
    ),
})
@websocket_api.async_response
async def ws_start_recording(hass: HomeAssistant, connection, msg: dict):
    """
    Start recording log events for the specified managed loggers.
    """

    recording = hass.data[DOMAIN].get("recording", {})
    if recording.get("status") in ("recording", "completed"):
        connection.send_error(
            msg["id"], "already_recording",
            "A recording session is already active or has unsaved data."
        )
        return

    logger_names = set(msg["loggers"])
    max_duration = msg["max_duration"]
    level_overrides = msg.get("level_overrides", {})

    # Validate that all requested loggers are managed.
    managed = hass.data[DOMAIN].get("loggers", {})
    unknown = logger_names - set(managed.keys())
    if unknown:
        connection.send_error(
            msg["id"], "unknown_logger",
            f"Unknown loggers: {', '.join(sorted(unknown))}"
        )
        return

    handler = LogRecordingHandler(hass, frozenset(logger_names), level_overrides)
    logging.root.addHandler(handler)

    start_time = time.time()

    def _recording_timeout(now):
        rec = hass.data[DOMAIN].get("recording", {})
        if rec.get("status") == "recording":
            rec["status"] = "completed"
            h = rec.get("handler")
            if h:
                logging.root.removeHandler(h)
            rec["cancel_timer"] = None

    cancel_timer = async_call_later(hass, max_duration, _recording_timeout)

    hass.data[DOMAIN]["recording"] = {
        "handler": handler,
        "start_time": start_time,
        "status": "recording",
        "cancel_timer": cancel_timer,
        "max_duration": max_duration,
        "loggers": logger_names,
    }

    _LOGGER.info(
        "Started recording %s loggers for max %s seconds.",
        len(logger_names), max_duration
    )

    connection.send_result(msg["id"], {
        "status": "recording",
        "max_duration": max_duration,
    })


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/stop_recording"})
@websocket_api.async_response
async def ws_stop_recording(hass: HomeAssistant, connection, msg: dict):
    """
    Stop recording and return buffered logs.
    """

    recording = hass.data[DOMAIN].get("recording", {})
    if recording.get("status") not in ("recording", "completed"):
        connection.send_error(
            msg["id"], "not_recording",
            "No recording session is active."
        )
        return

    # Cancel the timeout timer if still pending.
    cancel_timer = recording.get("cancel_timer")
    if cancel_timer:
        cancel_timer()

    handler = recording.get("handler")
    if handler:
        logging.root.removeHandler(handler)

    buffer = handler.snapshot() if handler else []
    duration = time.time() - recording.get("start_time", time.time())
    log_count = len(buffer)

    # Reset recording state.
    hass.data[DOMAIN]["recording"] = {"status": "none"}

    _LOGGER.info(
        "Stopped recording after %.1f seconds, %s entries.",
        duration, log_count
    )

    connection.send_result(msg["id"], {
        "logs": buffer,
        "duration": round(duration, 1),
        "log_count": log_count,
        "status": "completed",
    })


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/recording_status"})
@websocket_api.async_response
async def ws_recording_status(hass: HomeAssistant, connection, msg: dict):
    """
    Return the current recording status for the frontend to poll.
    """

    recording = hass.data[DOMAIN].get("recording", {})
    status = recording.get("status", "none")

    result = {"status": status}
    if status != "none":
        result["elapsed"] = round(
            time.time() - recording.get("start_time", time.time()), 1
        )
        handler = recording.get("handler")
        result["log_count"] = handler.count() if handler else 0
        result["max_duration"] = recording.get("max_duration", 300)
        result["loggers"] = list(recording.get("loggers", []))
        result["logger_counts"] = handler.counts_snapshot() if handler else {}

    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/recording_entries",
    vol.Optional("after_id", default=0): int,
})
@websocket_api.async_response
async def ws_recording_entries(hass: HomeAssistant, connection, msg: dict):
    """
    Return recorded log entries newer than after_id.
    Used by the live view to poll incrementally.
    """

    recording = hass.data[DOMAIN].get("recording", {})
    if recording.get("status") not in ("recording", "completed"):
        connection.send_result(msg["id"], {"entries": [], "next_id": 0})
        return

    handler = recording.get("handler")
    if not handler:
        connection.send_result(msg["id"], {"entries": [], "next_id": 0})
        return

    entries, next_id = handler.entries_after(msg["after_id"])

    connection.send_result(msg["id"], {
        "entries": entries,
        "next_id": next_id,
    })
