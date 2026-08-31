"""Platform for managing dynamic log level select entities."""

import logging
from homeassistant.components.select import SelectEntity
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import (
    ALERT_DISABLED,
    DEFAULT_ALERT_LEVEL,
    DEFAULT_COUNT_LEVEL,
    DOMAIN,
    LOG_LEVELS_LIST as LOG_LEVELS,
    effective_level_source,
    record_audit,
)
from .core_sync import is_core_pinned

_LOGGER = logging.getLogger(__name__)

async def async_setup_entry(hass, entry, async_add_entities):
    """
    Set up the select platform and restore previously saved loggers from a config entry.
    """

    async def async_add_logger(logger_name: str, friendly_name: str):
        """
        Callback to add a new select entity for a specific logger path.
        """

        async_add_entities([LogLevelSelect(hass, logger_name, friendly_name)])

    async_dispatcher_connect(hass, f"{DOMAIN}_add_logger", async_add_logger)

    # Restore loggers that were saved to storage during previous sessions.
    stored_loggers = hass.data.get(DOMAIN, {}).get("loggers", {})

    if stored_loggers:
        # Unpack the dictionary to restore the entities.
        entities = []
        for name, info in stored_loggers.items():
            fname = info.get("friendly_name")
            entities.append(LogLevelSelect(hass, name, fname))

        async_add_entities(entities)

class LogLevelSelect(SelectEntity):
    """
    Select entity to control the level of a specific Python logger.
    """

    def __init__(self, hass, logger_name: str, friendly_name: str):
        """
        Initialize the select entity.
        """

        self.hass = hass
        self._logger_name = logger_name
        self._attr_name = friendly_name
        self._attr_icon = "mdi:math-log"
        self._attr_options = LOG_LEVELS

        # Default to the stored level from the domain configuration.
        stored_info = hass.data[DOMAIN]["loggers"].get(logger_name, {})
        self._attr_current_option = stored_info.get("level", "NOTSET")

        # Unique IDs must be strictly lowercase in Home Assistant.
        safe_id = logger_name.replace('.', '_').lower()
        self._attr_unique_id = f"log_manager_{safe_id}"

        _LOGGER.debug(
            "Adding new logger configuration for '%s' (%s).",
            friendly_name,
            logger_name
        )

    def _stored_info(self) -> dict:
        """Return the current stored record for this logger."""
        return self.hass.data.get(DOMAIN, {}).get("loggers", {}).get(
            self._logger_name, {}
        )

    async def async_added_to_hass(self):
        """
        Listen for remove and level-refresh signals when added to Home Assistant.
        """

        await super().async_added_to_hass()

        # Listen for the signal to remove this specific entity.
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                f"{DOMAIN}_remove_logger",
                self._handle_remove_signal
            )
        )

        # Refresh the displayed level when core-sync adopts a pinned level.
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                f"{DOMAIN}_levels_changed",
                self._handle_levels_changed
            )
        )

    async def _handle_remove_signal(self, logger_name: str):
        """
        Remove the entity from Home Assistant if the name matches.
        """

        if logger_name == self._logger_name:
            _LOGGER.debug(
                "Removing logger configuration for '%s' (%s).",
                self._attr_name,
                logger_name
            )
            await self.async_remove(force_remove = True)

    async def _handle_levels_changed(self):
        """Adopt the stored level (possibly pinned by core) and refresh state."""
        stored_info = self._stored_info()
        level = stored_info.get("level", "NOTSET")
        if level != self._attr_current_option:
            self._attr_current_option = level
            self.async_write_ha_state()

    @property
    def current_option(self) -> str:
        """
        Return the current log level option.
        """

        return self._attr_current_option

    @property
    def extra_state_attributes(self):
        """
        Expose the backend logger path and derived state to the frontend.
        """

        stored_info = self._stored_info()
        effective_level, effective_source = effective_level_source(
            self._logger_name
        )
        return {
            "logger_name": self._logger_name,
            "core_pinned": is_core_pinned(self.hass, self._logger_name),
            "effective_level": effective_level,
            "effective_source": effective_source,
            "count_level": stored_info.get("count_level", DEFAULT_COUNT_LEVEL),
            "alert_threshold": stored_info.get(
                "alert_threshold", ALERT_DISABLED
            ),
            "alert_level": stored_info.get("alert_level", DEFAULT_ALERT_LEVEL),
            "sensor_enabled": stored_info.get("sensor_enabled", False),
            "audit": stored_info.get("audit", []),
        }

    async def async_select_option(self, option: str) -> None:
        """
        Handle the user clicking a new option in the HA frontend.
        """

        if is_core_pinned(self.hass, self._logger_name):
            _LOGGER.warning(
                "Level of '%s' is managed by Home Assistant core; ignoring request to set %s.",
                self._logger_name, option
            )
            return

        old_level = self._attr_current_option or "NOTSET"

        if option == old_level:
            # Re-selecting the current level changes nothing: skip the
            # setLevel call, the audit entry and the storage write.
            return

        # Update the UI state.
        self._attr_current_option = option
        self.async_write_ha_state()

        _LOGGER.info(
            "Setting log level for '%s' (%s) to %s.",
            self._attr_name,
            self._logger_name,
            option
        )
        logging.getLogger(self._logger_name).setLevel(option)

        # Update storage with the new log level and execute a save.
        stored_info = self._stored_info()
        record_audit(stored_info, old_level, option, "ui")
        stored_info["level"] = option
        self.hass.data[DOMAIN]["loggers"][self._logger_name] = stored_info

        if "save_data" in self.hass.data[DOMAIN]:
            await self.hass.data[DOMAIN]["save_data"]()
