from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.log_manager import DOMAIN
from custom_components.log_manager.config_flow import LogManagerConfigFlow


async def test_single_instance_abort(hass):
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)

    flow = LogManagerConfigFlow()
    flow.hass = hass
    flow.context = {"source": config_entries.SOURCE_USER}

    result = await flow.async_step_user(user_input=None)
    assert result["type"] == FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_form_shown_when_no_input(hass):
    flow = LogManagerConfigFlow()
    flow.hass = hass
    flow.context = {"source": config_entries.SOURCE_USER}

    result = await flow.async_step_user(user_input=None)
    assert result["type"] == FlowResultType.FORM
    assert result["step_id"] == "user"
    assert result["data_schema"] is None


async def test_create_entry_with_user_input(hass):
    flow = LogManagerConfigFlow()
    flow.hass = hass
    flow.context = {"source": config_entries.SOURCE_USER}

    result = await flow.async_step_user(user_input={})
    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert result["title"] == "Log Manager"
    assert result["data"] == {}
