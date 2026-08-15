# TODO

## Planned

- **Configurable buffer size** — Allow card YAML config option `max_entries` to control how many recent log entries are stored per logger (default 10).

- **Logger grouping by prefix** — Group managed loggers by namespace prefix (e.g., `homeassistant.core.*`, `custom_components.hacs.*`) with collapsible sections. Reduces visual clutter when many loggers are active.

- **Quick-set with auto-revert** — One-click button to set a logger to DEBUG for a configurable duration (default 5 minutes), then auto-revert to its previous level. Common debugging pattern that currently requires manual cleanup.

- **Bulk actions** — "Set all to WARNING", "Reset all to NOTSET", and "Remove all" buttons for managing multiple loggers at once.

- **Recording services** — Expose `start_recording` / `stop_recording` as scriptable HA services so automations can capture log bursts on trigger (currently frontend/websocket-only).

- **Counter sensors** — Expose per-logger warning/error counts as HA sensor entities so users can alert and history-track them outside the card.

- **Error-threshold alerts** — Optionally fire an HA notification when a managed logger's error count crosses a configurable threshold.
