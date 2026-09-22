"""Tests for Lovelace resource and static-path registration of the card."""

from unittest.mock import AsyncMock, MagicMock, patch

from custom_components.log_manager import DOMAIN
from custom_components.log_manager.lovelace import async_register_lovelace_resource


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

        with patch("custom_components.log_manager.lovelace.os.scandir") as mock_scandir, \
                patch("custom_components.log_manager.lovelace.os.path.getmtime") as mock_mtime:
            mock_scandir.return_value = [self._fake_dir_entry("log_manager_card.js")]
            mock_mtime.return_value = 1234567890.123456
            await async_register_lovelace_resource(hass)

        resources.async_create_item.assert_awaited_once()
        url = resources.async_create_item.call_args[0][0]["url"]
        # Newest mtime (digits) plus the count of served .js files.
        assert "/log_manager_ui/log_manager_card.js?v=12345678901234561" in url

    @staticmethod
    def _fake_dir_entry(name, is_file=True):
        entry = MagicMock()
        entry.name = name
        entry.is_file.return_value = is_file
        return entry

    async def test_version_changes_when_sibling_file_changes(self, hass):
        # The URL must change on a sibling-only edit: the newest mtime across
        # served files plus the served-file count feeds the version.
        resources = self._mock_resources(items=[])
        hass.data["lovelace"] = MagicMock(resources=resources)

        served = [
            self._fake_dir_entry("log_manager_card.js"),
            self._fake_dir_entry("card-styles.js"),
        ]

        with patch("custom_components.log_manager.lovelace.os.scandir", return_value=served), \
                patch("custom_components.log_manager.lovelace.os.path.getmtime") as mock_mtime:
            # Card older, sibling newer: the sibling mtime must win.
            mock_mtime.side_effect = lambda path: (
                1000000000.0 if path.endswith("log_manager_card.js") else 2000000000.5
            )
            await async_register_lovelace_resource(hass)

            sibling_url = resources.async_create_item.call_args[0][0]["url"]

            # Same card mtime, sibling changed: version and URL must differ.
            mock_mtime.side_effect = lambda path: (
                1000000000.0 if path.endswith("log_manager_card.js") else 3000000000.25
            )
            resources.async_create_item.reset_mock()
            await async_register_lovelace_resource(hass)

            changed_url = resources.async_create_item.call_args[0][0]["url"]

        assert sibling_url != changed_url
        assert "20000000005" in sibling_url
        assert "300000000025" in changed_url

    async def test_version_counts_all_served_siblings(self, hass):
        # Adding a sibling (same mtime) changes the count suffix, so the URL moves.
        resources = self._mock_resources(items=[])
        hass.data["lovelace"] = MagicMock(resources=resources)
        card_only = [self._fake_dir_entry("log_manager_card.js")]
        with_sibling = card_only + [self._fake_dir_entry("card-markup.js")]

        with patch("custom_components.log_manager.lovelace.os.scandir") as mock_scandir, \
                patch("custom_components.log_manager.lovelace.os.path.getmtime") as mock_mtime:
            mock_mtime.return_value = 1000000000.0
            mock_scandir.return_value = card_only
            await async_register_lovelace_resource(hass)
            one_file_url = resources.async_create_item.call_args[0][0]["url"]

            mock_scandir.return_value = with_sibling
            resources.async_create_item.reset_mock()
            await async_register_lovelace_resource(hass)
            two_file_url = resources.async_create_item.call_args[0][0]["url"]

        assert one_file_url != two_file_url
        assert one_file_url.endswith("100000000001")
        assert two_file_url.endswith("100000000002")

    async def test_falls_back_to_version_one_when_no_js_files(self, hass):
        resources = self._mock_resources(items=[])
        hass.data["lovelace"] = MagicMock(resources=resources)

        with patch("custom_components.log_manager.lovelace.os.scandir", return_value=[]):
            await async_register_lovelace_resource(hass)

        resources.async_create_item.assert_awaited_once()
        url = resources.async_create_item.call_args[0][0]["url"]
        assert url == f"/{DOMAIN}_ui/log_manager_card.js?v=1"
