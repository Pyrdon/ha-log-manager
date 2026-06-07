import logging
from unittest.mock import AsyncMock, MagicMock, patch

from custom_components.log_manager import DOMAIN
from custom_components.log_manager.select import LOG_LEVELS, LogLevelSelect, async_setup_entry


async def test_entity_initialization(hass):
    hass.data[DOMAIN] = {
        "loggers": {"my.module": {"friendly_name": "My Module", "level": "WARNING"}},
    }

    entity = LogLevelSelect(hass, "my.module", "My Module")

    assert entity.name == "My Module"
    assert entity.icon == "mdi:math-log"
    assert entity.options == LOG_LEVELS
    assert entity.current_option == "WARNING"
    assert entity.unique_id == "log_manager_my_module"
    assert entity.extra_state_attributes == {"logger_name": "my.module"}


async def test_entity_init_defaults_to_info_when_no_stored_level(hass):
    hass.data[DOMAIN] = {
        "loggers": {"new.logger": {"friendly_name": "New"}},
    }

    entity = LogLevelSelect(hass, "new.logger", "New")

    assert entity.current_option == "INFO"


async def test_entity_init_with_missing_loggers_data(hass):
    hass.data[DOMAIN] = {"loggers": {}}

    entity = LogLevelSelect(hass, "orphan", "Orphan")

    assert entity.current_option == "INFO"
    assert entity.unique_id == "log_manager_orphan"


async def test_select_option_sets_logger_level_and_persists(hass):
    save_data = AsyncMock()
    hass.data[DOMAIN] = {
        "loggers": {"test_logger": {"friendly_name": "Test", "level": "NOTSET"}},
        "save_data": save_data,
    }

    entity = LogLevelSelect(hass, "test_logger", "Test")
    test_logger = logging.getLogger("test_logger")

    with patch.object(entity, "async_write_ha_state"):
        await entity.async_select_option("WARNING")

    assert entity.current_option == "WARNING"
    assert test_logger.getEffectiveLevel() == logging.WARNING
    assert hass.data[DOMAIN]["loggers"]["test_logger"]["level"] == "WARNING"
    save_data.assert_awaited_once()


async def test_select_option_multiple_levels(hass):
    hass.data[DOMAIN] = {
        "loggers": {"multi": {"friendly_name": "Multi", "level": "NOTSET"}},
        "save_data": AsyncMock(),
    }

    entity = LogLevelSelect(hass, "multi", "Multi")
    logger = logging.getLogger("multi")

    with patch.object(entity, "async_write_ha_state"):
        await entity.async_select_option("DEBUG")
    assert logger.getEffectiveLevel() == logging.DEBUG

    with patch.object(entity, "async_write_ha_state"):
        await entity.async_select_option("INFO")
    assert logger.getEffectiveLevel() == logging.INFO

    with patch.object(entity, "async_write_ha_state"):
        await entity.async_select_option("ERROR")
    assert logger.getEffectiveLevel() == logging.ERROR

    with patch.object(entity, "async_write_ha_state"):
        await entity.async_select_option("CRITICAL")
    assert logger.getEffectiveLevel() == logging.CRITICAL


async def test_select_option_no_save_data_key(hass):
    hass.data[DOMAIN] = {
        "loggers": {"no_save": {"friendly_name": "No Save", "level": "NOTSET"}},
    }

    entity = LogLevelSelect(hass, "no_save", "No Save")

    with patch.object(entity, "async_write_ha_state"):
        await entity.async_select_option("INFO")

    assert entity.current_option == "INFO"
    assert hass.data[DOMAIN]["loggers"]["no_save"]["level"] == "INFO"


async def test_handle_remove_signal_matching(hass):
    hass.data[DOMAIN] = {
        "loggers": {"target": {"friendly_name": "Target", "level": "NOTSET"}},
    }

    entity = LogLevelSelect(hass, "target", "Target")

    with patch.object(entity, "async_remove") as mock_remove:
        await entity._handle_remove_signal("target")
        mock_remove.assert_awaited_once_with(force_remove=True)


async def test_handle_remove_signal_non_matching(hass):
    hass.data[DOMAIN] = {
        "loggers": {"keep": {"friendly_name": "Keep", "level": "NOTSET"}},
    }

    entity = LogLevelSelect(hass, "keep", "Keep")

    with patch.object(entity, "async_remove") as mock_remove:
        await entity._handle_remove_signal("different_logger")
        mock_remove.assert_not_awaited()


async def test_async_setup_entry_restores_stored_loggers(hass):
    hass.data[DOMAIN] = {
        "loggers": {
            "logger.one": {"friendly_name": "Logger One", "level": "DEBUG"},
            "logger.two": {"friendly_name": "Logger Two", "level": "INFO"},
        },
    }

    async_add_entities = MagicMock()
    await async_setup_entry(hass, MagicMock(), async_add_entities)

    async_add_entities.assert_called_once()
    entities = async_add_entities.call_args[0][0]
    assert len(entities) == 2
    names = {e._logger_name: e.name for e in entities}
    assert names == {"logger.one": "Logger One", "logger.two": "Logger Two"}


async def test_async_setup_entry_empty_storage(hass):
    hass.data[DOMAIN] = {"loggers": {}}

    async_add_entities = MagicMock()
    await async_setup_entry(hass, MagicMock(), async_add_entities)

    async_add_entities.assert_not_called()
