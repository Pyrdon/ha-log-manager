import logging

import voluptuous as vol

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .alerts import _alert_notification_id
from .const import (
    ALERT_DISABLED,
    DEFAULT_ALERT_LEVEL,
    DOMAIN,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from .core_sync import (
    _core_overrides,
    is_core_pinned,
    reconcile_with_core,
    register_core_sync,
)
from .counter import LogCounterHandler, _empty_counters
from .lovelace import (
    async_register_lovelace_resource,
    async_register_static_paths,
)
from .profiles import async_register_profile_commands
from .recording_api import (
    async_register_recording_commands,
    async_register_recording_services,
)
from .recording_session import async_stop_recording_session
from .storage import LogManagerStore
from .websocket import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """
    Set up Log Manager from a UI config entry.
    """

    hass.data.setdefault(DOMAIN, {})

    # Register the websocket commands as early as possible to avoid frontend errors.
    async_register_websocket_commands(hass)

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
            _LOGGER.warning("Dropped blank logger key on load.")
            continue
        if not isinstance(info, dict):
            _LOGGER.warning("Dropped malformed record for '%s' on load.", logger_name)
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

    # Serve the card assets and register the Lovelace resource.
    await async_register_static_paths(hass)

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

        # Access current stored loggers to check for duplicates.
        stored_loggers = hass.data[DOMAIN]["loggers"]

        # Validation. A blank or whitespace-only path is meaningless.
        if not isinstance(logger_name, str) or not logger_name.strip():
            _LOGGER.warning("Ignoring blank logger path.")
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
                "New logger '%s' starts at pinned level %s.",
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

        _LOGGER.info(
            "Added logger '%s' (%s).",
            friendly_name,
            logger_name,
        )

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

        if logger_name in hass.data[DOMAIN]["loggers"]:
            del hass.data[DOMAIN]["loggers"][logger_name]
            with counter_handler._lock:
                hass.data[DOMAIN]["counters"].pop(logger_name, None)
            # Stop managing the logger: reset its level so it falls back to its
            # inherited level. A core-pinned namespace is owned by Home
            # Assistant core, so removing the managed entry leaves it untouched.
            if not is_core_pinned(hass, logger_name):
                logging.getLogger(logger_name).setLevel(logging.NOTSET)
            await save_data()
            _LOGGER.info(
                "Removed logger '%s' (%s).",
                friendly_name,
                logger_name,
            )
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
            _LOGGER.warning("Alert threshold for '%s' is not managed.", logger_name)
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
