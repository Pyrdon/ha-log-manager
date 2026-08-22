"""Tests for the v3 storage schema migration."""

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import voluptuous as vol
from pytest_homeassistant_custom_component.common import MockConfigEntry

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
from custom_components.log_manager.core_sync import (
    is_core_pinned,
    reconcile_with_core,
)
from custom_components.log_manager.select import LogLevelSelect


STORE_DATA = {
    "loggers": {
        "rec.logger": {"friendly_name": "Rec Logger", "level": "NOTSET"},
        "other.logger": {"friendly_name": "Other Logger", "level": "NOTSET"},
    }
}


def _make_record(name, level, msg="test", pathname="test.py", lineno=1):
    return logging.LogRecord(name, level, pathname, lineno, msg, (), None)


async def _setup(hass):
    with patch(
        "custom_components.log_manager.LogManagerStore.async_load",
        return_value={"loggers": STORE_DATA["loggers"]},
    ):
        entry = MockConfigEntry(domain=DOMAIN, data={})
        entry.add_to_hass(hass)
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()


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


class TestAlerts:
    def test_alert_fires_once_on_threshold_crossing(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {
                "alerty": {
                    "friendly_name": "Alerty",
                    "level": "NOTSET",
                    "alert_threshold": 3,
                }
            },
            "counters": {},
        }
        handler = LogCounterHandler(hass)

        with patch("custom_components.log_manager._schedule_alert") as mock_schedule:
            for _ in range(4):
                handler.emit(_make_record("alerty", logging.ERROR, msg="err"))

        assert mock_schedule.call_count == 1
        counter = hass.data[DOMAIN]["counters"]["alerty"]
        assert counter["error"] == 4
        assert counter["alert_fired"] is True

    def test_alert_fires_again_after_reset(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {
                "alerty": {
                    "friendly_name": "Alerty",
                    "level": "NOTSET",
                    "alert_threshold": 2,
                }
            },
            "counters": {},
        }
        handler = LogCounterHandler(hass)

        with patch("custom_components.log_manager._schedule_alert") as mock_schedule:
            handler.emit(_make_record("alerty", logging.ERROR, msg="e1"))
            handler.emit(_make_record("alerty", logging.ERROR, msg="e2"))
        assert mock_schedule.call_count == 1

        handler.reset("alerty")
        assert hass.data[DOMAIN]["counters"]["alerty"]["alert_fired"] is False

        with patch("custom_components.log_manager._schedule_alert") as mock_schedule2:
            handler.emit(_make_record("alerty", logging.ERROR, msg="e3"))
            handler.emit(_make_record("alerty", logging.ERROR, msg="e4"))
        assert mock_schedule2.call_count == 1

    def test_alert_counts_at_configured_severity(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {
                "warnful": {
                    "friendly_name": "Warnful",
                    "level": "NOTSET",
                    "alert_threshold": 2,
                    "alert_level": "WARNING",
                }
            },
            "counters": {},
        }
        handler = LogCounterHandler(hass)

        with patch("custom_components.log_manager._schedule_alert") as mock_schedule:
            handler.emit(_make_record("warnful", logging.WARNING, msg="w1"))
            assert mock_schedule.call_count == 0
            handler.emit(_make_record("warnful", logging.WARNING, msg="w2"))
        assert mock_schedule.call_count == 1
        assert hass.data[DOMAIN]["counters"]["warnful"]["alert_fired"] is True

    async def test_set_alert_threshold_service_accepts_level(self, hass):
        await _setup(hass)

        await hass.services.async_call(
            DOMAIN,
            "set_alert_threshold",
            {"logger_name": "rec.logger", "events": 4, "level": "WARNING"},
            blocking=True,
        )

        info = hass.data[DOMAIN]["loggers"]["rec.logger"]
        assert info["alert_threshold"] == 4
        assert info["alert_level"] == "WARNING"

    async def test_set_alert_threshold_without_level_preserves_level(self, hass):
        await _setup(hass)

        await hass.services.async_call(
            DOMAIN,
            "set_alert_threshold",
            {"logger_name": "rec.logger", "events": 4, "level": "WARNING"},
            blocking=True,
        )
        await hass.services.async_call(
            DOMAIN,
            "set_alert_threshold",
            {"logger_name": "rec.logger", "events": 7},
            blocking=True,
        )

        info = hass.data[DOMAIN]["loggers"]["rec.logger"]
        assert info["alert_threshold"] == 7
        assert info["alert_level"] == "WARNING"

    async def test_disabled_alert_never_fires(self, hass):
        await _setup(hass)
        await hass.services.async_call(
            DOMAIN,
            "set_alert_threshold",
            {"logger_name": "rec.logger", "events": 0},
            blocking=True,
        )

        handler = hass.data[DOMAIN]["counter_handler"]
        with patch("custom_components.log_manager._schedule_alert") as mock_schedule:
            for _ in range(3):
                handler.emit(_make_record("rec.logger", logging.ERROR, msg="err"))
        assert mock_schedule.call_count == 0

    async def test_set_alert_threshold_rejects_invalid_level(self, hass):
        await _setup(hass)

        with pytest.raises(vol.Invalid):
            await hass.services.async_call(
                DOMAIN,
                "set_alert_threshold",
                {"logger_name": "rec.logger", "events": 1, "level": "INFO"},
                blocking=True,
            )


