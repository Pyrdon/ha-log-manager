import logging
from typing import Any

from homeassistant import config_entries
from homeassistant.core import HomeAssistant

from . import DOMAIN

_LOGGER = logging.getLogger(__name__)

class LogManagerConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """
    Handle a config flow for Log Manager.
    """

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        """
        Handle the initial setup step initiated by the user.
        """

        _LOGGER.warning("Config flow: async_step_user triggered.")

        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            # Title is the heading of the card on the Integrations page.
            return self.async_create_entry(title="Log Manager", data={})

        # Explicitly pass an empty schema to avoid the "Submit" button
        # appearing without a place to put text.
        return self.async_show_form(step_id="user", data_schema=None)
