"""Storage handling for Log Manager configuration and migrations."""

import logging

from homeassistant.helpers.storage import Store

from .const import ALERT_DISABLED, DEFAULT_ALERT_LEVEL, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)


class LogManagerStore(Store):
    """
    Custom storage handling to manage migrations between configuration versions.
    """

    async def _async_migrate_func(
        self, old_major_version: int, old_minor_version: int, old_data: dict
    ) -> dict:
        """
        Migrate old configuration to the new dictionary-based format.
        """

        _LOGGER.info("Migrating storage to version %s.", STORAGE_VERSION)

        if old_major_version == 1:
            new_loggers = {}

            for name, friendly_name in old_data.get("loggers", {}).items():
                # We cannot read RestoreEntity DB here, so we grab current effective level.
                current_level = logging.getLogger(name).getEffectiveLevel()
                level_name = logging.getLevelName(current_level)
                new_loggers[name] = {
                    "friendly_name": friendly_name,
                    "level": level_name
                }
                _LOGGER.debug("Migrated logger '%s'.", friendly_name)

            old_data["loggers"] = new_loggers
            _LOGGER.info("Migrated %s loggers.", len(new_loggers))

        if old_major_version < 3:
            # Schema v3: alert threshold and level-change audit trail.
            for info in old_data.get("loggers", {}).values():
                if not isinstance(info, dict):
                    continue
                info.setdefault("alert_threshold", ALERT_DISABLED)
                info.setdefault("alert_level", DEFAULT_ALERT_LEVEL)
                info.setdefault("audit", [])
            _LOGGER.info("Migrated %s loggers to schema v3.", len(old_data.get("loggers", {})))

        # Whatever legacy shape is being upgraded, blank/whitespace logger keys
        # are meaningless and the removed sensor-opt-in and count-level fields
        # must not survive. Run last so no earlier block can reintroduce them.
        loggers = old_data.get("loggers", {})
        cleaned = {}
        for name, info in loggers.items():
            if not isinstance(name, str) or not name.strip():
                _LOGGER.warning("Dropping blank logger key during migration.")
                continue
            if isinstance(info, dict):
                info.pop("sensor_enabled", None)
                info.pop("count_level", None)
            cleaned[name] = info
        old_data["loggers"] = cleaned

        return old_data
