from collections.abc import Iterable

DOMAIN = "log_manager"
STORAGE_KEY = f"{DOMAIN}.config"
STORAGE_VERSION = 2
LOG_LEVELS_LIST = ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


def match_managed_logger(name: str, managed: Iterable[str]) -> str | None:
    """Return the managed logger that owns ``name``, or None.

    Matches the exact logger name, otherwise the most specific managed parent
    (e.g. "custom_components.foo.sensor" is owned by "custom_components.foo").
    When several managed loggers are parents of the name, the longest prefix wins.
    """
    if name in managed:
        return name
    matches = [candidate for candidate in managed if name.startswith(candidate + ".")]
    if not matches:
        return None
    return max(matches, key=len)
