import logging
from unittest.mock import AsyncMock, patch

from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.log_manager import DOMAIN

import pytest


@pytest.fixture(autouse=True)
def _mock_hass_http(hass):
    """Ensure hass.http is available for static path registration."""
    hass.http = AsyncMock()
    hass.http.async_register_static_paths = AsyncMock()
    hass.http.register_static_path = AsyncMock()
    yield


@pytest.fixture(autouse=True, name="expected_lingering_timers")
def _expected_lingering_timers():
    return True


async def test_async_setup_entry_initializes_domain_data(hass: HomeAssistant):
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert DOMAIN in hass.data
    assert "loggers" in hass.data[DOMAIN]
    assert hass.data[DOMAIN]["loggers"] == {}
    assert "counters" in hass.data[DOMAIN]
    assert "store" in hass.data[DOMAIN]
    assert "save_data" in hass.data[DOMAIN]
    assert "counter_handler" in hass.data[DOMAIN]
    assert "recording" in hass.data[DOMAIN]


async def test_async_unload_entry_removes_handlers_and_data(hass):
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    counter_handler = hass.data[DOMAIN]["counter_handler"]
    assert counter_handler in logging.root.handlers

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    assert counter_handler not in logging.root.handlers
    assert "loggers" not in hass.data[DOMAIN]
    assert "counters" not in hass.data[DOMAIN]
    assert "recording" not in hass.data[DOMAIN]


async def test_async_setup_entry_restores_stored_loggers_and_levels(hass):
    store_data = {
        "loggers": {
            "my.logger": {"friendly_name": "My Logger", "level": "WARNING"},
            "other": {"friendly_name": "Other", "level": "DEBUG"},
        }
    }

    with patch(
        "custom_components.log_manager.LogManagerStore.async_load",
    ) as mock_load:
        mock_load.return_value = store_data
        entry = MockConfigEntry(domain=DOMAIN, data={})
        entry.add_to_hass(hass)

        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    loggers = hass.data[DOMAIN]["loggers"]
    assert loggers["my.logger"]["friendly_name"] == "My Logger"
    assert loggers["my.logger"]["level"] == "WARNING"
    assert loggers["other"]["friendly_name"] == "Other"
    assert loggers["other"]["level"] == "DEBUG"

    assert logging.getLogger("my.logger").getEffectiveLevel() == logging.WARNING
    assert logging.getLogger("other").getEffectiveLevel() == logging.DEBUG


async def test_add_logger_service(hass):
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    await hass.services.async_call(
        DOMAIN, "add_logger",
        {"logger_name": "test.module", "friendly_name": "Test Module"},
        blocking=True,
    )

    assert "test.module" in hass.data[DOMAIN]["loggers"]
    assert hass.data[DOMAIN]["loggers"]["test.module"]["friendly_name"] == "Test Module"
    assert hass.data[DOMAIN]["loggers"]["test.module"]["level"] == "NOTSET"
    assert "test.module" in hass.data[DOMAIN]["counters"]


async def test_remove_logger_service(hass):
    store_data = {
        "loggers": {
            "to.remove": {"friendly_name": "To Remove", "level": "NOTSET"},
        }
    }

    with patch(
        "custom_components.log_manager.LogManagerStore.async_load",
    ) as mock_load:
        mock_load.return_value = store_data
        entry = MockConfigEntry(domain=DOMAIN, data={})
        entry.add_to_hass(hass)
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    await hass.services.async_call(
        DOMAIN, "remove_logger",
        {"logger_name": "to.remove"},
        blocking=True,
    )

    assert "to.remove" not in hass.data[DOMAIN]["loggers"]
    assert "to.remove" not in hass.data[DOMAIN]["counters"]


