import logging
from unittest.mock import patch

from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.log_manager import DOMAIN
from custom_components.log_manager import recording as recording_module

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


async def _send(client, payload):
    await client.send_json_auto_id(payload)
    return await client.receive_json()


async def _start_recording(client, loggers, **kwargs):
    payload = {"type": "log_manager/start_recording", "loggers": loggers}
    payload.update(kwargs)
    return await _send(client, payload)


async def test_ws_recording_flow(hass, hass_ws_client):
    """Full happy path: start, collect, status, incremental entries, stop."""
    await _setup(hass)
    client = await hass_ws_client(hass)

    res = await _start_recording(client, ["rec.logger"])
    assert res["success"] is True
    assert res["result"]["status"] == "recording"
    assert res["result"]["max_duration"] == 300

    recording = hass.data[DOMAIN]["recording"]
    assert recording["status"] == "recording"
    handler = recording["handler"]
    handler.emit(_make_record("rec.logger", logging.WARNING, msg="warn one"))
    handler.emit(_make_record("rec.logger", logging.INFO, msg="info one"))
    handler.emit(_make_record("rec.logger.child", logging.ERROR, msg="err one"))

    res = await _send(client, {"type": "log_manager/recording_status"})
    assert res["success"] is True
    status = res["result"]
    assert status["status"] == "recording"
    assert status["log_count"] == 3
    assert status["logger_counts"] == {"rec.logger": 3}
    assert status["loggers"] == ["rec.logger"]

    res = await _send(client, {"type": "log_manager/recording_entries", "after_id": 0})
    assert res["success"] is True
    entries = res["result"]["entries"]
    assert [e["id"] for e in entries] == [0, 1, 2]
    assert res["result"]["next_id"] == 3
    assert entries[2]["logger"] == "rec.logger.child"
    assert entries[2]["level"] == "ERROR"

    # Incremental poll with the returned next_id yields nothing new yet.
    res = await _send(client, {"type": "log_manager/recording_entries", "after_id": 3})
    assert res["result"]["entries"] == []

    # A new entry is delivered on the following incremental poll.
    handler.emit(_make_record("rec.logger", logging.WARNING, msg="warn two"))
    res = await _send(client, {"type": "log_manager/recording_entries", "after_id": 3})
    assert [e["id"] for e in res["result"]["entries"]] == [3]

    res = await _send(client, {"type": "log_manager/stop_recording"})
    assert res["success"] is True
    result = res["result"]
    assert result["status"] == "completed"
    assert result["log_count"] == 4
    assert [e["id"] for e in result["logs"]] == [0, 1, 2, 3]
    assert result["logs"][0]["logger"] == "rec.logger"

    res = await _send(client, {"type": "log_manager/recording_status"})
    assert res["result"]["status"] == "none"


async def test_ws_start_recording_rejects_unknown_logger(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)

    res = await _start_recording(client, ["not.managed"])
    assert res["success"] is False
    assert res["error"]["code"] == "unknown_logger"
    assert "not.managed" in res["error"]["message"]


async def test_ws_start_recording_rejects_when_already_recording(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)

    res = await _start_recording(client, ["rec.logger"])
    assert res["success"] is True

    res = await _start_recording(client, ["other.logger"])
    assert res["success"] is False
    assert res["error"]["code"] == "already_recording"

    res = await _send(client, {"type": "log_manager/stop_recording"})
    assert res["success"] is True


async def test_ws_stop_recording_without_session(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)

    res = await _send(client, {"type": "log_manager/stop_recording"})
    assert res["success"] is False
    assert res["error"]["code"] == "not_recording"


async def test_ws_recording_entries_without_session(hass, hass_ws_client):
    await _setup(hass)
    client = await hass_ws_client(hass)

    res = await _send(client, {"type": "log_manager/recording_entries", "after_id": 0})
    assert res["success"] is True
    assert res["result"] == {"entries": [], "next_id": 0}


async def test_unload_stops_active_recording(hass, hass_ws_client):
    """Unloading the integration removes the recording handler and cancels the session."""
    await _setup(hass)
    client = await hass_ws_client(hass)

    res = await _start_recording(client, ["rec.logger"])
    assert res["success"] is True

    handler = hass.data[DOMAIN]["recording"]["handler"]
    assert handler in logging.root.handlers

    entry = hass.config_entries.async_entries(DOMAIN)[0]
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    assert handler not in logging.root.handlers
    assert "recording" not in hass.data[DOMAIN]


async def test_ws_recording_timeout_completes_session(
    hass, hass_ws_client, monkeypatch
):
    """The async_call_later timeout transitions the session to completed."""
    await _setup(hass)

    captured = {}

    def fake_async_call_later(hass, delay, action):
        captured["action"] = action
        return lambda: None

    monkeypatch.setattr(recording_module, "async_call_later", fake_async_call_later)

    client = await hass_ws_client(hass)
    res = await _start_recording(client, ["rec.logger"], max_duration=10)
    assert res["success"] is True

    handler = hass.data[DOMAIN]["recording"]["handler"]
    handler.emit(_make_record("rec.logger", logging.WARNING, msg="warn one"))

    captured["action"](dt_util.utcnow())
    await hass.async_block_till_done()

    res = await _send(client, {"type": "log_manager/recording_status"})
    assert res["result"]["status"] == "completed"
    assert res["result"]["log_count"] == 1

    res = await _send(client, {"type": "log_manager/stop_recording"})
    assert res["success"] is True
    assert res["result"]["log_count"] == 1
