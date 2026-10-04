// Shadow-DOM styles — recording setup, live view and results surfaces.
export const CARD_STYLES_RECORDING = `        /* Recording setup needs room for exclusions without a cramped scrollbar. */
        .dialog-box.recording-setup-box {
          max-width: 580px;
          max-height: 85vh;
          overflow-y: auto;
        }

        .history-dialog-box {
          max-width: 520px;
          max-height: 85vh;
          overflow-y: auto;
        }

        .history-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          margin-top: 8px;
        }

        .history-table th,
        .history-table td {
          text-align: left;
          padding: 4px 8px;
          border-bottom: 1px solid var(--divider-color);
        }

        .history-table th {
          color: var(--secondary-text-color);
          font-weight: 600;
        }

        .dialog-title {
          font-size: 16px;
          font-weight: 500;
          margin-bottom: 8px;
        }

        .dialog-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 16px;
        }

        .dialog-actions button {
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
        }

        .btn-primary {
          background: var(--primary-color);
          color: white;
          border: none;
        }

        .btn-primary:hover {
          filter: brightness(1.1);
        }

        .btn-primary:disabled {
          background: var(--disabled-text-color);
          cursor: not-allowed;
          filter: none;
        }

        .btn-secondary {
          background: none;
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
        }

        .btn-secondary:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
        }

        /* The live Pause control is green while running; once paused it turns
           orange to signal the viewer is frozen on a stale snapshot. */
        #live-pause-btn {
          color: #4caf50;
          border-color: #4caf50;
        }

        #live-pause-btn.paused {
          color: #ff9800;
          border-color: #ff9800;
        }

        .btn-secondary:disabled,
        .btn-secondary:disabled:hover {
          opacity: 0.5;
          cursor: not-allowed;
          background: none;
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
        }

        .logger-checklist {
          margin: 12px 0;
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          padding: 4px;
        }

        .profile-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 8px;
          font-size: 13px;
        }

        .profile-label {
          color: var(--secondary-text-color);
          flex-shrink: 0;
        }

        #recording-profile-select {
          flex: 1;
          min-width: 0;
          padding: 4px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-size: 13px;
        }

        .profile-btn {
          padding: 4px 10px;
          font-size: 12px;
          flex-shrink: 0;
        }

        .dedup-row {
          display: flex;
          align-items: center;
          gap: 6px;
          margin: 8px 0;
          font-size: 13px;
          color: var(--secondary-text-color);
        }

        /* Searchable checkbox multi-select logger filter. */
        .logger-filter-btn {
          width: 100%;
          padding: 4px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-size: 13px;
          text-align: left;
          cursor: pointer;
        }

        .logger-filter-panel {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          z-index: 20;
          margin-top: 2px;
          padding: 6px;
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
        }

        .logger-filter-search {
          width: calc(100% - 12px);
          margin-bottom: 4px;
          padding: 4px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-size: 12px;
        }

        .logger-filter-list {
          max-height: 200px;
          overflow-y: auto;
        }

        .logger-filter-item {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 3px 4px;
          font-size: 12px;
          cursor: pointer;
          word-break: break-all;
        }

        .logger-filter-item:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
        }

        .logger-filter-item input[type="checkbox"] {
          margin: 0;
          cursor: pointer;
          flex-shrink: 0;
        }

        .profile-save-row {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }

        #recording-profile-name {
          flex: 1;
          min-width: 0;
          padding: 4px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-size: 13px;
        }

        .checklist-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          font-size: 13px;
          border-radius: 4px;
          cursor: pointer;
        }

        .checklist-item:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
        }

        .checklist-item input[type="checkbox"] {
          margin: 0;
          cursor: pointer;
        }

        .checklist-item .logger-label {
          flex: 1;
          word-break: break-all;
          line-height: 1.3;
        }

        .checklist-item .logger-level {
          font-size: 11px;
          opacity: 0.7;
          flex-shrink: 0;
        }

        .recording-level-select {
          font-size: 11px;
          padding: 2px 4px;
          border-radius: 3px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          flex-shrink: 0;
          max-width: 90px;
        }

        .recording-level-select:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .checklist-item {
          flex-wrap: wrap;
        }

        .exclude-toggle {
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 3px;
          border: 1px solid var(--divider-color);
          background: none;
          color: var(--secondary-text-color);
          cursor: pointer;
          flex-shrink: 0;
        }

        .exclude-toggle:hover:not(:disabled) {
          color: var(--primary-text-color);
          border-color: var(--primary-text-color);
        }

        .exclude-toggle:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .exclude-area {
          flex-basis: 100%;
          margin-top: 4px;
          padding-left: 26px;
        }

        /* Always-visible exclusion line: sits on its own full-width row below
           the logger/verbosity controls, independent of the collapsible editor.
           Collapses to nothing when there are no chips. */
        .exclude-chips {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          flex-wrap: wrap;
          gap: 4px;
          flex-basis: 100%;
          margin-top: 4px;
        }

        .exclude-chips:empty {
          display: none;
        }

        .exclude-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          padding: 1px 4px 1px 8px;
          border-radius: 10px;
          background: rgba(var(--rgb-primary-text-color), 0.08);
          color: var(--primary-text-color);
        }

        .exclude-chip-remove {
          border: none;
          background: none;
          color: var(--secondary-text-color);
          cursor: pointer;
          font-size: 11px;
          padding: 0 2px;
        }

        .exclude-chip-remove:hover {
          color: var(--error-color);
        }

        .exclude-input-wrapper { position: relative; }

        .exclude-options {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          z-index: 10;
        }

        .exclude-input {
          font-size: 12px;
          padding: 3px 6px;
          border-radius: 3px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          width: 100%;
          box-sizing: border-box;
        }

        .exclude-input.exclude-invalid {
          border-color: var(--error-color);
        }

        .select-all-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          font-size: 13px;
          font-weight: 500;
          border-bottom: 1px solid var(--divider-color);
          margin-bottom: 4px;
          cursor: pointer;
        }

        .select-all-row input[type="checkbox"] {
          margin: 0;
          cursor: pointer;
        }

        .recording-summary {
          font-size: 14px;
          color: var(--secondary-text-color);
          margin-bottom: 12px;
        }

        .log-preview {
          max-height: 420px;
          overflow-y: auto;
          /* Opaque, and matching the sticky header, so rows scrolled under the
             header can never show through or peek above it. */
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          padding: 0 0 4px;
          font-family: monospace;
          font-size: 12px;
          line-height: 1.5;
          user-select: none;
          -webkit-user-select: none;
        }

        .log-preview-line {
          display: flex;
          gap: 8px;
          padding: 2px 10px;
          user-select: none;
          -webkit-user-select: none;
        }

        .log-preview-line:hover {
          filter: brightness(1.2);
        }

        .log-preview-group {
          display: flex;
          gap: 8px;
          padding: 2px 10px;
          user-select: none;
          -webkit-user-select: none;
        }

        .log-preview-group:hover {
          filter: brightness(1.2);
        }

        .log-preview-group .idx-col {
          width: auto;
          min-width: 44px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }

        .dedup-toggle {
          background: none;
          border: none;
          color: var(--secondary-text-color);
          cursor: pointer;
          padding: 0;
          font-size: 10px;
          line-height: 1;
        }

        .dedup-toggle:hover {
          color: var(--primary-text-color);
        }

        .dedup-count {
          display: inline-block;
          margin-left: 2px;
          padding: 0 7px;
          border-radius: 11px;
          font-size: 11px;
          font-weight: 600;
          background: rgba(var(--rgb-primary-text-color), 0.12);
        }

        .log-preview-group-items {
          display: flex;
          flex-direction: column;
        }

        .log-preview-group-item {
          display: flex;
          gap: 8px;
          padding: 2px 10px;
          opacity: 0.4;
          user-select: none;
          -webkit-user-select: none;
          -webkit-user-drag: none;
        }

        .log-preview-group-item:hover {
          opacity: 1;
        }

        .log-preview-group-item + .log-preview-group-item {
          border-top: 1px solid var(--divider-color);
        }

        .results-summary {
          display: flex;
          flex-direction: column;
          gap: 2px;
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--divider-color);
          font-size: 13px;
        }

        /* Summary/status text is informational: keep it out of text selection. */
        #live-summary,
        #live-status-text,
        #results-summary {
          user-select: none;
          -webkit-user-select: none;
        }

        .summary-recorded-line {
          color: var(--secondary-text-color);
          margin-bottom: 6px;
        }

        .summary-title {
          font-weight: 600;
          font-size: 13px;
          margin-bottom: 4px;
        }

        .summary-section-title {
          font-weight: 600;
          color: var(--secondary-text-color);
          font-size: 12px;
          margin-top: 8px;
          margin-bottom: 2px;
        }

        .summary-sev-line {
          color: var(--secondary-text-color);
        }

        .summary-row {
          display: flex;
          align-items: baseline;
          gap: 8px;
          padding: 1px 0;
        }

        .summary-label {
          color: var(--secondary-text-color);
          min-width: 140px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .summary-message {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .summary-count {
          margin-left: auto;
          color: var(--secondary-text-color);
          font-variant-numeric: tabular-nums;
        }

        .results-summary-more {
          color: var(--secondary-text-color);
          font-style: italic;
        }

        .log-preview-header {
          display: flex;
          gap: 8px;
          padding: 4px 10px;
          font-weight: 600;
          color: var(--secondary-text-color);
          position: sticky;
          top: 0;
          z-index: 1;
          background: var(--card-background-color);
          border-bottom: 1px solid var(--divider-color);
          user-select: none;
          -webkit-user-select: none;
        }

        .log-preview-col {
          flex-shrink: 0;
        }

        .log-preview-col.idx-col {
          width: var(--col-idx, 44px);
          color: var(--secondary-text-color);
        }

        .log-preview-col.level-col {
          width: var(--col-level, 64px);
          font-weight: 600;
        }

        .log-preview-col.time-col {
          width: var(--col-time, 80px);
        }

        .log-preview-col.logger-col {
          width: var(--col-logger, 180px);
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .logger-child {
          color: var(--primary-text-color);
          opacity: 0.75;
          font-size: 0.9em;
        }

        .log-preview-header .resizable-col {
          position: relative;
          cursor: col-resize;
        }

        .log-preview-header .resizable-col::after {
          content: "";
          position: absolute;
          right: -3px;
          top: 0;
          bottom: 0;
          width: 6px;
          border-right: 1px solid var(--divider-color);
        }

`;