async def test_add_logger_duplicate_is_rejected(hass, caplog):
    store_data = {
        "loggers": {
            "existing": {"friendly_name": "Existing", "level": "NOTSET"},
        }
    }
    caplog.set_level(logging.WARNING)

    with patch(
        "custom_components.log_manager.LogManagerStore.async_load",
    ) as mock_load:
        mock_load.return_value = store_data
        entry = MockConfigEntry(domain=DOMAIN, data={})
        entry.add_to_hass(hass)
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    await hass.services.async_call(
        DOMAIN, "add_logger",
        {"logger_name": "existing", "friendly_name": "Existing"},
        blocking=True,
    )

    assert "already being managed" in caplog.text
    assert hass.data[DOMAIN]["loggers"]["existing"]["friendly_name"] == "Existing"


async def test_reset_counters_for_specific_logger(hass):
    store_data = {
        "loggers": {
            "logger.a": {"friendly_name": "Logger A", "level": "NOTSET"},
            "logger.b": {"friendly_name": "Logger B", "level": "NOTSET"},
        }
    }

    with patch(
        "custom_components.log_manager.LogManagerStore.async_load",
    ) as mock_load:
        mock_load.return_value = store_data
        entry = MockConfigEntry(domain=DOMAIN, data={})
        entry.add_to_hass(hass)
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    hass.data[DOMAIN]["counters"]["logger.a"]["warning"] = 5
    hass.data[DOMAIN]["counters"]["logger.b"]["error"] = 3

    await hass.services.async_call(
        DOMAIN, "reset_counters",
        {"logger_name": "logger.a"},
        blocking=True,
    )

    counters = hass.data[DOMAIN]["counters"]
    assert counters["logger.a"]["warning"] == 0
    assert counters["logger.a"]["error"] == 0
    assert counters["logger.b"]["error"] == 3


async def test_reset_all_counters(hass):
    store_data = {
        "loggers": {
            "logger.a": {"friendly_name": "Logger A", "level": "NOTSET"},
            "logger.b": {"friendly_name": "Logger B", "level": "NOTSET"},
        }
    }

    with patch(
        "custom_components.log_manager.LogManagerStore.async_load",
    ) as mock_load:
        mock_load.return_value = store_data
        entry = MockConfigEntry(domain=DOMAIN, data={})
        entry.add_to_hass(hass)
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    hass.data[DOMAIN]["counters"]["logger.a"]["warning"] = 5
    hass.data[DOMAIN]["counters"]["logger.b"]["error"] = 3

    await hass.services.async_call(
        DOMAIN, "reset_counters",
        {},
        blocking=True,
    )

    counters = hass.data[DOMAIN]["counters"]
    assert counters["logger.a"]["warning"] == 0
    assert counters["logger.b"]["error"] == 0


async def test_ws_get_loggers_returns_sorted_loggers(hass, hass_ws_client):
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    logging.getLogger("zeta.test.logger")
    logging.getLogger("alpha.test.logger")

    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/get_loggers"})
    result = await client.receive_json()

    assert result["success"] is True
    loggers = result["result"]
    assert loggers == sorted(loggers)
    assert "alpha.test.logger" in loggers
    assert "zeta.test.logger" in loggers


async def test_ws_get_stats_returns_counters(hass, hass_ws_client):
    store_data = {
        "loggers": {
            "stats.logger": {"friendly_name": "Stats", "level": "NOTSET"},
        }
    }
    with patch(
        "custom_components.log_manager.LogManagerStore.async_load",
    ) as mock_load:
        mock_load.return_value = store_data
        entry = MockConfigEntry(domain=DOMAIN, data={})
        entry.add_to_hass(hass)
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    handler = hass.data[DOMAIN]["counter_handler"]
    handler.emit(logging.LogRecord(
        "stats.logger", logging.WARNING, "test.py", 1, "boom", (), None
    ))

    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/get_stats"})
    result = await client.receive_json()

    assert result["success"] is True
    counters = result["result"]
    assert counters["stats.logger"]["warning"] == 1
    assert counters["stats.logger"]["recent_logs"][0]["message"] == "boom"


async def test_ws_get_stats_after_unload_returns_empty(hass, hass_ws_client):
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    client = await hass_ws_client(hass)

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    await client.send_json_auto_id({"type": f"{DOMAIN}/get_stats"})
    result = await client.receive_json()

    assert result["success"] is True
    assert result["result"] == {}
