"""Tests for the v3 storage schema migration."""

import logging
from unittest.mock import MagicMock, patch

from custom_components.log_manager import (
    DOMAIN,
    LogCounterHandler,
    LogManagerStore,
    STORAGE_VERSION,
)
from custom_components.log_manager.const import (
    ALERT_DISABLED,
    DEFAULT_COUNT_LEVEL,
)


def _make_record(name, level, msg="test", pathname="test.py", lineno=1):
    return logging.LogRecord(name, level, pathname, lineno, msg, (), None)


class TestMigrationV3:
    async def test_v2_to_v3_adds_defaults(self):
        hass = MagicMock()
        store = LogManagerStore(hass, STORAGE_VERSION, f"{DOMAIN}.config")
        old_data = {
            "loggers": {
                "a.logger": {"friendly_name": "A", "level": "WARNING"},
                "b.logger": {"friendly_name": "B", "level": "NOTSET"},
            }
        }
        result = await store._async_migrate_func(2, 0, old_data)

        for info in result["loggers"].values():
            assert info["count_level"] == DEFAULT_COUNT_LEVEL
            assert info["alert_threshold"] == ALERT_DISABLED
            assert info["sensor_enabled"] is False
            assert info["audit"] == []
        assert result["loggers"]["a.logger"]["level"] == "WARNING"

    async def test_v3_preserves_existing_values_and_skips_non_dict(self):
        hass = MagicMock()
        store = LogManagerStore(hass, STORAGE_VERSION, f"{DOMAIN}.config")
        old_data = {
            "loggers": {
                "custom": {
                    "friendly_name": "C",
                    "level": "INFO",
                    "count_level": "DEBUG",
                    "alert_threshold": 5,
                    "sensor_enabled": True,
                    "audit": [
                        {
                            "ts": 1.0,
                            "source": "ui",
                            "old_level": "X",
                            "new_level": "Y",
                        }
                    ],
                },
                "broken": "not-a-dict",
            }
        }
        result = await store._async_migrate_func(2, 0, old_data)

        info = result["loggers"]["custom"]
        assert info["count_level"] == "DEBUG"
        assert info["alert_threshold"] == 5
        assert info["sensor_enabled"] is True
        assert info["audit"] == [
            {"ts": 1.0, "source": "ui", "old_level": "X", "new_level": "Y"}
        ]
        assert result["loggers"]["broken"] == "not-a-dict"

    async def test_v1_to_v3_converts_and_adds_defaults(self):
        hass = MagicMock()
        store = LogManagerStore(hass, STORAGE_VERSION, f"{DOMAIN}.config")
        old_data = {"loggers": {"legacy": "Legacy Name"}}

        with patch("custom_components.log_manager.logging.getLogger") as mock_get_logger:
            mock_logger = MagicMock()
            mock_logger.getEffectiveLevel.return_value = 30
            mock_get_logger.return_value = mock_logger
            result = await store._async_migrate_func(1, 0, old_data)

        info = result["loggers"]["legacy"]
        assert info["friendly_name"] == "Legacy Name"
        assert info["level"] == "WARNING"
        assert info["count_level"] == DEFAULT_COUNT_LEVEL


class TestCounterThreshold:
    def _handler_and_hass(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {
                "chatty": {
                    "friendly_name": "Chatty",
                    "level": "NOTSET",
                    "count_level": "INFO",
                },
                "quiet": {
                    "friendly_name": "Quiet",
                    "level": "NOTSET",
                    "count_level": "WARNING",
                },
            },
            "counters": {},
        }
        return LogCounterHandler(hass)

    def test_update_level_uses_lowest_threshold(self, hass):
        handler = self._handler_and_hass(hass)
        handler.update_level()
        assert handler.level == logging.INFO

    def test_emit_respects_per_logger_threshold(self, hass):
        handler = self._handler_and_hass(hass)
        handler.emit(_make_record("chatty", logging.INFO, msg="info chatty"))
        handler.emit(_make_record("chatty", logging.DEBUG, msg="debug chatty"))
        handler.emit(_make_record("quiet", logging.INFO, msg="info quiet"))
        handler.emit(_make_record("quiet", logging.WARNING, msg="warn quiet"))

        counters = hass.data[DOMAIN]["counters"]
        assert counters["chatty"]["levels"].get("INFO") == 1
        assert counters["chatty"]["warning"] == 0
        assert counters["chatty"]["error"] == 0
        assert "DEBUG" not in counters["chatty"]["levels"]
        assert counters["quiet"]["levels"].get("WARNING") == 1
        assert counters["quiet"]["warning"] == 1

    def test_levels_breakdown_separates_severities(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {"mix": {"friendly_name": "Mix", "level": "NOTSET"}},
            "counters": {},
        }
        handler = LogCounterHandler(hass)
        handler.emit(_make_record("mix", logging.WARNING))
        handler.emit(_make_record("mix", logging.ERROR))
        handler.emit(_make_record("mix", logging.CRITICAL))

        counter = hass.data[DOMAIN]["counters"]["mix"]
        assert counter["warning"] == 1
        assert counter["error"] == 2
        assert counter["levels"] == {"WARNING": 1, "ERROR": 1, "CRITICAL": 1}
