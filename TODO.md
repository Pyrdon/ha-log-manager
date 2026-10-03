# TODO

## Planned

- **Configurable buffer size** — Allow card YAML config option `max_entries` to control how many recent log entries are stored per logger (default 10).

- **Quick-set with auto-revert** — One-click button to set a logger to DEBUG for a configurable duration (default 5 minutes), then auto-revert to its previous level. Common debugging pattern that currently requires manual cleanup.

- **Bulk reset and remove** — "Reset all counters" and "Remove all loggers" actions for managing multiple loggers at once. (Bulk level setting is delivered by the card's "Set all" control.)

- **Remove dead preview copy handler** — The preview's `user-select: none` styling makes `_handlePreviewCopy` and its `copy` listener unreachable in real use; only the direct unit test invokes them. Remove both and that test.
