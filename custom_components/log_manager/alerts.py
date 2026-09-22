"""Alert scheduling and persistent notifications for managed loggers."""

import hashlib
import re

from homeassistant.components import persistent_notification
from homeassistant.core import HomeAssistant

from .const import DOMAIN


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
