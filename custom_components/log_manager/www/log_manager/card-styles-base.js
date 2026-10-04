// Shadow-DOM styles — base layout, header and logger-row surfaces.
export const CARD_STYLES_BASE = `      <style>
        ha-card { padding: 16px 16px 8px 16px; display: flex; flex-direction: column; }
        .header { margin-bottom: 12px; }
        .section-title { font-size: 18px; font-weight: 500; margin: 0; }
        .header { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
        .set-all-row {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-left: auto;
          font-size: 12px;
          color: var(--secondary-text-color);
        }
        select.set-all-level {
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          font-size: 12px;
          cursor: pointer;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }
        select.set-all-level:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .active-list { margin-bottom: 0; display: flex; flex-direction: column; gap: 8px; }

        .log-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          padding: 10px 12px;
          border-radius: 8px;
          border: 1px solid var(--divider-color);
          transition: box-shadow 0.2s ease, border-color 0.2s ease;
          cursor: pointer;
        }

        .log-row:hover {
          border-color: rgba(var(--rgb-primary-text-color), 0.15);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        }

        .log-group-header {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          font-weight: 500;
          color: var(--secondary-text-color);
          cursor: pointer;
          user-select: none;
          padding: 4px 10px;
          border-radius: 6px;
          background: rgba(var(--rgb-primary-text-color), 0.04);
          transition: background 0.15s ease, color 0.15s ease;
        }
        .log-group-header:hover {
          background: rgba(var(--rgb-primary-text-color), 0.09);
          color: var(--primary-text-color);
        }
        .log-group-name { font-weight: 600; letter-spacing: 0.2px; }
        .log-group-count { opacity: 0.75; }
        .log-group-chevron { display: inline-block; width: 16px; }
        .row-group-chevron {
          background: none;
          border: none;
          color: var(--secondary-text-color);
          cursor: pointer;
          padding: 0 4px 0 0;
          font-size: 10px;
          line-height: 1;
        }
        .row-group-chevron:hover { color: var(--primary-text-color); }

        .action-btn {
          opacity: 0.25;
          transition: opacity 0.2s ease-in-out;
        }

        .log-row:hover .action-btn {
          opacity: 1;
        }

        .log-name {
          flex: 1 1 0;
          font-size: 14px;
          word-break: break-word;
          margin-right: 12px;
          line-height: 1.3;
          min-width: 120px;
          cursor: pointer;
        }

        .log-name.unavailable { opacity: 0.6; color: var(--secondary-text-color); }

        .log-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

        .counter-badges { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .log-controls-wrapper { display: flex; align-items: center; gap: 8px; flex-shrink: 0; min-width: 0; }

        .counter-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 24px;
          height: 22px;
          border-radius: 11px;
          font-size: 11px;
          font-weight: 600;
          padding: 0 7px;
          cursor: pointer;
          transition: filter 0.15s ease, transform 0.15s ease;
          user-select: none;
        }

        .counter-badge:hover {
          filter: brightness(1.25);
          transform: scale(1.05);
        }

        .counter-badge:active {
          transform: scale(0.97);
        }

        .counter-badge.warning-badge {
          background: rgba(255, 152, 0, 0.18);
          color: #ff9800;
        }

        .counter-badge.error-badge {
          background: rgba(244, 67, 54, 0.18);
          color: var(--error-color);
        }

        .counter-badge.recording-count-badge {
          background: rgba(76, 175, 80, 0.18);
          color: #4caf50;
        }

        .log-panel {
          width: 100%;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--divider-color);
          word-break: normal;
          overflow-wrap: break-word;
        }

        .log-entries {
          display: flex;
          flex-direction: column;
          gap: 4px;
          max-height: 200px;
          overflow-y: auto;
          user-select: none;
          -webkit-user-select: none;
        }

        .log-entry {
          display: flex;
          align-items: baseline;
          gap: 6px;
          font-size: 12px;
          line-height: 1.4;
          padding: 4px 6px;
          border-radius: 4px;
          cursor: pointer;
          word-break: normal;
          overflow-wrap: break-word;
          user-select: none;
          -webkit-user-select: none;
          -webkit-user-drag: none;
        }

        .log-entry:hover {
          filter: brightness(1.12);
        }

        .log-entry.copied {
          outline: 1px solid var(--primary-color);
        }

        .log-entry-empty {
          font-size: 12px;
          color: var(--secondary-text-color);
          font-style: italic;
          padding: 4px 0;
        }

        .log-disclaimer {
          font-size: 11px;
          color: var(--secondary-text-color);
          font-style: italic;
          margin-top: 6px;
          opacity: 0.8;
        }

        /* Explains why a verbose count level captures nothing. */
        .count-warning {
          font-size: 11px;
          line-height: 1.35;
          margin-bottom: 6px;
        }

        /* Makes the modifier-key multi-select model discoverable. */
        .selection-hint {
          font-size: 11px;
          color: var(--secondary-text-color);
          opacity: 0.8;
          margin-top: 6px;
        }

        .log-time {
          color: var(--secondary-text-color);
          font-family: monospace;
          font-size: 11px;
          flex-shrink: 0;
        }

        .log-level {
          font-size: 10px;
          font-weight: 600;
          padding: 1px 5px;
          border-radius: 3px;
          flex-shrink: 0;
          text-transform: uppercase;
        }

        .log-level-warning {
          background: rgba(255, 152, 0, 0.18);
          color: #ff9800;
        }

        .log-level-error {
          background: rgba(244, 67, 54, 0.18);
          color: var(--error-color);
        }

        .log-level-info {
          background: rgba(76, 175, 80, 0.18);
          color: #4caf50;
        }

        .log-level-debug {
          background: rgba(3, 169, 244, 0.18);
          color: #03a9f4;
        }

        /* Per-logger controls share one wrapping row. */
        .panel-controls-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 12px;
          margin-bottom: 6px;
          min-height: 22px;
        }

        .alert-row {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: var(--secondary-text-color);
        }

        select.alert-level-select,
        input.alert-threshold-input {
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          font-size: 11px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }

        select.alert-level-select {
          cursor: pointer;
        }

        input.alert-threshold-input {
          width: 72px;
          padding-right: 0;
        }

        select.alert-level-select:disabled,
        input.alert-threshold-input:disabled {
          opacity: 0.5;
          cursor: default;
        }

        .audit-line {
          font-size: 11px;
          color: var(--secondary-text-color);
          margin-bottom: 6px;
        }

        .audit-label {
          font-weight: 600;
        }

        .log-msg {
          color: var(--primary-text-color);
          overflow-wrap: break-word;
          word-break: normal;
          flex: 1 1 0;
          min-width: 0;
        }

        .log-src {
          color: var(--secondary-text-color);
          font-size: 10px;
          font-family: monospace;
          flex-shrink: 0;
        }

        .reset-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-top: 8px;
          padding: 4px 10px;
          font-size: 12px;
          background: none;
          color: var(--secondary-text-color);
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          cursor: pointer;
          transition: color 0.2s, border-color 0.2s;
        }

        .reset-btn:hover {
          color: var(--primary-text-color);
          border-color: var(--primary-text-color);
        }

        .reset-btn:disabled {
          opacity: 0.7;
          color: var(--secondary-text-color);
          border-color: var(--divider-color);
          cursor: default;
        }

        .reset-btn:disabled:hover {
          color: var(--secondary-text-color);
          border-color: var(--divider-color);
        }

        .copy-panel-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          margin-top: 8px;
          padding: 4px 10px;
          font-size: 12px;
          background: none;
          color: var(--secondary-text-color);
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          cursor: pointer;
          transition: color 0.2s, border-color 0.2s;
        }

        .copy-panel-btn:hover:not(:disabled) {
          color: var(--primary-text-color);
          border-color: var(--primary-text-color);
        }

        .copy-panel-btn:disabled {
          opacity: 0.7;
          cursor: default;
        }

select.level-select {
          padding: 4px 8px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          font-size: 13px;
          cursor: pointer;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }

        select.level-select:hover {
          border-color: rgba(var(--rgb-primary-text-color), 0.3);
        }

        select.level-select:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        select.level-select:disabled:hover {
          border-color: var(--divider-color);
        }

        .add-section-wrapper {
          max-height: 0;
          opacity: 0;
          overflow: hidden;
          transition: max-height 0.3s ease-in-out, opacity 0.3s ease-in-out;
          margin: 0;
        }

        .add-section-wrapper.visible {
          max-height: 500px;
          opacity: 1;
          margin: 8px 0;
        }

        .add-section {
          background: rgba(var(--rgb-primary-text-color), 0.03);
          padding: 16px;
          border-radius: 8px;
          border: 1px solid var(--divider-color);
        }

        .add-section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .add-section-title {
          font-weight: 500;
          font-size: 14px;
          color: var(--secondary-text-color);
        }

        .field-label {
          display: block;
          font-size: 12px;
          font-weight: 500;
          color: var(--secondary-text-color);
          margin-bottom: 4px;
          margin-top: 12px;
        }

        .input-wrapper { position: relative; margin-bottom: 12px; margin-top: 0; }

        input[type="text"] {
          width: calc(100% - 18px);
          padding: 8px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-family: inherit;
        }

        .options-list {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          max-height: 200px;
          overflow-y: auto;
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
          border-top: none;
          border-radius: 0 0 4px 4px;
          z-index: 999;
          display: none;
          box-shadow: 0 4px 8px rgba(0,0,0,0.2);
        }

        .option-item {
          padding: 4px 8px;
          cursor: pointer;
          color: var(--primary-text-color);
          font-size: 13px;
          word-break: break-all;
        }

        .option-item:hover { background: rgba(var(--rgb-primary-text-color), 0.05); }
        /* Highlight marks a curated namespace without recolouring the label,
           so fuzzy-match tinting stays readable on highlighted rows. */
        .option-item.highlight { font-weight: bold; background: rgba(var(--rgb-primary-color), 0.06); }
        .fuzzy-hit {
          font-weight: 700;
          color: var(--primary-color);
          background: rgba(var(--rgb-primary-color), 0.18);
          text-decoration: underline;
          border-radius: 2px;
        }
        .option-star { color: var(--primary-color); }

        .friendly-input { margin-bottom: 0; }

        button {
          padding: 8px 16px;
          background: var(--primary-color);
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 500;
        }

        button:disabled { background: var(--disabled-text-color); cursor: not-allowed; }

        .icon-btn {
          background: none;
          color: var(--error-color);
          cursor: pointer;
          padding: 4px;
          display: flex;
          align-items: center;
          border: none;
          transition: opacity 0.2s, color 0.2s;
        }

        .icon-btn:hover { opacity: 0.8; }
        .edit-btn { color: var(--primary-text-color); }
        .edit-btn:hover { color: var(--primary-color); }
        /* History is an informational action, not a destructive one: keep it
           off the error colour the shared icon-btn rule applies. */
        .history-btn { color: var(--secondary-text-color); }
        .history-btn:hover { color: var(--primary-color); }

        .card-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-top: 1px solid var(--divider-color);
          padding-top: 8px;
          margin-top: 12px;
        }

        .toggle-add-btn {
          background: none;
          color: var(--secondary-text-color);
          padding: 8px;
          display: flex;
          align-items: center;
          gap: 8px;
          border-radius: 4px;
          transition: background 0.2s;
          border: none;
          cursor: pointer;
          width: auto;
        }

        .toggle-add-btn:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
          color: var(--primary-text-color);
        }

        /* Disabled ghost buttons dim like the other disabled controls; the
           background override beats the generic button:disabled grey fill. */
        .toggle-add-btn:disabled {
          background: none;
          opacity: 0.5;
          cursor: not-allowed;
        }

        .toggle-add-btn:disabled:hover {
          background: none;
        }

        /* The record button's label stacks one line per block span; a flex
           container ignores <br>, so each line is its own block. */
        .record-text-line {
          display: block;
          line-height: 1.2;
        }
        .record-text-count {
          font-size: 11px;
          color: var(--secondary-text-color);
        }

`;
