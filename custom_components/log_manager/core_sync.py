"""Mirror Home Assistant core logger overrides into managed loggers.

Core's ``logger`` integration (YAML ``logger: logs:``, the per-integration
debug toggle and ``logger.set_level``) is authoritative for the namespaces it
pins: its ``HassLogger`` subclass swallows every other ``setLevel`` call for
those names. This module keeps Log Manager's stored state truthful by adopting
core's overrides and marking the affected rows as read-only.
"""

from collections.abc import Callable
import logging

from homeassistant.const import EVENT_LOGGING_CHANGED
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .const import DOMAIN, LOG_LEVELS_LIST, record_audit

_LOGGER = logging.getLogger(__name__)


def _core_overrides(hass: HomeAssistant) -> dict[str, str]:
    """Return pinned {logger_name: level_name} from core's logger integration.

    Defensive read: core stores a ``LoggerDomainConfig`` object under
    ``hass.data["logger"]`` whose ``overrides`` dict maps names to numeric
    levels. If the integration is absent or the shape ever changes, this
    returns empty and the feature degrades to today's behavior.
    """
    try:
        cfg = hass.data.get("logger")
        raw = getattr(cfg, "overrides", {}) if cfg is not None else {}
        if not isinstance(raw, dict):
            raw = {}
        result: dict[str, str] = {}
        for name, levelno in raw.items():
            level_name = logging.getLevelName(levelno)
            if not isinstance(level_name, str) or level_name not in LOG_LEVELS_LIST:
                _LOGGER.debug("Ignoring unknown core level for '%s'.", name)
                continue
            result[name] = level_name
        return result
    except Exception:
        _LOGGER.debug("Could not read core logger overrides.", exc_info=True)
        return {}


def is_core_pinned(hass: HomeAssistant, logger_name: str) -> bool:
    """Return True when core's logger integration pins this exact namespace."""
    return logger_name in _core_overrides(hass)


def reconcile_with_core(hass: HomeAssistant) -> None:
    """Adopt core-pinned levels into managed logger records and refresh entities."""
    overrides = _core_overrides(hass)
    loggers = hass.data.get(DOMAIN, {}).get("loggers", {})
    changed = False

    for name, info in loggers.items():
        if name in overrides and info.get("level") != overrides[name]:
            record_audit(info, info.get("level", "NOTSET"), overrides[name], "core")
            info["level"] = overrides[name]
            _LOGGER.info("Adopting core-pinned level '%s' for '%s'.", overrides[name], name)
            changed = True

    if not changed:
        return

    save = hass.data.get(DOMAIN, {}).get("save_data")
    if save:
        hass.async_create_task(save())

    # Nudge the select entities (and thereby the card) to the adopted level.
    async_dispatcher_send(hass, f"{DOMAIN}_levels_changed")


def register_core_sync(hass: HomeAssistant) -> Callable[[], None]:
    """Subscribe to core's ``logging_changed`` event; returns an unsubscribe callable."""

    async def _on_logging_changed(_event) -> None:
        reconcile_with_core(hass)

    return hass.bus.async_listen(EVENT_LOGGING_CHANGED, _on_logging_changed)