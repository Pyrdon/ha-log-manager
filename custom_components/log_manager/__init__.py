import copy
import hashlib
import logging
import mimetypes
import os
import re
import threading

import voluptuous as vol

from homeassistant.components import persistent_notification, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store

from .const import (
    ALERT_DISABLED,
    DEFAULT_ALERT_LEVEL,
    DOMAIN,
    LOG_LEVELS_LIST,
    STORAGE_KEY,
    STORAGE_VERSION,
    match_managed_logger,
    record_audit,
)
from .core_sync import (
    _core_overrides,
    is_core_pinned,
    reconcile_with_core,
    register_core_sync,
)
from .profiles import async_register_profile_commands
from .recording import (
    async_register_recording_commands,
    async_register_recording_services,
    async_stop_recording_session,
)

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
        _schedule_alert(self.hass, logger_name, qualifying, alert_level, threshold)

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


def _schedule_alert(
    hass: HomeAssistant,
    logger_name: str,
    count: int,
    alert_level: str,
    threshold: int,
) -> None:
    """Schedule a persistent notification for a threshold crossing."""

    def _create() -> None:
        hass.async_create_task(
            _create_alert_notification(hass, logger_name, count, alert_level, threshold)
        )

    try:
        hass.loop.call_soon_threadsafe(_create)
    except RuntimeError:
        pass


def _alert_notification_id(logger_name: str) -> str:
    """Return the stable persistent-notification id for a logger's alert.

    Shared by creation and dismissal so both address the same notification.
    """
    safe_name = re.sub(r"[^a-z0-9_]", "_", logger_name.lower())
    digest = hashlib.sha1(logger_name.encode("utf-8")).hexdigest()[:8]
    return f"log_manager_alert_{safe_name}_{digest}"


def _alert_display_name(hass: HomeAssistant, logger_name: str) -> str:
    """Return the friendly name for a logger, falling back to its path."""
    info = hass.data.get(DOMAIN, {}).get("loggers", {}).get(logger_name, {})
    friendly = info.get("friendly_name")
    return friendly if friendly else logger_name


