"""Tests for Log Manager storage migrations and load-time cleansing."""

from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.log_manager import DOMAIN, STORAGE_KEY, STORAGE_VERSION
from custom_components.log_manager.const import ALERT_DISABLED
from custom_components.log_manager.storage import LogManagerStore


class TestLogManagerStoreMigration:
    async def test_migrate_v1_to_v2(self):
        hass = MagicMock(spec=HomeAssistant)
        store = LogManagerStore(hass, STORAGE_VERSION, STORAGE_KEY)

        old_data = {
            "loggers": {
                "first.logger": "First Logger",
                "second.module": "Second Module",
            }
        }

        with patch("custom_components.log_manager.storage.logging.getLogger") as mock_get_logger:
            mock_logger = MagicMock()
            mock_logger.getEffectiveLevel.return_value = 30
            mock_get_logger.return_value = mock_logger

            result = await store._async_migrate_func(1, 0, old_data)

        loggers = result["loggers"]
        assert loggers["first.logger"]["friendly_name"] == "First Logger"
        assert loggers["first.logger"]["level"] == "WARNING"
        assert loggers["second.module"]["friendly_name"] == "Second Module"
        assert loggers["second.module"]["level"] == "WARNING"

    async def test_migrate_v1_empty_loggers(self):
        hass = MagicMock(spec=HomeAssistant)
        store = LogManagerStore(hass, STORAGE_VERSION, STORAGE_KEY)

        old_data = {"loggers": {}}

        with patch("custom_components.log_manager.storage.logging.getLogger") as mock_get_logger:
            result = await store._async_migrate_func(1, 0, old_data)

        assert result["loggers"] == {}

    async def test_migrate_v1_preserves_unknown_keys(self):
        hass = MagicMock(spec=HomeAssistant)
        store = LogManagerStore(hass, STORAGE_VERSION, STORAGE_KEY)

        old_data = {
            "loggers": {"app": "App"},
            "version": 1,
            "some_extra_key": "should remain",
        }

        with patch("custom_components.log_manager.storage.logging.getLogger") as mock_get_logger:
            mock_logger = MagicMock()
            mock_logger.getEffectiveLevel.return_value = 20
            mock_get_logger.return_value = mock_logger

            result = await store._async_migrate_func(1, 0, old_data)

        assert result["some_extra_key"] == "should remain"
        assert result["version"] == 1


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
            assert "count_level" not in info
            assert info["alert_threshold"] == ALERT_DISABLED
            assert "sensor_enabled" not in info
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
        assert info["alert_threshold"] == 5
        assert "sensor_enabled" not in info
        assert info["audit"] == [
            {"ts": 1.0, "source": "ui", "old_level": "X", "new_level": "Y"}
        ]
        assert result["loggers"]["broken"] == "not-a-dict"

    async def test_v1_migration_drops_blank_keys_and_legacy_flags(self):
        hass = MagicMock()
        store = LogManagerStore(hass, STORAGE_VERSION, f"{DOMAIN}.config")
        # Legacy flat map: a valid name and a blank one, plus a stray flag that
        # the v1 conversion would otherwise reintroduce on the climb.
        old_data = {
            "loggers": {
                "legacy": "Legacy Name",
                "   ": "Blank Name",
            }
        }

        with patch("custom_components.log_manager.storage.logging.getLogger") as mock_get_logger:
            mock_logger = MagicMock()
            mock_logger.getEffectiveLevel.return_value = 30
            mock_get_logger.return_value = mock_logger
            result = await store._async_migrate_func(1, 0, old_data)

        assert set(result["loggers"].keys()) == {"legacy"}
        info = result["loggers"]["legacy"]
        assert info["friendly_name"] == "Legacy Name"
        assert info["alert_threshold"] == ALERT_DISABLED
        assert "sensor_enabled" not in info

    async def test_v2_migration_drops_legacy_flags_and_blank_keys(self):
        hass = MagicMock()
        store = LogManagerStore(hass, STORAGE_VERSION, f"{DOMAIN}.config")
        old_data = {
            "loggers": {
                "keep.log": {
                    "friendly_name": "Keep",
                    "level": "INFO",
                    "alert_threshold": 3,
                    "alert_level": "WARNING",
                    "sensor_enabled": True,
                    "audit": [],
                },
                "": {"friendly_name": "Blank", "sensor_enabled": True},
            }
        }
        result = await store._async_migrate_func(2, 0, old_data)

        assert set(result["loggers"].keys()) == {"keep.log"}
        info = result["loggers"]["keep.log"]
        assert info["alert_threshold"] == 3
        assert "sensor_enabled" not in info

    async def test_v1_to_v3_converts_and_adds_defaults(self):
        hass = MagicMock()
        store = LogManagerStore(hass, STORAGE_VERSION, f"{DOMAIN}.config")
        old_data = {"loggers": {"legacy": "Legacy Name"}}

        with patch("custom_components.log_manager.storage.logging.getLogger") as mock_get_logger:
            mock_logger = MagicMock()
            mock_logger.getEffectiveLevel.return_value = 30
            mock_get_logger.return_value = mock_logger
            result = await store._async_migrate_func(1, 0, old_data)

        info = result["loggers"]["legacy"]
        assert info["friendly_name"] == "Legacy Name"
        assert info["level"] == "WARNING"


class TestLoadCleanse:
    async def test_load_time_cleanse_drops_blank_and_flag(self, hass):
        with patch(
            "custom_components.log_manager.storage.LogManagerStore.async_load",
            return_value={
                "loggers": {
                    "rec.logger": {
                        "friendly_name": "Rec Logger",
                        "level": "NOTSET",
                        "sensor_enabled": True,
                    },
                    "  ": {"friendly_name": "Blank"},
                }
            },
        ):
            entry = MockConfigEntry(domain=DOMAIN, data={})
            entry.add_to_hass(hass)
            assert await hass.config_entries.async_setup(entry.entry_id)
            await hass.async_block_till_done()

        loggers = hass.data[DOMAIN]["loggers"]
        assert set(loggers.keys()) == {"rec.logger"}
        assert "sensor_enabled" not in loggers["rec.logger"]
