"""Named recording profiles.

A profile is a reusable capture scenario: a logger selection plus per-logger
level overrides and a duration limit. Profiles are stored in the integration
storage so automations can trigger them via ``log_manager.start_recording``.
"""

import logging

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, LOG_LEVELS_LIST

_LOGGER = logging.getLogger(__name__)


def get_profile(hass: HomeAssistant, name: str) -> dict | None:
    """Return a stored profile dict or None."""
    return hass.data.get(DOMAIN, {}).get("profiles", {}).get(name)


def get_all_profiles(hass: HomeAssistant) -> list[dict]:
    """Return the stored profiles as a list of dicts."""
    return [
        {
            "name": name,
            "loggers": profile.get("loggers", []),
            "level_overrides": profile.get("level_overrides", {}),
            "max_duration": profile.get("max_duration", 300),
        }
        for name, profile in hass.data.get(DOMAIN, {}).get("profiles", {}).items()
    ]


async def async_save_profile(
    hass: HomeAssistant,
    name: str,
    loggers: list[str],
    level_overrides: dict[str, str],
    max_duration: int = 300,
) -> None:
    """Persist a recording profile (upsert by name)."""
    hass.data[DOMAIN]["profiles"][name] = {
        "loggers": list(loggers),
        "level_overrides": dict(level_overrides),
        "max_duration": max_duration,
    }
    save = hass.data[DOMAIN].get("save_data")
    if save:
        await save()


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/profile_save",
    vol.Required("name"): cv.string,
    vol.Required("loggers"): vol.All(cv.ensure_list, [cv.string]),
    vol.Optional("level_overrides", default={}): vol.Schema(
        {cv.string: vol.In(LOG_LEVELS_LIST)}
    ),
    vol.Optional("max_duration", default=300): vol.All(
        vol.Coerce(int), vol.Range(min=10, max=3600)
    ),
})
@websocket_api.async_response
async def ws_profile_save(hass: HomeAssistant, connection, msg: dict):
    """Save (or overwrite) a recording profile."""
    name = msg["name"].strip()
    if not name:
        connection.send_error(msg["id"], "invalid_name", "Profile name is required.")
        return

    loggers = msg["loggers"]
    managed = hass.data[DOMAIN].get("loggers", {})
    unknown = set(loggers) - set(managed.keys())
    if unknown:
        connection.send_error(
            msg["id"],
            "unknown_logger",
            f"Unknown loggers: {', '.join(sorted(unknown))}",
        )
        return

    for logger_name in msg["level_overrides"]:
        if logger_name not in loggers:
            connection.send_error(
                msg["id"],
                "invalid_override",
                f"Override for '{logger_name}' is not in the profile loggers.",
            )
            return

    await async_save_profile(
        hass, name, loggers, msg["level_overrides"], msg["max_duration"]
    )
    _LOGGER.info("Saved recording profile '%s' (%s loggers).", name, len(loggers))
    connection.send_result(msg["id"], {"profiles": get_all_profiles(hass)})


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/profile_delete",
    vol.Required("name"): cv.string,
})
@websocket_api.async_response
async def ws_profile_delete(hass: HomeAssistant, connection, msg: dict):
    """Delete a stored recording profile."""
    name = msg["name"]
    if name in hass.data[DOMAIN].get("profiles", {}):
        del hass.data[DOMAIN]["profiles"][name]
        save = hass.data[DOMAIN].get("save_data")
        if save:
            await save()
        _LOGGER.info("Deleted recording profile '%s'.", name)
    connection.send_result(msg["id"], {"profiles": get_all_profiles(hass)})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/profiles_get"})
@websocket_api.async_response
async def ws_profiles_get(hass: HomeAssistant, connection, msg: dict):
    """Return all stored recording profiles."""
    connection.send_result(msg["id"], {"profiles": get_all_profiles(hass)})


def async_register_profile_commands(hass: HomeAssistant) -> None:
    """Register the recording profile websocket commands."""
    websocket_api.async_register_command(hass, ws_profile_save)
    websocket_api.async_register_command(hass, ws_profile_delete)
    websocket_api.async_register_command(hass, ws_profiles_get)