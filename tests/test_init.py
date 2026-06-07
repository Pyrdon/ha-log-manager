import logging
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.core import HomeAssistant

from custom_components.log_manager import (
    DOMAIN,
    STORAGE_KEY,
    STORAGE_VERSION,
    LogCounterHandler,
    LogRecordingHandler,
    LogManagerStore,
    async_register_lovelace_resource,
)


class TestLogCounterHandler:
    @staticmethod
    def _make_record(
        name, level, msg="test", pathname="test.py", lineno=1, exc_info=None
    ):
        return logging.LogRecord(
            name=name,
            level=level,
            pathname=pathname,
            lineno=lineno,
            msg=msg,
            args=(),
            exc_info=exc_info,
        )

    def _handler_and_hass(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {
                "exact_logger": {"friendly_name": "Exact", "level": "NOTSET"},
                "parent_logger": {"friendly_name": "Parent", "level": "NOTSET"},
            },
            "counters": {},
        }
        return LogCounterHandler(hass), hass

    def test_emit_matches_exact_logger_name(self, hass):
        handler, _ = self._handler_and_hass(hass)
        record = self._make_record("exact_logger", logging.WARNING)
        handler.emit(record)
        assert hass.data[DOMAIN]["counters"]["exact_logger"]["warning"] == 1

    def test_emit_matches_child_logger(self, hass):
        handler, _ = self._handler_and_hass(hass)
        record = self._make_record("parent_logger.child.module", logging.WARNING)
        handler.emit(record)
        assert "parent_logger" in hass.data[DOMAIN]["counters"]
        assert hass.data[DOMAIN]["counters"]["parent_logger"]["warning"] == 1

    def test_emit_matches_deeply_nested_child(self, hass):
        handler, _ = self._handler_and_hass(hass)
        record = self._make_record("parent_logger.a.b.c.d", logging.WARNING)
        handler.emit(record)
        assert hass.data[DOMAIN]["counters"]["parent_logger"]["warning"] == 1

    def test_emit_ignores_non_managed_loggers(self, hass):
        handler, _ = self._handler_and_hass(hass)
        record = self._make_record("unrelated_logger", logging.WARNING)
        handler.emit(record)
        assert hass.data[DOMAIN]["counters"] == {}

    def test_emit_ignores_when_no_loggers_configured(self, hass):
        hass.data[DOMAIN] = {"loggers": {}, "counters": {}}
        handler = LogCounterHandler(hass)
        record = self._make_record("anything", logging.WARNING)
        handler.emit(record)
        assert hass.data[DOMAIN]["counters"] == {}

    def test_emit_separates_warning_and_error_counts(self, hass):
        handler, _ = self._handler_and_hass(hass)
        handler.emit(self._make_record("exact_logger", logging.WARNING, msg="warn1"))
        handler.emit(self._make_record("exact_logger", logging.ERROR, msg="err1"))
        handler.emit(self._make_record("exact_logger", logging.CRITICAL, msg="crit1"))
        handler.emit(self._make_record("exact_logger", logging.WARNING, msg="warn2"))

        counters = hass.data[DOMAIN]["counters"]["exact_logger"]
        assert counters["warning"] == 2
        assert counters["error"] == 2
        assert counters["last_warning"] == "warn2"
        assert counters["last_error"] == "crit1"

    def test_emit_respects_max_recent_limit(self, hass):
        handler, _ = self._handler_and_hass(hass)
        total = handler.MAX_RECENT + 5
        for i in range(total):
            record = self._make_record(
                "exact_logger", logging.WARNING, msg=f"msg {i}", lineno=i
            )
            handler.emit(record)

        recent = hass.data[DOMAIN]["counters"]["exact_logger"]["recent_logs"]
        assert len(recent) == handler.MAX_RECENT
        assert recent[0]["message"] == f"msg {total - 1}"

    def test_emit_entry_structure(self, hass):
        handler, _ = self._handler_and_hass(hass)
        record = self._make_record(
            "exact_logger",
            logging.ERROR,
            msg="something broke",
            pathname="/app/module.py",
            lineno=99,
        )
        handler.emit(record)

        entry = hass.data[DOMAIN]["counters"]["exact_logger"]["recent_logs"][0]
        assert "timestamp" in entry
        assert entry["level"] == "ERROR"
        assert entry["message"] == "something broke"
        assert entry["source"] == "/app/module.py:99"

    def test_emit_with_exception_does_not_crash(self, hass):
        handler, _ = self._handler_and_hass(hass)
        record = self._make_record("exact_logger", logging.ERROR, exc_info=Exception("boom"))
        handler.emit(record)
        assert hass.data[DOMAIN]["counters"]["exact_logger"]["error"] == 1

    def test_emit_last_error_updates_on_consecutive_errors(self, hass):
        handler, _ = self._handler_and_hass(hass)
        handler.emit(self._make_record("exact_logger", logging.ERROR, msg="first"))
        handler.emit(self._make_record("exact_logger", logging.ERROR, msg="second"))
        handler.emit(self._make_record("exact_logger", logging.ERROR, msg="third"))

        counters = hass.data[DOMAIN]["counters"]["exact_logger"]
        assert counters["last_error"] == "third"
        assert counters["error"] == 3


