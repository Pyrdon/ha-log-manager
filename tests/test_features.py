"""Tests for the v3 schema, counters, alerts, core-sync, excludes, profiles,
recording services and counter sensors."""

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import voluptuous as vol
from homeassistant.helpers.dispatcher import async_dispatcher_send
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.log_manager import (
    DOMAIN,
    LogCounterHandler,
    LogManagerStore,
    STORAGE_VERSION,
    sensor as sensor_platform,
)
from custom_components.log_manager.const import (
    ALERT_DISABLED,
    effective_level_source,
)
from custom_components.log_manager.core_sync import (
    is_core_pinned,
    reconcile_with_core,
)
from custom_components.log_manager.recording import LogRecordingHandler
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

        with patch("custom_components.log_manager.logging.getLogger") as mock_get_logger:
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

        with patch("custom_components.log_manager.logging.getLogger") as mock_get_logger:
            mock_logger = MagicMock()
            mock_logger.getEffectiveLevel.return_value = 30
            mock_get_logger.return_value = mock_logger
            result = await store._async_migrate_func(1, 0, old_data)

        info = result["loggers"]["legacy"]
        assert info["friendly_name"] == "Legacy Name"
        assert info["level"] == "WARNING"

class TestServicesAndNotifications:
    async def test_set_sensor_enabled_service_is_not_registered(self, hass):
        await _setup(hass)
        services = hass.services.async_services().get(DOMAIN, {})
        assert "set_sensor_enabled" not in services

    async def test_add_logger_rejects_blank_path(self, hass):
        await _setup(hass)
        with patch.object(
            hass.data[DOMAIN]["store"], "async_save", new=AsyncMock()
        ) as mock_save:
            await hass.services.async_call(
                DOMAIN,
                "add_logger",
                {"logger_name": "   "},
                blocking=True,
            )
        assert "   " not in hass.data[DOMAIN]["loggers"]
        assert "" not in hass.data[DOMAIN]["loggers"]
        mock_save.assert_not_awaited()

    async def test_add_logger_dispatches_sensors_changed(self, hass):
        await _setup(hass)
        with patch(
            "custom_components.log_manager.async_dispatcher_send"
        ) as mock_dispatch:
            await hass.services.async_call(
                DOMAIN,
                "add_logger",
                {"logger_name": "fresh.logger", "friendly_name": "Fresh"},
                blocking=True,
            )
        signals = [c.args[1] for c in mock_dispatch.call_args_list]
        assert f"{DOMAIN}_add_logger" in signals
        assert f"{DOMAIN}_sensors_changed" in signals

    async def test_notification_title_uses_friendly_name_and_body_path_once(self, hass):
        from custom_components.log_manager import _create_alert_notification

        hass.data[DOMAIN] = {"loggers": {"my.logger": {"friendly_name": "My Friendly"}}}
        with patch(
            "custom_components.log_manager.persistent_notification.async_create"
        ) as mock_create:
            await _create_alert_notification(hass, "my.logger", 3, "ERROR", 2)

        args = mock_create.call_args[0]
        body = args[1]
        title = args[2]
        assert title == "Log Manager: My Friendly"
        assert body.count("my.logger") == 1

    async def test_notification_title_falls_back_to_path(self, hass):
        from custom_components.log_manager import _create_alert_notification

        hass.data[DOMAIN] = {"loggers": {"bare.logger": {"level": "NOTSET"}}}
        with patch(
            "custom_components.log_manager.persistent_notification.async_create"
        ) as mock_create:
            await _create_alert_notification(hass, "bare.logger", 1, "ERROR", 1)

        args = mock_create.call_args[0]
        title = args[2]
        body = args[1]
        assert title == "Log Manager: bare.logger"
        assert body.count("bare.logger") == 1

    async def test_alert_notification_id_shared_and_stable(self):
        from custom_components.log_manager import _alert_notification_id

        assert _alert_notification_id("my.logger") == _alert_notification_id("my.logger")
        assert _alert_notification_id("my.logger") != _alert_notification_id("other.logger")

    async def test_reset_counters_dismisses_notification(self, hass):
        await _setup(hass)
        with patch(
            "custom_components.log_manager.persistent_notification.async_dismiss"
        ) as mock_dismiss:
            await hass.services.async_call(
                DOMAIN,
                "reset_counters",
                {"logger_name": "rec.logger"},
                blocking=True,
            )
        ids = [c.args[1] for c in mock_dismiss.call_args_list]
        from custom_components.log_manager import _alert_notification_id

        assert _alert_notification_id("rec.logger") in ids

    async def test_unscoped_reset_dismisses_every_logger(self, hass):
        await _setup(hass)
        with patch(
            "custom_components.log_manager.persistent_notification.async_dismiss"
        ) as mock_dismiss:
            await hass.services.async_call(
                DOMAIN, "reset_counters", {}, blocking=True
            )
        ids = {c.args[1] for c in mock_dismiss.call_args_list}
        from custom_components.log_manager import _alert_notification_id

        assert _alert_notification_id("rec.logger") in ids
        assert _alert_notification_id("other.logger") in ids


