from collections.abc import Iterable
import logging
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


def effective_level_source(logger_name: str) -> tuple[str, str | None]:
    """Return the effective level and the ancestor that defines it for a logger.

    Walks the dotted hierarchy from ``logger_name`` upward and returns the first
    explicit level found. The source is the ancestor that carries the level, or
    None when the logger itself carries it. ``"root"`` means the root logger,
    including the fallback when no ancestor carries an explicit level.
    """
    manager = logging.Logger.manager
    existing = manager.loggerDict.get(logger_name)
    if isinstance(existing, logging.Logger):
        node: logging.Logger | None = existing
    else:
        # Only creates the Logger object when nothing was ever registered
        # under this name; managed loggers practically always exist already.
        node = logging.getLogger(logger_name)
    while node is not None:
        if node.level != logging.NOTSET:
            level_name = logging.getLevelName(node.level)
            source = None if node.name == logger_name else node.name
            return level_name, source
        node = node.parent
    return "WARNING", "root"


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