class TestSelectBehaviour:
    async def test_select_records_audit(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {"a": {"friendly_name": "A", "level": "NOTSET"}},
            "save_data": AsyncMock(),
        }
        entity = LogLevelSelect(hass, "a", "A")

        with patch.object(entity, "async_write_ha_state"):
            await entity.async_select_option("INFO")

        audit = hass.data[DOMAIN]["loggers"]["a"]["audit"]
        assert audit[0]["source"] == "ui"
        assert audit[0]["old_level"] == "NOTSET"
        assert audit[0]["new_level"] == "INFO"

    def test_record_audit_caps_entries_most_recent_first(self):
        from custom_components.log_manager.const import MAX_AUDIT, record_audit

        info = {}
        for i in range(MAX_AUDIT + 2):
            record_audit(info, f"L{i}", f"L{i + 1}", "ui")

        audit = info["audit"]
        assert len(audit) == MAX_AUDIT
        assert audit[0]["new_level"] == f"L{MAX_AUDIT + 2}"
        assert audit[-1]["new_level"] == "L3"
        assert all("ts" in entry for entry in audit)


class TestCoreSync:
    def test_is_core_pinned(self, hass):
        hass.data["logger"] = SimpleNamespace(overrides={"pinned.x": 10})
        assert is_core_pinned(hass, "pinned.x")
        assert not is_core_pinned(hass, "other.x")

        hass.data["logger"] = None
        assert not is_core_pinned(hass, "pinned.x")

    async def test_reconcile_adopts_core_pins(self, hass):
        save_data = AsyncMock()
        hass.data[DOMAIN] = {
            "loggers": {"pinned": {"friendly_name": "P", "level": "NOTSET"}},
            "save_data": save_data,
        }
        hass.data["logger"] = SimpleNamespace(overrides={"pinned": 10})

        with patch(
            "custom_components.log_manager.core_sync.async_dispatcher_send"
        ) as mock_dispatch:
            reconcile_with_core(hass)

        assert hass.data[DOMAIN]["loggers"]["pinned"]["level"] == "DEBUG"
        mock_dispatch.assert_called_once()

    async def test_reconcile_records_core_audit(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {"pinned": {"friendly_name": "P", "level": "NOTSET"}},
            "save_data": AsyncMock(),
        }
        hass.data["logger"] = SimpleNamespace(overrides={"pinned": 10})

        with patch(
            "custom_components.log_manager.core_sync.async_dispatcher_send"
        ):
            reconcile_with_core(hass)

        audit = hass.data[DOMAIN]["loggers"]["pinned"]["audit"]
        assert audit[0]["source"] == "core"
        assert audit[0]["old_level"] == "NOTSET"
        assert audit[0]["new_level"] == "DEBUG"

    async def test_reconcile_no_change_skips_save_and_dispatch(self, hass):
        save_data = AsyncMock()
        hass.data[DOMAIN] = {
            "loggers": {"pinned": {"friendly_name": "P", "level": "DEBUG"}},
            "save_data": save_data,
        }
        hass.data["logger"] = SimpleNamespace(overrides={"pinned": 10})

        with patch(
            "custom_components.log_manager.core_sync.async_dispatcher_send"
        ) as mock_dispatch:
            reconcile_with_core(hass)

        mock_dispatch.assert_not_called()
        save_data.assert_not_awaited()

    async def test_logging_changed_event_triggers_reconcile(self, hass):
        await _setup(hass)
        hass.data[DOMAIN]["loggers"]["rec.logger"] = {
            "friendly_name": "Rec Logger",
            "level": "NOTSET",
        }
        hass.data["logger"] = SimpleNamespace(overrides={"rec.logger": 20})

        hass.bus.async_fire("logging_changed")
        await hass.async_block_till_done()

        assert hass.data[DOMAIN]["loggers"]["rec.logger"]["level"] == "INFO"

    async def test_core_sync_unsub_stops_reconcile(self, hass):
        from custom_components.log_manager.core_sync import register_core_sync

        hass.data[DOMAIN] = {
            "loggers": {"pinned": {"friendly_name": "P", "level": "NOTSET"}},
            "save_data": AsyncMock(),
        }
        hass.data["logger"] = SimpleNamespace(overrides={"pinned": 10})

        unsub = register_core_sync(hass)
        unsub()

        hass.bus.async_fire("logging_changed")
        await hass.async_block_till_done()

        assert hass.data[DOMAIN]["loggers"]["pinned"]["level"] == "NOTSET"

    async def test_select_refused_when_pinned(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {"pinned.log": {"friendly_name": "P", "level": "NOTSET"}}
        }
        hass.data["logger"] = SimpleNamespace(overrides={"pinned.log": 40})

        entity = LogLevelSelect(hass, "pinned.log", "P")
        await entity.async_select_option("INFO")

        assert entity.current_option == "NOTSET"
        assert hass.data[DOMAIN]["loggers"]["pinned.log"]["level"] == "NOTSET"
        assert "audit" not in hass.data[DOMAIN]["loggers"]["pinned.log"]