async def _create_alert_notification(
    hass: HomeAssistant,
    logger_name: str,
    count: int,
    alert_level: str,
    threshold: int,
) -> None:
    """Create a persistent notification for a managed logger's alert threshold."""
    unit = "event" if count == 1 else "events"
    title = f"Log Manager: {_alert_display_name(hass, logger_name)}"
    persistent_notification.async_create(
        hass,
        f"'{logger_name}' has logged {count} counted {unit} at "
        f"{alert_level} or above since the counters were last reset "
        f"(threshold {threshold}). [View logs](/config/logs)",
        title,
        _alert_notification_id(logger_name),
    )


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

        if old_major_version < 3:
            # Schema v3: alert threshold and level-change audit trail.
            for info in old_data.get("loggers", {}).values():
                if not isinstance(info, dict):
                    continue
                info.setdefault("alert_threshold", ALERT_DISABLED)
                info.setdefault("alert_level", DEFAULT_ALERT_LEVEL)
                info.setdefault("audit", [])
            _LOGGER.info("Migrated %s loggers to schema v3.", len(old_data.get("loggers", {})))

        # Whatever legacy shape is being upgraded, blank/whitespace logger keys
        # are meaningless and the removed sensor-opt-in and count-level fields
        # must not survive. Run last so no earlier block can reintroduce them.
        loggers = old_data.get("loggers", {})
        cleaned = {}
        for name, info in loggers.items():
            if not isinstance(name, str) or not name.strip():
                _LOGGER.warning("Dropping blank logger key during migration.")
                continue
            if isinstance(info, dict):
                info.pop("sensor_enabled", None)
                info.pop("count_level", None)
            cleaned[name] = info
        old_data["loggers"] = cleaned

        return old_data

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """
    Set up Log Manager from a UI config entry.
    """

    hass.data.setdefault(DOMAIN, {})

    # Register the websocket command as early as possible to avoid frontend errors.
    websocket_api.async_register_command(hass, ws_get_loggers)
    websocket_api.async_register_command(hass, ws_get_stats)
    websocket_api.async_register_command(hass, ws_set_levels)

    # Initialize the custom storage object once and bind it to the domain data.
    store = LogManagerStore(hass, STORAGE_VERSION, STORAGE_KEY)
    hass.data[DOMAIN]["store"] = store

    stored_data = await store.async_load() or {"loggers": {}}
    stored_loggers = stored_data.get("loggers", {})
    cleaned_loggers = {}

    # Apply log levels early.
    # We cannot check if loggers exist yet as other components might not be loaded.
    # Also cleanse stores already at the current version, which do not re-run
    # migrations: drop blank keys and any lingering legacy flags (sensor opt-in,
    # the removed count level).
    for logger_name, info in stored_loggers.items():
        if not isinstance(logger_name, str) or not logger_name.strip():
            _LOGGER.warning("Dropping blank logger key on load.")
            continue
        if not isinstance(info, dict):
            _LOGGER.warning("Dropping malformed record for '%s' on load.", logger_name)
            continue
        info.pop("sensor_enabled", None)
        info.pop("count_level", None)
        cleaned_loggers[logger_name] = info
        level = info.get("level", "NOTSET")
        if level != "NOTSET":
            _LOGGER.info("Restoring log level of '%s' to %s.", logger_name, level)
            logging.getLogger(logger_name).setLevel(level)

    hass.data[DOMAIN]["loggers"] = cleaned_loggers
    hass.data[DOMAIN]["profiles"] = stored_data.get("profiles", {})

    # Register recording websocket commands and initialize the session state.
    async_register_recording_commands(hass)
    hass.data[DOMAIN]["recording"] = {"status": "none"}

    # Initialize warning/error counters for each stored logger.
    hass.data[DOMAIN]["counters"] = {
        name: _empty_counters() for name in cleaned_loggers
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
        Save the current list of loggers and recording profiles to storage.
        """

        await hass.data[DOMAIN]["store"].async_save(
            {
                "loggers": hass.data[DOMAIN]["loggers"],
                "profiles": hass.data[DOMAIN]["profiles"],
            }
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

        # Validation. A blank or whitespace-only path is meaningless.
        if not isinstance(logger_name, str) or not logger_name.strip():
            _LOGGER.warning("Refusing to add a blank logger path.")
            return

        if logger_name in stored_loggers:
            _LOGGER.warning("Logger path '%s' is already being managed.", logger_name)
            return

        if friendly_name and friendly_name in (
            info.get("friendly_name") for info in stored_loggers.values()
        ):
            _LOGGER.warning("Name '%s' is already in use.", friendly_name)
            return

        # Register the new configuration in memory and storage.
        # A namespace already pinned by core starts at the pinned level so
        # the new row shows reality instead of an unappliable NOTSET.
        initial_level = "NOTSET"
        if is_core_pinned(hass, logger_name):
            initial_level = _core_overrides(hass)[logger_name]
            _LOGGER.info(
                "New logger '%s' starts at core-pinned level %s.",
                logger_name, initial_level,
            )
        stored_loggers[logger_name] = {
            "friendly_name": friendly_name,
            "level": initial_level,
            "alert_threshold": ALERT_DISABLED,
            "alert_level": DEFAULT_ALERT_LEVEL,
            "audit": [],
        }
        hass.data[DOMAIN]["loggers"] = stored_loggers

        # Initialize counters for the new logger.
        with counter_handler._lock:
            hass.data[DOMAIN]["counters"][logger_name] = _empty_counters()

        await save_data()

        # Dispatch signal to select.py to create the new entity, and to
        # sensor.py so the new logger's automatic count sensors appear.
        async_dispatcher_send(hass, f"{DOMAIN}_add_logger", logger_name, friendly_name)
        async_dispatcher_send(hass, f"{DOMAIN}_sensors_changed")

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
            with counter_handler._lock:
                hass.data[DOMAIN]["counters"].pop(logger_name, None)
            await save_data()
            async_dispatcher_send(hass, f"{DOMAIN}_remove_logger", logger_name)
            async_dispatcher_send(hass, f"{DOMAIN}_sensors_changed")

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
        Reset warning and error counters for one or all managed loggers,
        dismissing the matching alert notifications.
        """

        counter_handler = hass.data[DOMAIN]["counter_handler"]
        logger_name = call.data.get("logger_name")
        counter_handler.reset(logger_name)
        # Reset re-arms the alert; drop any notification it already raised.
        targets = (
            [logger_name]
            if logger_name
            else list(hass.data[DOMAIN].get("loggers", {}).keys())
        )
        for name in targets:
            if name:
                persistent_notification.async_dismiss(hass, _alert_notification_id(name))

    hass.services.async_register(
        DOMAIN,
        "reset_counters",
        reset_counters,
        schema=vol.Schema({
            vol.Optional("logger_name"): cv.string,
        })
    )

    async def set_alert_threshold(call):
        """Set the alert threshold and severity for a managed logger."""
        logger_name = call.data["logger_name"]
        threshold = call.data["events"]
        info = hass.data[DOMAIN]["loggers"].get(logger_name)
        if not info:
            _LOGGER.warning("set_alert_threshold: '%s' is not managed.", logger_name)
            return
        info["alert_threshold"] = threshold
        if "level" in call.data:
            info["alert_level"] = call.data["level"]
        # Re-arm the alert so the next crossing notifies again.
        counter = hass.data[DOMAIN]["counters"].get(logger_name)
        if counter:
            counter["alert_fired"] = False
        await save_data()
        # Refresh the select entity so the frontend sees the new alert settings.
        async_dispatcher_send(hass, f"{DOMAIN}_options_changed")
        # Notify immediately if the new threshold is already satisfied.
        counter_handler.check_alert(logger_name)
        _LOGGER.info(
            "Set alert threshold of '%s' to %s events at %s and above.",
            logger_name, threshold, info.get("alert_level", DEFAULT_ALERT_LEVEL),
        )

    hass.services.async_register(
        DOMAIN,
        "set_alert_threshold",
        set_alert_threshold,
        schema=vol.Schema({
            vol.Required("logger_name"): cv.string,
            vol.Required("events"): vol.All(vol.Coerce(int), vol.Range(min=0)),
            vol.Optional("level"): vol.In(["WARNING", "ERROR", "CRITICAL"]),
        })
    )

    # Mirror core logger overrides: adopt pins and refuse edits on those namespaces.
    hass.data[DOMAIN]["core_sync_unsub"] = register_core_sync(hass)
    reconcile_with_core(hass)

    # Recording profiles websocket commands and recording services.
    async_register_profile_commands(hass)
    async_register_recording_services(hass)

    # Forward the setup to the select and sensor platforms.
    await hass.config_entries.async_forward_entry_setups(entry, ["select", "sensor"])

    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """
    Unload a config entry when the user deletes it from the UI.
    """

    unload_ok = await hass.config_entries.async_unload_platforms(entry, ["select", "sensor"])

    if unload_ok:
        # Stop any active recording session and remove its handler.
        async_stop_recording_session(hass)

        # Remove the counter handler from the root logger.
        handler = hass.data[DOMAIN].pop("counter_handler", None)
        if handler:
            logging.root.removeHandler(handler)

        # Remove the core logger override sync listener.
        core_sync_unsub = hass.data[DOMAIN].pop("core_sync_unsub", None)
        if core_sync_unsub:
            core_sync_unsub()

        hass.data[DOMAIN].pop("loggers", None)
        hass.data[DOMAIN].pop("counters", None)
        hass.data[DOMAIN].pop("profiles", None)

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
    _LOGGER.debug("Returning list of %s loggers.", len(loggers))

    connection.send_result(msg["id"], loggers)

@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/get_stats"})
@websocket_api.async_response
async def ws_get_stats(hass: HomeAssistant, connection, msg: dict):
    """
    WebSocket command to retrieve warning and error counters for managed loggers.
    """

    counter_handler = hass.data.get(DOMAIN, {}).get("counter_handler")
    counters = counter_handler.snapshot() if counter_handler else {}
    _LOGGER.debug("Returning stats for %s loggers.", len(counters))

    connection.send_result(msg["id"], counters)


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/set_levels",
    vol.Required("level"): vol.In(LOG_LEVELS_LIST),
})
@websocket_api.async_response
async def ws_set_levels(hass: HomeAssistant, connection, msg: dict):
    """Set the level of every managed logger, skipping core-pinned namespaces.

    Returns the changed and skipped counts plus the skipped logger names.
    """
    if DOMAIN not in hass.data:
        connection.send_error(msg["id"], "not_loaded", "Log Manager is not loaded.")
        return

    level = msg["level"]
    loggers = hass.data[DOMAIN].get("loggers", {})
    changed = 0
    already = 0
    skipped: list[str] = []

    for logger_name, info in loggers.items():
        if is_core_pinned(hass, logger_name):
            skipped.append(logger_name)
            continue
        if info.get("level") == level:
            # Already at the requested level: nothing to persist or announce.
            already += 1
            continue
        old_level = info.get("level", "NOTSET")
        logging.getLogger(logger_name).setLevel(level)
        record_audit(info, old_level, level, "ui")
        info["level"] = level
        changed += 1

    save = hass.data[DOMAIN].get("save_data")
    if save and changed:
        await save()
    async_dispatcher_send(hass, f"{DOMAIN}_levels_changed")
    _LOGGER.info(
        "Set level %s: %s changed, %s already at level, %s skipped.",
        level, changed, already, len(skipped),
    )
    connection.send_result(
        msg["id"],
        {
            "changed": changed,
            "already": already,
            "skipped": len(skipped),
            "skipped_loggers": skipped,
        },
    )


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
