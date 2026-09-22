"""Recording websocket commands and scriptable services."""

import logging
import time

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, SupportsResponse
from homeassistant.helpers import config_validation as cv

from .const import CAPTURE_LEVELS, DOMAIN
from .recording_session import (
    _resolve_start_args,
    discard_recording_session,
    start_recording_session,
    stop_recording_session,
)

_LOGGER = logging.getLogger(__name__)


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
        {cv.string: vol.In(CAPTURE_LEVELS)}
    ),
    vol.Optional("excludes", default={}): vol.Schema(
        {cv.string: vol.All(cv.ensure_list, [cv.string])}
    ),
    vol.Optional("raise_levels", default={}): vol.Schema(
        {
            cv.string: vol.Schema(
                {
                    vol.Required("entity_id"): cv.string,
                    vol.Required("from"): cv.string,
                    vol.Required("to"): cv.string,
                }
            )
        }
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
        raise_levels=msg.get("raise_levels"),
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
            # Expose pending level reverts so a reloaded card can display them.
            result["level_restore"] = recording.get("level_restore", {})
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
        {cv.string: vol.In(CAPTURE_LEVELS)}
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
