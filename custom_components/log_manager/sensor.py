"""Sensor platform exposing per-logger warning/error counters.

A warning sensor and an error sensor exist automatically for every managed
logger. They track the counter handler's live counts and update on every
counters signal so automations and history can react to a logger's traffic.
"""

import hashlib
import logging
import re

from homeassistant.components.sensor import SensorEntity
from homeassistant.core import callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


def _safe_id(logger_name: str) -> str:
    """Return a unique, lowercase registry-safe id fragment for a logger name."""
    safe = re.sub(r"[^a-z0-9_]", "_", logger_name.lower())
    digest = hashlib.sha1(logger_name.encode("utf-8")).hexdigest()[:8]
    return f"{safe}_{digest}"


class LogCounterSensor(SensorEntity):
    """A sensor exposing one managed logger's warning or error count."""

    _attr_should_poll = False

    def __init__(self, hass, logger_name: str, kind: str, friendly_name: str):
        self.hass = hass
        self._logger_name = logger_name
        self._kind = kind
        self._attr_name = f"{friendly_name} {kind.capitalize()} Count"
        self._attr_icon = (
            "mdi:alert-circle-outline" if kind == "error" else "mdi:alert-outline"
        )
        self._attr_unique_id = f"log_manager_{_safe_id(logger_name)}_{kind}_count"
        self._attr_native_value = 0

    async def async_added_to_hass(self):
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, f"{DOMAIN}_counters_updated", self._refresh
            )
        )
        self._refresh()

    @callback
    def _refresh(self):
        handler = self.hass.data.get(DOMAIN, {}).get("counter_handler")
        warning, error = handler.values_for(self._logger_name) if handler else (0, 0)
        value = error if self._kind == "error" else warning
        if value != self._attr_native_value:
            self._attr_native_value = value
            self.async_write_ha_state()


async def async_setup_entry(hass, entry, async_add_entities):
    """Set up counter sensors for every managed logger."""

    entities: dict[tuple[str, str], LogCounterSensor] = {}

    async def _rebuild():
        loggers = hass.data.get(DOMAIN, {}).get("loggers", {})
        desired = {
            (name, kind)
            for name in loggers
            for kind in ("warning", "error")
        }

        to_add = []
        for key in desired - set(entities):
            name, kind = key
            info = loggers[name]
            sensor = LogCounterSensor(
                hass, name, kind, info.get("friendly_name") or name
            )
            entities[key] = sensor
            to_add.append(sensor)

        to_remove = [entities.pop(key) for key in set(entities) - desired]

        if to_add:
            async_add_entities(to_add)
        for sensor in to_remove:
            await sensor.async_remove(force_remove=True)

    async def _on_sensors_changed():
        await _rebuild()

    entry.async_on_unload(
        async_dispatcher_connect(
            hass, f"{DOMAIN}_sensors_changed", _on_sensors_changed
        )
    )
    await _rebuild()
