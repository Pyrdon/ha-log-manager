"""WebSocket commands exposed by Log Manager."""

import logging

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .const import DOMAIN, LOG_LEVELS_LIST, record_audit
from .core_sync import is_core_pinned

_LOGGER = logging.getLogger(__name__)


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


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register Log Manager's websocket commands."""
    websocket_api.async_register_command(hass, ws_get_loggers)
    websocket_api.async_register_command(hass, ws_get_stats)
    websocket_api.async_register_command(hass, ws_set_levels)
