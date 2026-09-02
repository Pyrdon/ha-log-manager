"""Log recording subsystem for the Log Manager integration.

Buffers log events from the selected managed loggers during a recording
session and exposes start/stop/status/entries websocket commands plus
scriptable HA services. Shared session helpers back both interfaces.
"""

import collections
import logging
import threading
import time

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, SupportsResponse
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.event import async_call_later

from .const import DOMAIN, LOG_LEVELS_LIST, match_managed_logger
from .profiles import get_profile

_LOGGER = logging.getLogger(__name__)


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


def start_recording_session(
    hass: HomeAssistant,
    *,
    logger_names: list[str] | None,
    max_duration: int = 300,
    level_overrides: dict[str, str] | None = None,
    excludes: dict[str, list[str]] | None = None,
) -> tuple[str | None, dict]:
    """Start a recording session.

    Returns (error_key, result); error_key is None on success.
    """
    recording = hass.data[DOMAIN].get("recording", {})
    if recording.get("status") in ("recording", "completed"):
        return "already_recording", {}
    if not logger_names:
        return "no_loggers", {}

    managed = hass.data[DOMAIN].get("loggers", {})
    unknown = set(logger_names) - set(managed.keys())
    if unknown:
        return "unknown_logger", {"loggers": sorted(unknown)}

    normalized_excludes: dict[str, list[str]] = {}
    for logger_name, paths in (excludes or {}).items():
        if logger_name not in logger_names:
            return "invalid_excludes", {"logger": logger_name}
        clean_paths = []
        for path in paths:
            path = path.strip()
            segments = path.split(".")
            if (
                not path
                or not path.startswith(logger_name + ".")
                or any(not segment for segment in segments)
            ):
                return "invalid_excludes", {"path": path}
            clean_paths.append(path)
        # An exclusion must not swallow another selected logger.
        for path in clean_paths:
            for other in logger_names:
                if other != logger_name and (
                    other == path or other.startswith(path + ".")
                ):
                    return "invalid_excludes", {"path": path, "logger": other}
        normalized_excludes[logger_name] = clean_paths

    handler = LogRecordingHandler(
        hass, frozenset(logger_names), level_overrides, normalized_excludes
    )
    logging.root.addHandler(handler)

    start_time = time.time()

    def _recording_timeout(now):
        rec = hass.data[DOMAIN].get("recording", {})
        if rec.get("status") == "recording":
            rec["status"] = "completed"
            h = rec.get("handler")
            if h:
                rec["logs"] = h.snapshot()
                rec["log_count"] = len(rec["logs"])
                rec["logger_counts"] = h.counts_snapshot()
                logging.root.removeHandler(h)
            rec["duration"] = round(time.time() - rec.get("start_time", time.time()), 1)
            rec["cancel_timer"] = None
            _fire_recording_completed(
                hass,
                rec.get("log_count", 0),
                rec.get("duration", 0),
                rec.get("loggers", []),
            )

    cancel_timer = async_call_later(hass, max_duration, _recording_timeout)

    hass.data[DOMAIN]["recording"] = {
        "handler": handler,
        "start_time": start_time,
        "status": "recording",
        "cancel_timer": cancel_timer,
        "max_duration": max_duration,
        "loggers": sorted(logger_names),
    }

    _LOGGER.info(
        "Started recording %s loggers for max %s seconds.",
        len(logger_names), max_duration
    )

    return None, {"status": "recording", "max_duration": max_duration}


def stop_recording_session(hass: HomeAssistant) -> tuple[str | None, dict]:
    """End a recording session and return the captured events.

    Idempotent: an already-completed session returns its retained snapshot.
    Returns (error_key, result).
    """
    recording = hass.data[DOMAIN].get("recording", {})
    if recording.get("status") not in ("recording", "completed"):
        return "not_recording", {}

    if recording.get("status") == "completed":
        logs = recording.get("logs", [])
        return None, {
            "logs": logs,
            "duration": recording.get("duration", 0),
            "log_count": recording.get("log_count", len(logs)),
            "loggers": recording.get("loggers", []),
            "status": "completed",
        }

    cancel_timer = recording.get("cancel_timer")
    if cancel_timer:
        cancel_timer()

    handler = recording.get("handler")
    if handler:
        logging.root.removeHandler(handler)

    logs = handler.snapshot() if handler else []
    duration = time.time() - recording.get("start_time", time.time())
    log_count = len(logs)
    logger_counts = handler.counts_snapshot() if handler else {}

    # Retain the snapshot so the frontend can view it until explicitly
    # discarded via log_manager/discard_recording.
    hass.data[DOMAIN]["recording"] = {
        "status": "completed",
        "logs": logs,
        "log_count": log_count,
        "logger_counts": logger_counts,
        "duration": round(duration, 1),
        "loggers": recording.get("loggers", []),
        "start_time": recording.get("start_time", time.time()),
        "max_duration": recording.get("max_duration", 300),
    }

    _LOGGER.info(
        "Stopped recording after %.1f seconds, %s entries.",
        duration, log_count
    )

    _fire_recording_completed(
        hass, log_count, round(duration, 1), recording.get("loggers", [])
    )

    return None, {
        "logs": logs,
        "duration": round(duration, 1),
        "log_count": log_count,
        "loggers": recording.get("loggers", []),
        "status": "completed",
    }


