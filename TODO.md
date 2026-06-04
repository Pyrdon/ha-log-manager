# TODO

## Done

- **Error/warning counters per logger** — Show warning and error counts as badges on each managed logger row in the card. Backend uses a custom `logging.Handler` to count records at WARNING+ and ERROR+ levels per managed logger. Exposed via `log_manager/get_stats` websocket command. Card fetches counters on each state update (throttled to 5 s) and renders colored badges with tooltips. A `reset_counters` service allows clearing counts.

- **Recent log entries in expand panel** — Click a badge to expand an inline log panel below the row showing the last 10 WARNING+ entries for that logger. Each entry shows timestamp, level badge, message, and source file. A "Reset counters" button inside the panel clears counts and entries. Backend stores `recent_logs` (max 10) alongside counters.

- **Visual polish** — Rows use card-like styling with rounded corners, subtle background, and hover shadow. Level select dropdowns are pill-shaped with monospace font and color-coded by current level (DEBUG=blue, INFO=green, WARNING=amber, ERROR=red, CRITICAL=purple). Action buttons always visible at low opacity, full on hover. Badges use ⚠/✕ icons with hover scale effect.

## Planned

- **Configurable buffer size** — Allow card YAML config option `max_entries` to control how many recent log entries are stored per logger (default 10).

- **Start/stop log collection with download** — Per-logger "Start collecting" button that buffers all log entries at the logger's configured level (not just WARNING+). "Stop and download" exports the buffer as a text file. Useful for capturing DEBUG-level diagnostics on demand.

- **Logger grouping by prefix** — Group managed loggers by namespace prefix (e.g., `homeassistant.core.*`, `custom_components.hacs.*`) with collapsible sections. Reduces visual clutter when many loggers are active.

- **Quick-set with auto-revert** — One-click button to set a logger to DEBUG for a configurable duration (default 5 minutes), then auto-revert to its previous level. Common debugging pattern that currently requires manual cleanup.

- **Bulk actions** — "Set all to WARNING", "Reset all to NOTSET", and "Remove all" buttons for managing multiple loggers at once.