# TODO

## Planned

- **Configurable buffer size** — Allow card YAML config option `max_entries` to control how many recent log entries are stored per logger (default 10).

- **Quick-set with auto-revert** — One-click button to set a logger to DEBUG for a configurable duration (default 5 minutes), then auto-revert to its previous level. Common debugging pattern that currently requires manual cleanup.

- **Bulk reset and remove** — "Reset all counters" and "Remove all loggers" actions for managing multiple loggers at once. (Bulk level setting is delivered by the card's "Set all" control.)

- **Split the card JS into modules** — `log_manager_card.js` is over the 1000-line hard gate (card markup/CSS, logger list, selection, recording session, live view, formatters). Extract cohesive concerns into sibling ES modules under `www/log_manager/`; the static path already serves the directory. Behaviour-neutral; needs its own review.

- **Remove dead preview copy handler** — The preview's `user-select: none` styling makes `_handlePreviewCopy` and its `copy` listener unreachable in real use; only the direct unit test invokes them. Remove both and that test.