def _fire_recording_completed(
    hass: HomeAssistant, log_count: int, duration: float, loggers: list
) -> None:
    """Fire the recording-completed event with a small summary payload."""
    hass.bus.async_fire(
        f"{DOMAIN}_recording_completed",
        {"log_count": log_count, "duration": duration, "loggers": list(loggers)},
    )


def discard_recording_session(hass: HomeAssistant) -> dict:
    """End any session and clear retained results."""
    recording = hass.data[DOMAIN].get("recording", {})
    if recording.get("status") in ("recording", "completed"):
        cancel_timer = recording.get("cancel_timer")
        if cancel_timer:
            cancel_timer()
        handler = recording.get("handler")
        if handler:
            logging.root.removeHandler(handler)
        _LOGGER.info("Discarded recording session.")
    hass.data[DOMAIN]["recording"] = {"status": "none"}
    return {"status": "none"}


def _resolve_start_args(
    hass: HomeAssistant, call_data: dict
) -> tuple[list[str] | None, int, dict[str, str], dict[str, list[str]], str | None]:
    """Resolve a start request (service or websocket) into session arguments.

    Returns (loggers, max_duration, level_overrides, excludes, error_key);
    error_key is None on success.
    """
    profile_name = call_data.get("profile")
    level_overrides = call_data.get("level_overrides", {}) or {}
    excludes = call_data.get("excludes", {}) or {}
    max_duration = call_data.get("max_duration", 300)

    if profile_name:
        stored = get_profile(hass, profile_name)
        if stored is None:
            return None, max_duration, {}, {}, "profile_not_found"
        loggers = list(stored.get("loggers", []))
        level_overrides = {**stored.get("level_overrides", {}), **level_overrides}
        if "max_duration" not in call_data or call_data["max_duration"] == 300:
            max_duration = stored.get("max_duration", max_duration)
        return loggers, max_duration, level_overrides, excludes, None

    loggers = list(call_data.get("loggers") or [])
    if not loggers:
        return None, max_duration, {}, {}, "no_loggers"
    return loggers, max_duration, level_overrides, excludes, None


def async_register_recording_commands(hass: HomeAssistant) -> None:
    """Register the recording websocket commands."""
    websocket_api.async_register_command(hass, ws_start_recording)
    websocket_api.async_register_command(hass, ws_stop_recording)
    websocket_api.async_register_command(hass, ws_discard_recording)
    websocket_api.async_register_command(hass, ws_clear_recording)
    websocket_api.async_register_command(hass, ws_recording_status)
    websocket_api.async_register_command(hass, ws_recording_entries)


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/start_recording",
    vol.Optional("loggers", default=[]): vol.All(cv.ensure_list, [cv.string]),
    vol.Optional("profile"): cv.string,
    vol.Optional("max_duration", default=300): vol.All(
        vol.Coerce(int), vol.Range(min=10, max=3600)
    ),
    vol.Optional("level_overrides", default={}): vol.Schema(
        {cv.string: vol.In(LOG_LEVELS_LIST)}
    ),
    vol.Optional("excludes", default={}): vol.Schema(
        {cv.string: vol.All(cv.ensure_list, [cv.string])}
    ),
})
@websocket_api.async_response
async def ws_start_recording(hass: HomeAssistant, connection, msg: dict):
    """
    Start recording log events for the specified managed loggers.
    """

    loggers, max_duration, level_overrides, excludes, err = _resolve_start_args(
        hass, msg
    )
    if err:
        connection.send_error(msg["id"], err, f"Invalid start request: {err}")
        return

    err, result = start_recording_session(
        hass,
        logger_names=loggers,
        max_duration=max_duration,
        level_overrides=level_overrides,
        excludes=excludes,
    )
    if err:
        extra = result
        if err == "unknown_logger":
            connection.send_error(
                msg["id"], err,
                f"Unknown loggers: {', '.join(extra.get('loggers', []))}"
            )
        else:
            connection.send_error(msg["id"], err, f"Cannot start recording: {err}")
        return

    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/stop_recording"})
