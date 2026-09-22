"""Recording session lifecycle: start, stop, discard and level restoration."""

import logging
import time

from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_call_later

from .const import DOMAIN
from .profiles import get_profile
from .recording_handler import LogRecordingHandler

_LOGGER = logging.getLogger(__name__)


def start_recording_session(
    hass: HomeAssistant,
    *,
    logger_names: list[str] | None,
    max_duration: int = 300,
    level_overrides: dict[str, str] | None = None,
    excludes: dict[str, list[str]] | None = None,
    raise_levels: dict[str, dict] | None = None,
) -> tuple[str | None, dict]:
    """Start a recording session.

    ``raise_levels`` maps a logger name to the level it should be restored to
    (``{"entity_id", "from", "to"}``). The session owns these intents so the
    revert still happens when the requesting card is gone (reload, unload,
    timeout).

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
            _restore_recording_levels(hass, rec)
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
        "level_restore": dict(raise_levels or {}),
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

    _restore_recording_levels(hass, recording)

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


def _restore_recording_levels(hass: HomeAssistant, recording: dict) -> None:
    """Revert logger levels raised to make a recording more verbose.

    The session owns the intents, so this still runs when the requesting card
    is gone. Safe to call repeatedly: the stored intents are cleared on first
    use.
    """
    restore = recording.pop("level_restore", None)
    if not restore:
        return
    for logger_name, info in restore.items():
        entity_id = info.get("entity_id")
        level = info.get("from")
        if not level:
            continue
        if entity_id and hass.states.get(entity_id) is not None:
            # Prefer the select service so HA state, storage and the audit
            # trail stay consistent.
            hass.async_create_task(
                hass.services.async_call(
                    "select",
                    "select_option",
                    {"entity_id": entity_id, "option": level},
                    blocking=False,
                )
            )
        else:
            # On unload the select entity is already gone; revert the Python
            # logger directly so a raised level never outlives the session.
            logging.getLogger(logger_name).setLevel(level)
    _LOGGER.info("Restored %s raised logger level(s) after a recording.", len(restore))


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
        _restore_recording_levels(hass, recording)
        _LOGGER.info("Discarded recording session.")
    hass.data[DOMAIN]["recording"] = {"status": "none"}
    return {"status": "none"}


def _is_descendant_path(logger_name: str, path: str) -> bool:
    """Return True when path is a strict, non-empty dotted descendant."""
    if not path or not path.startswith(logger_name + "."):
        return False
    return all(segment.strip() for segment in path.split("."))


def _profile_excludes(
    stored_excludes: dict | None,
    loggers: list[str],
) -> dict[str, list[str]]:
    """Return a profile's stored exclusions, dropping invalid paths.

    A profile run uses its own exclusions verbatim: the request's ``excludes``
    are ignored when a profile is named, so the profile is the single source of
    truth for that recording. Invalid stored paths are dropped with a warning
    rather than failing the session.
    """
    resolved: dict[str, list[str]] = {}
    for logger_name in loggers:
        seen: list[str] = []
        for path in list((stored_excludes or {}).get(logger_name, [])):
            if not _is_descendant_path(logger_name, path):
                _LOGGER.warning(
                    "Dropping invalid stored exclusion '%s' for '%s'.",
                    path, logger_name,
                )
                continue
            if path not in seen:
                seen.append(path)
        if seen:
            resolved[logger_name] = seen
    return resolved


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
        # Overrides stay request-wins; exclusions come from the profile only.
        level_overrides = {**stored.get("level_overrides", {}), **level_overrides}
        excludes = _profile_excludes(stored.get("excludes", {}), loggers)
        if "max_duration" not in call_data or call_data["max_duration"] == 300:
            max_duration = stored.get("max_duration", max_duration)
        return loggers, max_duration, level_overrides, excludes, None

    loggers = list(call_data.get("loggers") or [])
    if not loggers:
        return None, max_duration, {}, {}, "no_loggers"
    return loggers, max_duration, level_overrides, excludes, None


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
    _restore_recording_levels(hass, recording)
    hass.data.get(DOMAIN, {}).pop("recording", None)
