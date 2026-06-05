import logging
import os
import time
import voluptuous as vol
import mimetypes

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.components import websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store

DOMAIN = "log_manager"
STORAGE_KEY = f"{DOMAIN}.config"
STORAGE_VERSION = 2

_LOGGER = logging.getLogger(__name__)


class LogCounterHandler(logging.Handler):
    """Count warnings and errors for managed loggers."""

    MAX_RECENT = 10

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(logging.WARNING)
        self.hass = hass

    def emit(self, record: logging.LogRecord) -> None:
        try:
            loggers = self.hass.data.get(DOMAIN, {}).get("loggers", {})
            if not loggers:
                return

            # Match the record against managed loggers, including child loggers.
            # e.g. "custom_components.voice_satellite.sensor" matches
            # the managed logger "custom_components.voice_satellite".
            matched_name = None
            if record.name in loggers:
                matched_name = record.name
            else:
                for name in loggers:
                    if record.name.startswith(name + "."):
                        matched_name = name
                        break

            if matched_name is None:
                return

            counters = self.hass.data[DOMAIN]["counters"]
            if matched_name not in counters:
                counters[matched_name] = {
                    "warning": 0, "error": 0,
                    "last_warning": "", "last_error": "",
                    "recent_logs": []
                }

            msg = record.getMessage()
            level_name = record.levelname
            source = f"{record.pathname}:{record.lineno}" if record.pathname else ""

            entry = {
                "timestamp": record.created,
                "level": level_name,
                "message": msg,
                "source": source
            }

            recent = counters[matched_name]["recent_logs"]
            recent.insert(0, entry)
            if len(recent) > self.MAX_RECENT:
                del recent[self.MAX_RECENT:]

            if record.levelno >= logging.ERROR:
                counters[matched_name]["error"] += 1
                counters[matched_name]["last_error"] = msg
            else:
                counters[matched_name]["warning"] += 1
                counters[matched_name]["last_warning"] = msg
        except Exception:
            self.handleError(record)


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
        self.buffer = []
        self.level_overrides = level_overrides or {}
        self.logger_counts: dict[str, int] = {}
        self._next_entry_id: int = 0

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

            entry_id = self._next_entry_id
            self._next_entry_id += 1
            entry = {
                "id": entry_id,
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
            self.buffer.append(entry)
            if len(self.buffer) > self.MAX_BUFFER_SIZE:
                self.buffer.pop(0)
            self.logger_counts[matched] = self.logger_counts.get(matched, 0) + 1
        except Exception:
            self.handleError(record)

    def _match_logger(self, name: str) -> str | None:
        if name in self.logger_names:
            return name
        for logger_name in self.logger_names:
            if name.startswith(logger_name + "."):
                return logger_name
        return None


class LogManagerStore(Store):
    """
    Custom storage handling to manage migrations between configuration versions.
    """

    async def _async_migrate_func(
        self, old_major_version: int, old_minor_version: int, old_data: dict
    ) -> dict:
        """
        Migrate old configuration to the new dictionary-based format.
        """

        _LOGGER.info("Migrating storage to version %s.", STORAGE_VERSION)

        if old_major_version == 1:
            new_loggers = {}

            for name, friendly_name in old_data.get("loggers", {}).items():
                # We cannot read RestoreEntity DB here, so we grab current effective level.
                current_level = logging.getLogger(name).getEffectiveLevel()
                level_name = logging.getLevelName(current_level)
                new_loggers[name] = {
                    "friendly_name": friendly_name,
                    "level": level_name
                }
                _LOGGER.debug("Migrated logger '%s'.", friendly_name)

            old_data["loggers"] = new_loggers
            _LOGGER.info("Migrated %s loggers.", len(new_loggers))

        return old_data

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """
    Set up Log Manager from a UI config entry.
    """

    hass.data.setdefault(DOMAIN, {})

    # Register the websocket command as early as possible to avoid frontend errors.
    websocket_api.async_register_command(hass, ws_get_loggers)
    websocket_api.async_register_command(hass, ws_get_stats)

    # Initialize the custom storage object once and bind it to the domain data.
    store = LogManagerStore(hass, STORAGE_VERSION, STORAGE_KEY)
    hass.data[DOMAIN]["store"] = store

    stored_data = await store.async_load() or {"loggers": {}}
    stored_loggers = stored_data.get("loggers", {})
    cleaned_loggers = {}

    # Apply log levels early.
    # We cannot check if loggers exist yet as other components might not be loaded.
    for logger_name, info in stored_loggers.items():
        cleaned_loggers[logger_name] = info
        level = info.get("level", "NOTSET")
        if level != "NOTSET":
            _LOGGER.info("Restoring log level of '%s' to %s.", logger_name, level)
            logging.getLogger(logger_name).setLevel(level)

    hass.data[DOMAIN]["loggers"] = cleaned_loggers

    # Register recording websocket commands.
    websocket_api.async_register_command(hass, ws_start_recording)
    websocket_api.async_register_command(hass, ws_stop_recording)
    websocket_api.async_register_command(hass, ws_recording_status)
    websocket_api.async_register_command(hass, ws_recording_entries)

    hass.data[DOMAIN]["recording"] = {"status": "none"}

    # Initialize warning/error counters for each stored logger.
    hass.data[DOMAIN]["counters"] = {
        name: {"warning": 0, "error": 0, "last_warning": "", "last_error": "", "recent_logs": []} for name in cleaned_loggers
    }

    # Register the counter handler to track warnings and errors for managed loggers.
    counter_handler = LogCounterHandler(hass)
    logging.root.addHandler(counter_handler)
    hass.data[DOMAIN]["counter_handler"] = counter_handler

    # Force Python to recognize JavaScript files, running the disk I/O in a background
    # thread to avoid blocking the Home Assistant event loop.
    await hass.async_add_executor_job(mimetypes.init)
    mimetypes.add_type("application/javascript", ".js")

    # Register the static path so the HTTP component can serve the JavaScript file.
    local_path = hass.config.path(f"custom_components/{DOMAIN}/www/{DOMAIN}")
    if os.path.exists(local_path):
        await hass.http.async_register_static_paths([
            StaticPathConfig(f"/{DOMAIN}_ui", local_path, False)
        ])

    # Schedule the resource registration to run asynchronously.
    hass.async_create_task(async_register_lovelace_resource(hass))

    async def save_data():
        """
        Save the current list of loggers to storage.
        """

        await hass.data[DOMAIN]["store"].async_save(
            {"loggers": hass.data[DOMAIN]["loggers"]}
        )

    # Expose the save function so select.py can trigger it.
    hass.data[DOMAIN]["save_data"] = save_data

    async def add_logger(call):
        """
        Handle the service call to add a new logger.
        """

        logger_name = call.data.get("logger_name")
        friendly_name = call.data.get("friendly_name")
        _LOGGER.info(
            "Request to add logger configuration for '%s' (%s).",
            friendly_name,
            logger_name
        )

        # Access current stored loggers to check for duplicates.
        stored_loggers = hass.data[DOMAIN]["loggers"]

        # Validation.
        if logger_name in stored_loggers:
            _LOGGER.warning("Logger path '%s' is already being managed.", logger_name)
            return

        if friendly_name in stored_loggers.values():
            _LOGGER.warning("Name '%s' is already in use.", friendly_name)
            return

        # Register the new configuration in memory and storage.
        stored_loggers[logger_name] = {
            "friendly_name": friendly_name,
            "level": "NOTSET"
        }
        hass.data[DOMAIN]["loggers"] = stored_loggers

        # Initialize counters for the new logger.
        hass.data[DOMAIN]["counters"][logger_name] = {"warning": 0, "error": 0, "last_warning": "", "last_error": "", "recent_logs": []}

        await save_data()

        # Dispatch signal to select.py to create the new entity.
        async_dispatcher_send(hass, f"{DOMAIN}_add_logger", logger_name, friendly_name)

    async def remove_logger(call):
        """
        Service call to remove an existing logger entity.
        """

        logger_name = call.data.get("logger_name")
        friendly_name = call.data.get("friendly_name")
        _LOGGER.info(
            "Request to remove logger configuration for '%s' (%s).",
            friendly_name,
            logger_name
        )

        if logger_name in hass.data[DOMAIN]["loggers"]:
            del hass.data[DOMAIN]["loggers"][logger_name]
            hass.data[DOMAIN]["counters"].pop(logger_name, None)
            await save_data()
            async_dispatcher_send(hass, f"{DOMAIN}_remove_logger", logger_name)

    hass.services.async_register(
        DOMAIN,
        "add_logger",
        add_logger,
        schema=vol.Schema({
            vol.Required("logger_name"): cv.string,
            vol.Optional("friendly_name"): cv.string,
        })
    )

    hass.services.async_register(
        DOMAIN,
        "remove_logger",
        remove_logger,
        schema=vol.Schema({
            vol.Required("logger_name"): cv.string,
            vol.Optional("friendly_name"): cv.string,
        })
    )

    async def reset_counters(call):
        """
        Reset warning and error counters for one or all managed loggers.
        """

        logger_name = call.data.get("logger_name")
        counters = hass.data[DOMAIN]["counters"]

        if logger_name:
            if logger_name in counters:
                counters[logger_name] = {"warning": 0, "error": 0, "last_warning": "", "last_error": "", "recent_logs": []}
                _LOGGER.info("Reset counters for '%s'.", logger_name)
        else:
            for name in counters:
                counters[name] = {"warning": 0, "error": 0, "last_warning": "", "last_error": "", "recent_logs": []}
            _LOGGER.info("Reset counters for all loggers.")

    hass.services.async_register(
        DOMAIN,
        "reset_counters",
        reset_counters,
        schema=vol.Schema({
            vol.Optional("logger_name"): cv.string,
        })
    )

    # Forward the setup to the select platform so it can create the entities.
    await hass.config_entries.async_forward_entry_setups(entry, ["select"])

    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """
    Unload a config entry when the user deletes it from the UI.
    """

    unload_ok = await hass.config_entries.async_unload_platforms(entry, ["select"])

    if unload_ok:
        # Stop any active recording session.
        recording = hass.data[DOMAIN].get("recording", {})
        if recording.get("status") == "recording":
            cancel_timer = recording.get("cancel_timer")
            if cancel_timer:
                cancel_timer()
            handler = recording.get("handler")
            if handler:
                logging.root.removeHandler(handler)
        hass.data[DOMAIN].pop("recording", None)

        # Remove the counter handler from the root logger.
        handler = hass.data[DOMAIN].pop("counter_handler", None)
        if handler:
            logging.root.removeHandler(handler)

        hass.data[DOMAIN].pop("loggers", None)
        hass.data[DOMAIN].pop("counters", None)

    return unload_ok

@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get_loggers"})
@websocket_api.async_response
async def ws_get_loggers(hass: HomeAssistant, connection, msg: dict):
    """
    WebSocket command to retrieve all active Python loggers.
    """

    # Retrieve all instantiated logger names from the root manager.
    loggers = list(logging.root.manager.loggerDict.keys())
    loggers.sort()
    _LOGGER.info("Returning list of %s loggers.", len(loggers))

    connection.send_result(msg["id"], loggers)

@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get_stats"})
@websocket_api.async_response
async def ws_get_stats(hass: HomeAssistant, connection, msg: dict):
    """
    WebSocket command to retrieve warning and error counters for managed loggers.
    """

    counters = hass.data.get(DOMAIN, {}).get("counters", {})
    _LOGGER.debug("Returning stats for %s loggers.", len(counters))

    connection.send_result(msg["id"], counters)

LOG_LEVELS_LIST = ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]

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

    buffer = list(handler.buffer) if handler else []
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
        result["log_count"] = len(handler.buffer) if handler else 0
        result["max_duration"] = recording.get("max_duration", 300)
        result["loggers"] = list(recording.get("loggers", []))
        result["logger_counts"] = handler.logger_counts if handler else {}

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

    after_id = msg["after_id"]
    # Buffer is oldest-first. Scan from end for efficiency.
    result_entries = []
    for entry in reversed(handler.buffer):
        if entry["id"] <= after_id:
            break
        result_entries.append(entry)
    result_entries.reverse()

    next_id = handler._next_entry_id

    connection.send_result(msg["id"], {
        "entries": result_entries,
        "next_id": next_id,
    })


