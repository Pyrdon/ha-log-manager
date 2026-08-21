from collections.abc import Iterable
import time

DOMAIN = "log_manager"
STORAGE_KEY = f"{DOMAIN}.config"
STORAGE_VERSION = 3
LOG_LEVELS_LIST = ["NOTSET", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]

# Per-logger options (storage schema v3).
DEFAULT_COUNT_LEVEL = "WARNING"
ALERT_DISABLED = 0
DEFAULT_ALERT_LEVEL = "ERROR"
MAX_AUDIT = 5


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


def record_audit(
    info: dict, old_level: str, new_level: str, source: str, max_audit: int = MAX_AUDIT
) -> None:
    """Prepend a level-change entry to a managed logger's audit trail in place."""
    audit = list(info.get("audit", []))
    audit.insert(
        0,
        {
            "ts": time.time(),
            "source": source,
            "old_level": old_level,
            "new_level": new_level,
        },
    )
    del audit[max_audit:]
    info["audit"] = audit