@websocket_api.async_response
async def ws_stop_recording(hass: HomeAssistant, connection, msg: dict):
    """
    Stop recording and return buffered logs.

    The buffered logs are retained in the session until the frontend
    explicitly discards them, so the result can be fetched multiple times.
    """

    err, result = stop_recording_session(hass)
    if err:
        connection.send_error(
            msg["id"], err, "No recording session is active."
        )
        return

    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/discard_recording"})
@websocket_api.async_response
async def ws_discard_recording(hass: HomeAssistant, connection, msg: dict):
    """
    Discard a completed recording session and clear its buffered logs.

    The frontend can fetch the retained results any number of times until
    this command is issued.
    """

    connection.send_result(msg["id"], discard_recording_session(hass))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/clear_recording"})
@websocket_api.async_response
async def ws_clear_recording(hass: HomeAssistant, connection, msg: dict):
    """
    Clear the buffered entries of an active recording without stopping it.
    """

    recording = hass.data[DOMAIN].get("recording", {})
    if recording.get("status") != "recording":
        connection.send_error(
            msg["id"], "not_recording",
            "No active recording session."
        )
        return

    handler = recording.get("handler")
    if handler:
        handler.clear()

    connection.send_result(msg["id"], {"status": "recording"})


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
        result["max_duration"] = recording.get("max_duration", 300)
        result["loggers"] = list(recording.get("loggers", []))
        if status == "recording":
            handler = recording.get("handler")
            result["log_count"] = handler.count() if handler else 0
            result["logger_counts"] = handler.counts_snapshot() if handler else {}
        else:
            # Completed sessions retain their snapshot until discarded.
            result["log_count"] = recording.get("log_count", 0)
            result["logger_counts"] = recording.get("logger_counts", {})

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


START_RECORDING_SERVICE_SCHEMA = vol.Schema({
    vol.Optional("loggers"): vol.All(cv.ensure_list, [cv.string]),
    vol.Optional("profile"): cv.string,
    vol.Optional("max_duration", default=300): vol.All(
        vol.Coerce(int), vol.Range(min=10, max=3600)
    ),
    vol.Optional("level_overrides", default={}): vol.Schema(
        {cv.string: vol.In(LOG_LEVELS_LIST)}
    ),
    vol.Optional("excludes", default={}): vol.Schema(
        {cv.string: vol.All(cv.ensure_list, [cv.string])}
    ),
})


def async_register_recording_services(hass: HomeAssistant) -> None:
    """Register recording as scriptable HA services."""

    async def service_start_recording(call):
        loggers, max_duration, level_overrides, excludes, err = _resolve_start_args(
            hass, call.data
        )
        if err:
            _LOGGER.error("start_recording failed: %s", err)
            return
        err, _ = start_recording_session(
            hass,
            logger_names=loggers or [],
            max_duration=max_duration,
            level_overrides=level_overrides,
            excludes=excludes,
        )
        if err:
            _LOGGER.error("start_recording failed: %s", err)
            return
        _LOGGER.info("Recording started via service for %s loggers.", len(loggers or []))

    async def service_stop_recording(call):
        err, result = stop_recording_session(hass)
        if err:
            _LOGGER.error("stop_recording failed: %s", err)
            return
        _LOGGER.info(
            "Recording stopped via service: %s entries.",
            result.get("log_count", 0),
        )
        return result

    async def service_discard_recording(call):
        discard_recording_session(hass)
        _LOGGER.info("Recording discarded via service.")

    hass.services.async_register(
        DOMAIN,
        "start_recording",
        service_start_recording,
        schema=START_RECORDING_SERVICE_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN, "stop_recording", service_stop_recording,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, "discard_recording", service_discard_recording
    )


def async_stop_recording_session(hass: HomeAssistant) -> None:
    """Remove any active recording handler and clear the session state (unload path)."""
    recording = hass.data.get(DOMAIN, {}).get("recording", {})
    if recording.get("status") == "recording":
        cancel_timer = recording.get("cancel_timer")
        if cancel_timer:
            cancel_timer()
        handler = recording.get("handler")
        if handler:
            logging.root.removeHandler(handler)
    hass.data.get(DOMAIN, {}).pop("recording", None)