from collections import namedtuple
from unittest.mock import MagicMock

import homeassistant.components.http as ha_http

# StaticPathConfig was added in HA 2024.6+. Shim for older versions.
if not hasattr(ha_http, "StaticPathConfig"):
    ha_http.StaticPathConfig = namedtuple(
        "StaticPathConfig", ["url_path", "path", "cache_headers"]
    )


import pytest


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield
