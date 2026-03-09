"""Platform for managing dynamic log level select entities."""

import logging
from homeassistant.components.select import SelectEntity
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from . import DOMAIN

_LOGGER = logging.getLogger(__name__)
LOG_LEVELS = ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]

async def async_setup_entry(hass, entry, async_add_entities):
    """
    Set up the select platform and restore previously saved loggers from a config entry.
    """

    async def async_add_logger(logger_name: str, friendly_name: str):
        """
        Callback to add a new select entity for a specific logger path.
        """

        async_add_entities([LogLevelSelect(logger_name, friendly_name)])

    async_dispatcher_connect(hass, f"{DOMAIN}_add_logger", async_add_logger)

    # Restore loggers that were saved to storage during previous sessions.
    stored_loggers = hass.data.get(DOMAIN, {}).get("loggers", {})

    if stored_loggers:
        # Unpack the dictionary to restore the entities.
        entities = [
            LogLevelSelect(name, fname)
            for name, fname in stored_loggers.items()
        ]
        async_add_entities(entities)

class LogLevelSelect(SelectEntity, RestoreEntity):
    """
    Select entity to control the level of a specific Python logger.
    """

    def __init__(self, logger_name: str, friendly_name: str):
        """
        Initialize the select entity.
        """

        self._logger_name = logger_name
        self._attr_name = friendly_name
        self._attr_icon = "mdi:math-log"
        self._attr_unique_id = f"log_manager_{logger_name.replace('.', '_')}"
        self._attr_options = LOG_LEVELS

        # Force the entity ID to match what the JavaScript card expects.
        self.entity_id = f"select.log_manager_{logger_name.replace('.', '_')}"

        # Default to the current effective level of the Python logger.
        current_level = logging.getLogger(logger_name).getEffectiveLevel()
        self._attr_current_option = logging.getLevelName(current_level)

        _LOGGER.debug(
            "Adding new logger configuration for '%s' (%s).",
            friendly_name,
            logger_name
        )

    async def async_added_to_hass(self):
        """
        Restore the previous state and apply the log level on startup.
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

        # Attempt to restore the previous state from Home Assistant storage.
        last_state = await self.async_get_last_state()

        if last_state and last_state.state in LOG_LEVELS:
            self._attr_current_option = last_state.state
            logging.getLogger(self._logger_name).setLevel(last_state.state)

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
            await self.async_remove(force_remove=True)

    @property
    def current_option(self) -> str:
        """
        Return the current log level option.
        """

        return self._attr_current_option

    @property
    def extra_state_attributes(self):
        """
        Expose the actual backend logger path so the frontend knows what to delete.
        """

        return {"logger_name": self._logger_name}

    async def async_select_option(self, option: str) -> None:
        """
        Handle the user clicking a new option in the HA frontend.
        """

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