class TestLoadCleanse:
    async def test_load_time_cleanse_drops_blank_and_flag(self, hass):
        with patch(
            "custom_components.log_manager.LogManagerStore.async_load",
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


class TestCounterThreshold:
    def _handler_and_hass(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {
                "chatty": {
                    "friendly_name": "Chatty",
                    "level": "NOTSET",
                },
                "quiet": {
                    "friendly_name": "Quiet",
                    "level": "NOTSET",
                },
            },
            "counters": {},
        }
        return LogCounterHandler(hass)

    def test_emit_counts_warning_and_above(self, hass):
        handler = self._handler_and_hass(hass)
        handler.emit(_make_record("chatty", logging.INFO, msg="info chatty"))
        handler.emit(_make_record("chatty", logging.DEBUG, msg="debug chatty"))
        handler.emit(_make_record("quiet", logging.WARNING, msg="warn quiet"))

        counters = hass.data[DOMAIN]["counters"]
        assert "chatty" not in counters
        assert counters["quiet"]["levels"] == {"WARNING": 1}
        assert counters["quiet"]["warning"] == 1

    def test_emit_ignores_sub_warning_even_for_debug_loggers(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {
                "chatty": {
                    "friendly_name": "Chatty",
                    "level": "DEBUG",
                },
            },
            "counters": {},
        }
        handler = LogCounterHandler(hass)
        handler.setLevel(logging.DEBUG)
        handler.emit(_make_record("chatty", logging.INFO, msg="info"))
        handler.emit(_make_record("chatty", logging.DEBUG, msg="debug"))

        assert hass.data[DOMAIN]["counters"].get("chatty") is None

    def test_snapshot_retains_levels_without_count_level(self, hass):
        handler = self._handler_and_hass(hass)
        handler.emit(_make_record("quiet", logging.WARNING, msg="warn"))

        snapshot = handler.snapshot()
        assert snapshot["quiet"]["levels"] == {"WARNING": 1}
        assert "count_level" not in snapshot["quiet"]

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

    def test_alert_fires_at_critical_severity(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {
                "crit": {
                    "friendly_name": "Crit",
                    "level": "NOTSET",
                    "alert_threshold": 2,
                    "alert_level": "CRITICAL",
                }
            },
            "counters": {},
        }
        handler = LogCounterHandler(hass)

        with patch("custom_components.log_manager._schedule_alert") as mock_schedule:
            handler.emit(_make_record("crit", logging.ERROR, msg="e1"))
            assert mock_schedule.call_count == 0
            handler.emit(_make_record("crit", logging.CRITICAL, msg="c1"))
            assert mock_schedule.call_count == 0
            handler.emit(_make_record("crit", logging.CRITICAL, msg="c2"))
        assert mock_schedule.call_count == 1
        assert hass.data[DOMAIN]["counters"]["crit"]["alert_fired"] is True

    async def test_set_count_level_service_is_not_registered(self, hass):
        await _setup(hass)

        services = hass.services.async_services().get(DOMAIN, {})
        assert "set_count_level" not in services
        assert "set_alert_threshold" in services

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


class TestEffectiveLevel:
    def test_own_level(self):
        logging.getLogger("eff.own").setLevel(logging.INFO)
        level, source = effective_level_source("eff.own")
        assert level == "INFO"
        assert source is None

    def test_inherited_from_ancestor(self):
        logging.getLogger("eff.parent").setLevel(logging.DEBUG)
        level, source = effective_level_source("eff.parent.child")
        assert level == "DEBUG"
        assert source == "eff.parent"

    def test_root_fallback(self):
        root = logging.getLogger()
        original_level = root.level
        root.setLevel(logging.WARNING)
        logging.getLogger("eff.unset.deep").setLevel(logging.NOTSET)
        try:
            level, source = effective_level_source("eff.unset.deep")
            assert level == "WARNING"
            assert source == "root"
        finally:
            root.setLevel(original_level)


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


class TestSelectBehaviour:
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


class TestRecordingExcludes:
    def test_all_override_applies_no_floor_and_captures_custom_levels(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {"cap": {"friendly_name": "Cap", "level": "WARNING"}}
        }
        handler = LogRecordingHandler(hass, frozenset(["cap"]), {"cap": "ALL"})

        handler.emit(_make_record("cap", logging.DEBUG))
        custom = _make_record("cap", logging.INFO)
        custom.levelno = 5
        custom.levelname = "TRACE"
        handler.emit(custom)

        assert handler.count() == 2
        entries = handler.snapshot()
        assert {e["level"] for e in entries} == {"DEBUG", "TRACE"}
        assert entries[1]["levelno"] == 5

    def test_entries_carry_levelno(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {"cap": {"friendly_name": "Cap", "level": "NOTSET"}}
        }
        handler = LogRecordingHandler(hass, frozenset(["cap"]), None)
        handler.emit(_make_record("cap", logging.WARNING))
        assert handler.snapshot()[0]["levelno"] == logging.WARNING

    def test_handler_excludes_subtree(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {"parent": {"friendly_name": "Parent", "level": "INFO"}}
        }
        handler = LogRecordingHandler(
            hass, frozenset(["parent"]), None, {"parent": ["parent.child"]}
        )

        handler.emit(_make_record("parent.child", logging.INFO))
        handler.emit(_make_record("parent.child.deep", logging.INFO))
        handler.emit(_make_record("parent.sibling", logging.INFO))

        assert handler.count() == 1
        assert handler.snapshot()[0]["logger"] == "parent.sibling"

    async def test_ws_rejects_invalid_excludes(self, hass, hass_ws_client):
        await _setup(hass)
        client = await hass_ws_client(hass)
        await client.send_json_auto_id({
            "type": "log_manager/start_recording",
            "loggers": ["rec.logger"],
            "excludes": {"rec.logger": ["not.a.child"]},
        })
        result = await client.receive_json()
        assert result["success"] is False
        assert result["error"]["code"] == "invalid_excludes"

    async def test_ws_rejects_excludes_for_unselected_logger(
        self, hass, hass_ws_client
    ):
        await _setup(hass)
        client = await hass_ws_client(hass)
        await client.send_json_auto_id({
            "type": "log_manager/start_recording",
            "loggers": ["rec.logger"],
            "excludes": {"other.logger": ["other.logger.child"]},
        })
        result = await client.receive_json()
        assert result["success"] is False
        assert result["error"]["code"] == "invalid_excludes"

    async def test_ws_rejects_excludes_covering_selected_logger(
        self, hass, hass_ws_client
    ):
        await _setup(hass)
        hass.data[DOMAIN]["loggers"]["cov.parent"] = {
            "friendly_name": "Cov Parent", "level": "NOTSET",
        }
        hass.data[DOMAIN]["loggers"]["cov.parent.child"] = {
            "friendly_name": "Cov Child", "level": "NOTSET",
        }
        client = await hass_ws_client(hass)
        await client.send_json_auto_id({
            "type": "log_manager/start_recording",
            "loggers": ["cov.parent", "cov.parent.child"],
            "excludes": {"cov.parent": ["cov.parent.child"]},
        })
        result = await client.receive_json()
        assert result["success"] is False
        assert result["error"]["code"] == "invalid_excludes"


class TestProfileExcludes:
    async def test_ws_profile_save_round_trips_excludes(self, hass, hass_ws_client):
        await _setup(hass)
        hass.data[DOMAIN]["loggers"]["rec.child"] = {
            "friendly_name": "Rec Child", "level": "NOTSET",
        }
        client = await hass_ws_client(hass)
        await client.send_json_auto_id({
            "type": "log_manager/profile_save",
            "name": "with-excl",
            "loggers": ["rec.logger", "rec.child"],
            "excludes": {"rec.logger": ["rec.logger.child"]},
        })
        result = await client.receive_json()
        assert result["success"] is True

        await client.send_json_auto_id({"type": "log_manager/profiles_get"})
        result = await client.receive_json()
        profile = result["result"]["profiles"][0]
        assert profile["excludes"] == {"rec.logger": ["rec.logger.child"]}

        await client.send_json_auto_id({
            "type": "log_manager/start_recording", "profile": "with-excl",
        })
        result = await client.receive_json()
        assert result["success"] is True
        handler = hass.data[DOMAIN]["recording"]["handler"]
        assert handler.excludes["rec.logger"] == frozenset(["rec.logger.child"])
        await client.send_json_auto_id({"type": "log_manager/discard_recording"})
        await client.receive_json()

    async def test_ws_profile_save_rejects_excludes_outside_loggers(
        self, hass, hass_ws_client
    ):
        await _setup(hass)
        client = await hass_ws_client(hass)
        await client.send_json_auto_id({
            "type": "log_manager/profile_save",
            "name": "bad",
            "loggers": ["rec.logger"],
            "excludes": {"other.logger": ["other.logger.child"]},
        })
        result = await client.receive_json()
        assert result["success"] is False
        assert result["error"]["code"] == "invalid_exclude"

    def test_invalid_stored_excludes_dropped(self, hass):
        from custom_components.log_manager.recording import _profile_excludes

        resolved = _profile_excludes(
            {"p": ["not.a.child", "p.", "p..bad", "p.good"]},
            ["p"],
        )
        assert resolved["p"] == ["p.good"]

    async def test_profile_run_uses_stored_excludes_only(self, hass):
        from custom_components.log_manager.recording import _resolve_start_args

        await _setup(hass)
        hass.data[DOMAIN]["profiles"]["p"] = {
            "loggers": ["rec.logger"],
            "level_overrides": {"rec.logger": "DEBUG"},
            "excludes": {"rec.logger": ["rec.logger.stored"]},
            "max_duration": 300,
        }
        _loggers, _dur, overrides, excludes, err = _resolve_start_args(
            hass,
            {
                "profile": "p",
                "level_overrides": {"rec.logger": "INFO"},
                "excludes": {"rec.logger": ["rec.logger.request"]},
            },
        )
        assert err is None
        # Scalar overrides stay request-wins.
        assert overrides["rec.logger"] == "INFO"
        # A profile run ignores the request's excludes: the profile is the single
        # source of truth for that recording.
        assert excludes["rec.logger"] == ["rec.logger.stored"]


class TestSetLevels:
    async def test_set_levels_validates_and_skips_core_pinned(
        self, hass, hass_ws_client
    ):
        await _setup(hass)
        hass.data[DOMAIN]["loggers"]["free.logger"] = {
            "friendly_name": "Free", "level": "NOTSET",
        }
        # Pin one exact namespace via core's logger overrides.
        hass.data["logger"] = MagicMock()
        hass.data["logger"].overrides = {"pinned.logger": 10}
        hass.data[DOMAIN]["loggers"]["pinned.logger"] = {
            "friendly_name": "Pinned", "level": "NOTSET",
        }

        client = await hass_ws_client(hass)
        await client.send_json_auto_id({
            "type": "log_manager/set_levels", "level": "DEBUG",
        })
        result = await client.receive_json()
        assert result["success"] is True
        assert result["result"]["skipped"] == 1
        assert result["result"]["skipped_loggers"] == ["pinned.logger"]
        # The report counts actually-changed loggers separately from any that
        # were already at the requested level; the pinned one is excluded.
        assert result["result"]["changed"] >= 1
        assert result["result"]["already"] == 0
        assert hass.data[DOMAIN]["loggers"]["free.logger"]["level"] == "DEBUG"

    async def test_set_levels_rejects_invalid_level(self, hass, hass_ws_client):
        await _setup(hass)
        client = await hass_ws_client(hass)
        await client.send_json_auto_id({
            "type": "log_manager/set_levels", "level": "NOPE",
        })
        result = await client.receive_json()
        assert result["success"] is False


class TestProfiles:
    async def test_ws_profile_save_get_use_delete(self, hass, hass_ws_client):
        await _setup(hass)
        client = await hass_ws_client(hass)

        await client.send_json_auto_id({
            "type": "log_manager/profile_save",
            "name": "p1",
            "loggers": ["rec.logger"],
            "level_overrides": {"rec.logger": "DEBUG"},
            "max_duration": 60,
        })
        result = await client.receive_json()
        assert result["success"] is True
        assert len(result["result"]["profiles"]) == 1

        await client.send_json_auto_id({"type": "log_manager/profiles_get"})
        result = await client.receive_json()
        assert result["result"]["profiles"][0]["name"] == "p1"

        await client.send_json_auto_id({
            "type": "log_manager/start_recording",
            "profile": "p1",
        })
        result = await client.receive_json()
        assert result["success"] is True
        session = hass.data[DOMAIN]["recording"]
        assert session["status"] == "recording"
        assert session["max_duration"] == 60

        await client.send_json_auto_id({"type": "log_manager/discard_recording"})
        result = await client.receive_json()
        assert result["success"] is True

        await client.send_json_auto_id({
            "type": "log_manager/profile_delete",
            "name": "p1",
        })
        result = await client.receive_json()
        assert result["result"]["profiles"] == []

    async def test_ws_start_with_unknown_profile(self, hass, hass_ws_client):
        await _setup(hass)
        client = await hass_ws_client(hass)
        await client.send_json_auto_id({
            "type": "log_manager/start_recording",
            "profile": "missing",
        })
        result = await client.receive_json()
        assert result["success"] is False
        assert result["error"]["code"] == "profile_not_found"


class TestRecordingServices:
    async def test_service_start_stop_discard(self, hass):
        await _setup(hass)

        await hass.services.async_call(
            DOMAIN,
            "start_recording",
            {"loggers": ["rec.logger"], "max_duration": 60},
            blocking=True,
        )
        assert hass.data[DOMAIN]["recording"]["status"] == "recording"

        await hass.services.async_call(DOMAIN, "stop_recording", {}, blocking=True)
        assert hass.data[DOMAIN]["recording"]["status"] == "completed"

        await hass.services.async_call(DOMAIN, "discard_recording", {}, blocking=True)
        assert hass.data[DOMAIN]["recording"]["status"] == "none"

    async def test_stop_service_returns_captured_logs(self, hass):
        await _setup(hass)

        await hass.services.async_call(
            DOMAIN,
            "start_recording",
            {"loggers": ["rec.logger"], "max_duration": 60},
            blocking=True,
        )
        handler = hass.data[DOMAIN]["recording"]["handler"]
        handler.emit(_make_record("rec.logger", logging.WARNING, msg="warn one"))

        result = await hass.services.async_call(
            DOMAIN, "stop_recording", {}, blocking=True, return_response=True
        )

        assert result["log_count"] == 1
        assert result["logs"][0]["message"] == "warn one"
        assert result["status"] == "completed"

        await hass.services.async_call(DOMAIN, "discard_recording", {}, blocking=True)

    async def test_stop_fires_completed_event(self, hass):
        await _setup(hass)
        events = []
        hass.bus.async_listen(
            "log_manager_recording_completed",
            lambda event: events.append(event.data),
        )

        await hass.services.async_call(
            DOMAIN,
            "start_recording",
            {"loggers": ["rec.logger"], "max_duration": 60},
            blocking=True,
        )
        await hass.services.async_call(DOMAIN, "stop_recording", {}, blocking=True)
        await hass.async_block_till_done()

        assert len(events) == 1
        assert events[0]["loggers"] == ["rec.logger"]
        assert "log_count" in events[0]

        await hass.services.async_call(DOMAIN, "discard_recording", {}, blocking=True)

    async def test_restop_does_not_refire_event(self, hass):
        await _setup(hass)
        events = []
        hass.bus.async_listen(
            "log_manager_recording_completed",
            lambda event: events.append(event.data),
        )

        await hass.services.async_call(
            DOMAIN,
            "start_recording",
            {"loggers": ["rec.logger"], "max_duration": 60},
            blocking=True,
        )
        await hass.services.async_call(DOMAIN, "stop_recording", {}, blocking=True)
        await hass.services.async_call(DOMAIN, "stop_recording", {}, blocking=True)
        await hass.async_block_till_done()

        assert len(events) == 1

        await hass.services.async_call(DOMAIN, "discard_recording", {}, blocking=True)


class TestSensorPlatform:
    async def test_builds_sensors_and_reads_values(self, hass):
        handler = LogCounterHandler(hass)
        hass.data[DOMAIN] = {
            "loggers": {
                "sens.log": {
                    "friendly_name": "Sens",
                }
            },
            "counters": {"sens.log": {"warning": 1, "error": 2}},
            "counter_handler": handler,
        }

        async_add_entities = MagicMock()
        await sensor_platform.async_setup_entry(
            hass, MagicMock(), async_add_entities
        )

        entities = async_add_entities.call_args[0][0]
        assert len(entities) == 2
        by_kind = {e._kind: e for e in entities}
        assert set(by_kind) == {"warning", "error"}

        with patch.object(by_kind["warning"], "async_write_ha_state"):
            by_kind["warning"]._refresh()
        with patch.object(by_kind["error"], "async_write_ha_state"):
            by_kind["error"]._refresh()
        assert by_kind["warning"]._attr_native_value == 1
        assert by_kind["error"]._attr_native_value == 2

    async def test_sensors_created_for_every_managed_logger(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {
                "one.log": {"friendly_name": "One"},
                "two.log": {"friendly_name": "Two"},
            },
            "counters": {},
            "counter_handler": LogCounterHandler(hass),
        }

        async_add_entities = MagicMock()
        await sensor_platform.async_setup_entry(
            hass, MagicMock(), async_add_entities
        )
        entities = async_add_entities.call_args[0][0]
        assert len(entities) == 4

    async def test_runtime_added_logger_gets_sensors(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {"one.log": {"friendly_name": "One"}},
            "counters": {},
            "counter_handler": LogCounterHandler(hass),
        }

        async_add_entities = MagicMock()
        await sensor_platform.async_setup_entry(
            hass, MagicMock(), async_add_entities
        )
        added = list(async_add_entities.call_args[0][0])
        assert len(added) == 2

        async_add_entities.reset_mock()
        hass.data[DOMAIN]["loggers"]["two.log"] = {"friendly_name": "Two"}
        async_dispatcher_send(hass, f"{DOMAIN}_sensors_changed")
        await hass.async_block_till_done()

        new_entities = async_add_entities.call_args[0][0]
        assert len(new_entities) == 2

    async def test_unique_ids_are_lowercase_and_collision_free(self):
        first = sensor_platform.LogCounterSensor(None, "foo.bar", "warning", "Foo")
        second = sensor_platform.LogCounterSensor(None, "foo_bar", "warning", "Foo")
        upper = sensor_platform.LogCounterSensor(None, "Foo.Bar", "warning", "Foo")
        assert first._attr_unique_id == first._attr_unique_id.lower()
        assert first._attr_unique_id != second._attr_unique_id
        assert first._attr_unique_id != upper._attr_unique_id

    async def test_removes_sensors_when_logger_removed(self, hass):
        handler = LogCounterHandler(hass)
        hass.data[DOMAIN] = {
            "loggers": {
                "sens.log": {
                    "friendly_name": "Sens",
                }
            },
            "counters": {"sens.log": {"warning": 1, "error": 2}},
            "counter_handler": handler,
        }

        async_add_entities = MagicMock()
        await sensor_platform.async_setup_entry(
            hass, MagicMock(), async_add_entities
        )
        entities = async_add_entities.call_args[0][0]
        for entity in entities:
            entity.async_remove = AsyncMock()

        del hass.data[DOMAIN]["loggers"]["sens.log"]
        async_dispatcher_send(hass, f"{DOMAIN}_sensors_changed")
        await hass.async_block_till_done()

        for entity in entities:
            entity.async_remove.assert_awaited_once_with(force_remove=True)
