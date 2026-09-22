"""Lovelace resource and static-path registration for the Log Manager card."""

import logging
import mimetypes
import os

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


async def async_register_static_paths(hass: HomeAssistant) -> None:
    """Serve the card directory as the Log Manager UI static path."""

    # Force Python to recognize JavaScript files, running the disk I/O in a
    # background thread to avoid blocking the Home Assistant event loop.
    await hass.async_add_executor_job(mimetypes.init)
    mimetypes.add_type("application/javascript", ".js")

    # Register the static path so the HTTP component can serve the JavaScript file.
    local_path = hass.config.path(f"custom_components/{DOMAIN}/www/{DOMAIN}")
    if os.path.exists(local_path):
        await hass.http.async_register_static_paths([
            StaticPathConfig(f"/{DOMAIN}_ui", local_path, False)
        ])


async def async_register_lovelace_resource(hass: HomeAssistant) -> None:
    """
    Add the custom card to Lovelace resources if it is not already present.
    """

    card_dir = hass.config.path(f"custom_components/{DOMAIN}/www/{DOMAIN}")
    version = "1"

    # Version all served sibling files, not just the entry: a sibling-only edit
    # must still change the resource URL so the browser refetches the module
    # graph. mtime granularity across files is not guaranteed, so combine the
    # newest mtime with the number of served files to distinguish same-second edits.
    try:
        served = [
            entry.name
            for entry in os.scandir(card_dir)
            if entry.is_file() and entry.name.endswith(".js")
        ]
        if served:
            newest = max(os.path.getmtime(os.path.join(card_dir, name)) for name in served)
            version = f"{str(newest).replace('.', '')}{len(served)}"
    except OSError:
        _LOGGER.warning("Could not read modification time for Log Manager JS files.")

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
