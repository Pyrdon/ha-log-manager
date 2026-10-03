// Static shadow-DOM skeleton and dialog markup for the Log Manager card.
// Dynamic/state-interpolated fragments stay in their concern modules.
// The exact whitespace of the original inline template is preserved so the
// concatenated shadowRoot.innerHTML is byte-identical.
export const CARD_MARKUP = `      <ha-card>
        <div class="header">
          <div class="section-title">Loggers</div>
          <label class="set-all-row" title="Set the level of every managed logger at once. Core-pinned loggers are left untouched.">
            Set all:
            <select id="set-all-level" class="set-all-level"></select>
            <button type="button" id="set-all-apply" class="set-all-apply" disabled>Apply</button>
          </label>
        </div>

        <div id="active-list" class="active-list"></div>

        <div class="add-section-wrapper" id="add-section-wrapper">
          <div class="add-section">
            <div class="add-section-header">
              <div class="add-section-title">Configure logger</div>
              <button id="add-btn" disabled>Save</button>
            </div>

            <label class="field-label" for="friendly-name-input"
                   title="Display name shown in the card.">Friendly name</label>
            <input type="text" id="friendly-name-input" class="friendly-input"
                   placeholder="Optional display name" />

            <label class="field-label" for="path-input"
                   title="Python logger path to manage.">Logger path</label>
            <div class="input-wrapper">
              <input type="text" id="path-input" placeholder="Search or enter logger path..." />
              <div id="options-list" class="options-list"></div>
            </div>
          </div>
        </div>

        <div class="card-actions">
          <button class="toggle-add-btn" id="toggle-add-btn" title="Add a new logger to manage">
            <ha-icon icon="mdi:plus" id="toggle-icon"></ha-icon>
            <span id="toggle-text">Add logger</span>
          </button>

          <button class="toggle-add-btn" id="record-btn" title="Record log events for export">
            <ha-icon icon="mdi:record-circle" id="record-icon"></ha-icon>
            <span id="record-text">Record</span>
          </button>

          <button class="toggle-add-btn" id="discard-record-btn" style="display: none; color: var(--error-color);" title="Discard the recorded logs">
            <ha-icon icon="mdi:trash-can-outline"></ha-icon>
          </button>

          <button class="toggle-add-btn" id="live-btn" style="display: none;" title="View live log entries">
            <ha-icon icon="mdi:eye-outline" id="live-icon"></ha-icon>
            <span id="live-text">Live</span>
          </button>

          <button class="toggle-add-btn" onclick="window.location.href='/config/logs'" title="Open Home Assistant core log viewer">
            <ha-icon icon="mdi:text-box-search-outline"></ha-icon>
            View core logs
          </button>
        </div>
      </ha-card>

      <div class="delete-dialog-overlay" id="delete-dialog">
        <div class="delete-dialog-box">
          <div class="delete-dialog-title">Remove logger</div>
          <div class="delete-dialog-message"></div>
          <div class="delete-dialog-actions">
            <button class="btn-cancel" id="delete-cancel-btn">Cancel</button>
            <button class="btn-danger" id="delete-confirm-btn">Remove</button>
          </div>
        </div>
      </div>

      <div class="dialog-overlay" id="recording-setup-dialog">
        <div class="dialog-box recording-setup-box">
          <div class="dialog-title">Select loggers to record</div>
          <div class="profile-row" id="recording-profile-row">
            <label class="profile-label" for="recording-profile-select">Profile:</label>
            <select id="recording-profile-select" title="Load a saved recording profile"></select>
            <button class="btn-secondary profile-btn" id="recording-profile-save" title="Save the current selection as a profile">Save profile</button>
            <button class="btn-secondary profile-btn" id="recording-profile-delete" title="Delete the selected profile" disabled>✕</button>
          </div>
          <div class="profile-save-row" id="recording-profile-save-row" style="display: none;">
            <input type="text" id="recording-profile-name" placeholder="Profile name" maxlength="64">
            <button class="btn-primary profile-btn" id="recording-profile-confirm">Save</button>
            <button class="btn-secondary profile-btn" id="recording-profile-abort">Cancel</button>
          </div>
          <div id="logger-checklist" class="logger-checklist"></div>
          <div class="dialog-actions">
            <button class="btn-secondary" id="recording-setup-cancel">Cancel</button>
            <button class="btn-primary" id="recording-setup-start" disabled>Start recording</button>
          </div>
        </div>
      </div>

      <div class="dialog-overlay" id="history-dialog">
        <div class="dialog-box history-dialog-box">
          <div class="dialog-title">Level-change history</div>
          <div id="history-logger-name" style="color: var(--secondary-text-color); font-size: 13px; word-break: break-all;"></div>
          <table class="history-table">
            <thead>
              <tr><th>When</th><th>Source</th><th>From</th><th>To</th></tr>
            </thead>
            <tbody id="history-table-body"></tbody>
          </table>
          <div class="dialog-actions">
            <button class="btn-secondary" id="history-close-btn">Close</button>
          </div>
        </div>
      </div>

      <div class="dialog-overlay" id="recording-live-dialog">
        <div class="dialog-box dialog-box-wide">
          <div class="dialog-title" id="live-dialog-title">Live recording</div>
          <div id="live-top-bar" style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <span class="recording-dot" id="live-status-dot"></span>
            <span id="live-status-text" style="font-weight: 500;">Recording</span>
            <span id="live-timer" style="font-family: monospace; font-size: 14px;"></span>
            <span style="flex: 1;"></span>
            <button class="btn-secondary" id="live-pause-btn" title="Pause viewer update" style="padding: 4px 12px; font-size: 13px;">Pause</button>
            <button class="btn-danger" id="live-stop-btn" title="Stop recording" style="padding: 4px 12px; font-size: 13px;">Stop</button>
          </div>

          <label class="dedup-row" title="Fold runs of identical entries into one expandable row">
            <input type="checkbox" id="recording-dedup-toggle"> Group identical entries
          </label>
          <div id="live-filter-bar" style="display: flex; gap: 8px; margin-bottom: 8px;">
            <select id="live-logger-filter" title="Filter the live view by logger" style="flex: 1; padding: 4px 6px; border-radius: 4px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); font-size: 13px;"></select>
            <select id="live-level-filter" title="Filter the live view by minimum level" style="padding: 4px 6px; border-radius: 4px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); font-size: 13px;">
              <option value="ALL">All levels</option>
              <option value="DEBUG">DEBUG+</option>
              <option value="INFO">INFO+</option>
              <option value="WARNING">WARNING+</option>
              <option value="ERROR">ERROR+</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
          </div>

          <div class="selection-hint" style="margin-bottom: 6px;" title="Plain click selects one entry; Ctrl/Cmd-click or drag extends the selection.">Click to select &middot; Ctrl/Cmd-click or drag to select more</div>

          <div id="live-log-preview" class="log-preview"></div>

          <div id="live-summary" class="recording-summary" style="margin-top: 8px; margin-bottom: 0;"></div>

          <div class="dialog-actions" id="live-export-actions">
            <button class="btn-secondary" id="live-clear-btn" title="Clear all captured entries without stopping the recording">Clear</button>
            <button class="btn-secondary" id="live-save-plain-btn" disabled>Save as .log</button>
            <button class="btn-secondary" id="live-save-jsonl-btn" disabled title="JSON Lines — one JSON object per line (timestamp, level, logger, message, source); easy to process programmatically.">Save as JSONL</button>
            <button class="btn-secondary" id="live-copy-btn" disabled style="margin-right: auto;">Copy to clipboard</button>
            <button class="btn-danger" id="live-discard-btn" style="display: none;">Discard recording</button>
            <button class="btn-secondary" id="live-close-btn" title="Close this window; the recording continues in the background.">Close &amp; keep recording</button>
          </div>
        </div>
      </div>

      <div class="context-menu" id="context-menu" style="display: none;"></div>`;