class TestLogRecordingHandler:
    @staticmethod
    def _make_record(
        name, level, msg="test", pathname="test.py", lineno=1, exc_info=None
    ):
        return logging.LogRecord(
            name=name,
            level=level,
            pathname=pathname,
            lineno=lineno,
            msg=msg,
            args=(),
            exc_info=exc_info,
        )

    def _setup_hass(self, hass):
        hass.data[DOMAIN] = {
            "loggers": {
                "low_logger": {"friendly_name": "Low", "level": "DEBUG"},
                "high_logger": {"friendly_name": "High", "level": "WARNING"},
            },
        }

    def test_emit_buffers_log_entries(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])
        )
        handler.emit(self._make_record("low_logger", logging.INFO, msg="hello"))

        assert len(handler.buffer) == 1
        entry = handler.buffer[0]
        assert entry["level"] == "INFO"
        assert entry["message"] == "hello"
        assert entry["logger"] == "low_logger"
        assert "id" in entry
        assert "timestamp" in entry
        assert "source" in entry

    def test_emit_sequential_entry_ids(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])
        )
        handler.emit(self._make_record("low_logger", logging.INFO))
        handler.emit(self._make_record("low_logger", logging.INFO))

        assert handler.buffer[0]["id"] == 0
        assert handler.buffer[1]["id"] == 1

    def test_emit_passes_records_at_or_above_stored_level(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])  # stored level: DEBUG
        )
        handler.emit(self._make_record("low_logger", logging.DEBUG))
        assert len(handler.buffer) == 1

    def test_emit_filters_records_below_stored_level(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["high_logger"])  # stored level: WARNING
        )
        handler.emit(self._make_record("high_logger", logging.INFO))
        assert len(handler.buffer) == 0

        handler.emit(self._make_record("high_logger", logging.WARNING))
        assert len(handler.buffer) == 1

    def test_emit_level_overrides_take_precedence(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass,
            logger_names=frozenset(["low_logger"]),
            level_overrides={"low_logger": "WARNING"},
        )
        handler.emit(self._make_record("low_logger", logging.INFO))
        assert len(handler.buffer) == 0

        handler.emit(self._make_record("low_logger", logging.WARNING))
        assert len(handler.buffer) == 1

    def test_emit_level_override_with_notset_falls_back_to_debug(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass,
            logger_names=frozenset(["low_logger"]),
            level_overrides={"low_logger": "NOTSET"},
        )
        handler.emit(self._make_record("low_logger", logging.DEBUG))
        assert len(handler.buffer) == 1

    def test_emit_unknown_level_coerces_to_debug(self, hass):
        self._setup_hass(hass)
        hass.data[DOMAIN]["loggers"]["low_logger"]["level"] = "BOGUS"
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])
        )
        handler.emit(self._make_record("low_logger", logging.DEBUG))
        assert len(handler.buffer) == 1

    def test_emit_respects_max_buffer_size(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])
        )
        total = handler.MAX_BUFFER_SIZE + 50
        for i in range(total):
            handler.emit(
                self._make_record("low_logger", logging.INFO, msg=f"msg {i}")
            )

        assert len(handler.buffer) == handler.MAX_BUFFER_SIZE

    def test_emit_oldest_entries_evicted_first(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])
        )
        for i in range(handler.MAX_BUFFER_SIZE + 1):
            handler.emit(
                self._make_record("low_logger", logging.INFO, msg=f"msg {i}")
            )

        ids = [e["id"] for e in handler.buffer]
        assert ids[0] == 1
        assert ids[-1] == handler.MAX_BUFFER_SIZE

    def test_match_logger_exact(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger", "high_logger"])
        )
        assert handler._match_logger("low_logger") == "low_logger"
        assert handler._match_logger("high_logger") == "high_logger"
        assert handler._match_logger("unknown") is None

    def test_match_logger_child(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])
        )
        assert handler._match_logger("low_logger.child") == "low_logger"
        assert handler._match_logger("low_logger.a.b.c") == "low_logger"

    def test_match_logger_no_match_for_partial_prefix(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])
        )
        assert handler._match_logger("low_logger_extra") is None

    def test_logger_counts_tracked_per_logger(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger", "high_logger"])
        )
        r = self._make_record
        handler.emit(r("low_logger", logging.INFO))
        handler.emit(r("low_logger", logging.INFO))
        handler.emit(r("high_logger", logging.WARNING))

        assert handler.logger_counts == {"low_logger": 2, "high_logger": 1}

    def test_logger_counts_unmatched_logger_not_counted(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])
        )
        handler.emit(self._make_record("low_logger", logging.INFO))
        handler.emit(self._make_record("unknown", logging.INFO))
        assert handler.logger_counts == {"low_logger": 1}

    def test_emit_source_field(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])
        )
        handler.emit(
            self._make_record(
                "low_logger", logging.INFO, pathname="/code/app.py", lineno=42
            )
        )
        assert handler.buffer[0]["source"] == "/code/app.py:42"

    def test_emit_handles_exception_gracefully(self, hass):
        self._setup_hass(hass)
        handler = LogRecordingHandler(
            hass, logger_names=frozenset(["low_logger"])
        )
        broken_record = self._make_record(
            "low_logger", logging.INFO, exc_info=Exception("fail")
        )
        handler.emit(broken_record)
        assert len(handler.buffer) == 1


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

        with patch("custom_components.log_manager.logging.getLogger") as mock_get_logger:
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

        with patch("custom_components.log_manager.logging.getLogger") as mock_get_logger:
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

        with patch("custom_components.log_manager.logging.getLogger") as mock_get_logger:
            mock_logger = MagicMock()
            mock_logger.getEffectiveLevel.return_value = 20
            mock_get_logger.return_value = mock_logger

            result = await store._async_migrate_func(1, 0, old_data)

        assert result["some_extra_key"] == "should remain"
        assert result["version"] == 1