async def async_register_lovelace_resource(hass: HomeAssistant) -> None:
    """
    Add the custom card to Lovelace resources if it is not already present.
    """

    js_path = hass.config.path(f"custom_components/{DOMAIN}/www/{DOMAIN}/log_manager_card.js")
    version = "1"

    try:
        mtime = os.path.getmtime(js_path)
        version = str(mtime).replace(".", "")
    except OSError:
        _LOGGER.warning("Could not read modification time for Log Manager JS file.")

    resource_url = f"/{DOMAIN}_ui/log_manager_card.js?v={version}"

    if "lovelace" not in hass.data:
        return

    lovelace_data = hass.data["lovelace"]

    if not hasattr(lovelace_data, "resources"):
        return

    resources = lovelace_data.resources

    if not resources.loaded:
        await resources.async_load()

    for item in resources.async_items():
        item_url = item.url if hasattr(item, "url") else item.get("url")

        if item_url and item_url.startswith(f"/{DOMAIN}_ui/log_manager_card.js"):
            if item_url != resource_url:
                _LOGGER.info("Updating Log Manager resource URL to new version.")
                item_id = item.id if hasattr(item, "id") else item.get("id")
                await resources.async_update_item(
                    item_id,
                    {"res_type": "module", "url": resource_url}
                )
            return

    await resources.async_create_item({"res_type": "module", "url": resource_url})