class TestAsyncRegisterLovelaceResource:
    @staticmethod
    def _mock_resources(loaded=True, items=None):
        resources = MagicMock()
        resources.loaded = loaded
        resources.async_load = AsyncMock()
        resources.async_create_item = AsyncMock()
        resources.async_update_item = AsyncMock()
        resources.async_items = MagicMock(return_value=items or [])
        return resources

    async def test_returns_early_when_lovelace_not_in_data(self, hass):
        await async_register_lovelace_resource(hass)

    async def test_returns_early_when_no_resources_attr(self, hass):
        hass.data["lovelace"] = object()
        await async_register_lovelace_resource(hass)

    async def test_creates_resource_when_missing_from_list(self, hass):
        resources = self._mock_resources(items=[])
        hass.data["lovelace"] = MagicMock(resources=resources)

        await async_register_lovelace_resource(hass)

        resources.async_create_item.assert_awaited_once()
        args = resources.async_create_item.call_args[0][0]
        assert args["res_type"] == "module"
        assert args["url"] == f"/{DOMAIN}_ui/log_manager_card.js?v=1"

    async def test_skips_when_resource_url_matches_current(self, hass):
        item = MagicMock(url=f"/{DOMAIN}_ui/log_manager_card.js?v=1", id="r1")
        resources = self._mock_resources(items=[item])
        hass.data["lovelace"] = MagicMock(resources=resources)

        await async_register_lovelace_resource(hass)

        resources.async_create_item.assert_not_called()
        resources.async_update_item.assert_not_called()

    async def test_updates_when_resource_url_differs(self, hass):
        item = MagicMock(
            url=f"/{DOMAIN}_ui/log_manager_card.js?v=old_version", id="r1"
        )
        resources = self._mock_resources(items=[item])
        hass.data["lovelace"] = MagicMock(resources=resources)

        await async_register_lovelace_resource(hass)

        resources.async_update_item.assert_awaited_once_with(
            "r1",
            {
                "res_type": "module",
                "url": f"/{DOMAIN}_ui/log_manager_card.js?v=1",
            },
        )

    async def test_updates_dict_resource_items(self, hass):
        item = {"url": f"/{DOMAIN}_ui/log_manager_card.js?v=stale", "id": "d1"}
        resources = self._mock_resources(items=[item])
        hass.data["lovelace"] = MagicMock(resources=resources)

        await async_register_lovelace_resource(hass)

        resources.async_update_item.assert_awaited_once_with(
            "d1",
            {
                "res_type": "module",
                "url": f"/{DOMAIN}_ui/log_manager_card.js?v=1",
            },
        )

    async def test_loads_resources_if_not_loaded(self, hass):
        resources = self._mock_resources(loaded=False, items=[])
        hass.data["lovelace"] = MagicMock(resources=resources)

        await async_register_lovelace_resource(hass)

        resources.async_load.assert_awaited_once()

    async def test_uses_file_mtime_for_version_when_available(self, hass):
        resources = self._mock_resources(items=[])
        hass.data["lovelace"] = MagicMock(resources=resources)

        with patch("custom_components.log_manager.os.path.getmtime") as mock_mtime:
            mock_mtime.return_value = 1234567890.123456
            await async_register_lovelace_resource(hass)

        resources.async_create_item.assert_awaited_once()
        url = resources.async_create_item.call_args[0][0]["url"]
        assert "/log_manager_ui/log_manager_card.js?v=1234567890123456" in url
