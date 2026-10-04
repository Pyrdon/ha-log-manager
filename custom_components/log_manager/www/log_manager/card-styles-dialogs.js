// Shadow-DOM styles — delete-confirm and alert/audit dialog surfaces.
export const CARD_STYLES_DIALOGS = `        /* Styled delete confirmation dialog overlay. */
        .delete-dialog-overlay {
          display: none;
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 1000000001;
          align-items: center;
          justify-content: center;
        }

        .delete-dialog-box {
          background: var(--card-background-color);
          border-radius: 12px;
          padding: 24px;
          max-width: 400px;
          width: 90%;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }

        .delete-dialog-title {
          font-size: 16px;
          font-weight: 500;
          margin-bottom: 8px;
        }

        .delete-dialog-message {
          font-size: 14px;
          color: var(--secondary-text-color);
          margin-bottom: 20px;
        }

        .delete-dialog-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }

        .delete-dialog-actions button {
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
        }

        .btn-cancel {
          background: none;
          color: var(--primary-text-color);
          border: 1px solid var(--divider-color);
        }

        .btn-cancel:hover {
          background: rgba(var(--rgb-primary-text-color), 0.05);
        }

        .btn-danger {
          background: var(--error-color);
          color: white;
          border: none;
        }

        .btn-danger:hover {
          filter: brightness(1.1);
        }

        /* Neutral confirm dialog: same overlay chrome, non-destructive actions. */
        .confirm-dialog-overlay {
          display: none;
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 1000000001;
          align-items: center;
          justify-content: center;
        }
        .confirm-dialog-box {
          background: var(--card-background-color);
          border-radius: 12px;
          padding: 24px;
          max-width: 400px;
          width: 90%;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }
        .confirm-dialog-message {
          font-size: 14px;
          color: var(--secondary-text-color);
          margin-bottom: 20px;
        }

        /* Recording UI styles */
        .recording-active {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: var(--error-color);
          font-weight: 500;
        }

        .recording-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--error-color);
          animation: recording-pulse 1.5s ease-in-out infinite;
        }

        @keyframes recording-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.7); }
        }

        .recording-timer {
          font-family: monospace;
          font-size: 14px;
        }

        .recording-tag {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--error-color);
          color: white;
          font-size: 10px;
          font-weight: 700;
          margin-right: 4px;
          animation: recording-pulse 1.5s ease-in-out infinite;
          flex-shrink: 0;
          vertical-align: middle;
        }

        .pinned-tag {
          display: inline-flex;
          align-items: center;
          padding: 1px 7px;
          border-radius: 9px;
          border: 1px solid var(--divider-color);
          color: var(--secondary-text-color);
          font-size: 10px;
          font-weight: 600;
          margin-right: 4px;
          flex-shrink: 0;
          vertical-align: middle;
        }

        .effective-line {
          font-size: 11px;
          color: var(--secondary-text-color);
          margin-top: 2px;
        }

        /* Only the level token is tinted by severity (inline span); the
           "Raised to" label stays neutral. */
        .raised-line {
          font-size: 11px;
          color: var(--secondary-text-color);
          margin-top: 2px;
          font-weight: 600;
        }

        .btn-record {
          color: var(--error-color) !important;
        }

        .btn-record:hover {
          background: rgba(244, 67, 54, 0.08) !important;
        }

        .btn-view-recording {
          color: var(--primary-color) !important;
          font-weight: 600;
        }

        .btn-view-recording:hover {
          background: rgba(var(--rgb-primary-color), 0.08) !important;
        }

        .context-menu {
          position: fixed;
          z-index: 1000000000;
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
          padding: 4px;
          min-width: 160px;
        }

        .context-menu button {
          display: block;
          width: 100%;
          text-align: left;
          background: none;
          border: none;
          color: var(--primary-text-color);
          padding: 6px 10px;
          font-size: 13px;
          border-radius: 4px;
          cursor: pointer;
        }

        .context-menu button:hover:not(:disabled) {
          background: rgba(var(--rgb-primary-text-color), 0.08);
        }

        .context-menu button:disabled {
          opacity: 0.5;
          cursor: default;
        }

        .dialog-overlay {
          display: none;
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 999999999;
          align-items: center;
          justify-content: center;
        }

        .dialog-overlay.visible {
          display: flex;
        }

        /* The confirm overlay also carries .dialog-overlay. Both selectors have
           equal specificity and .dialog-overlay is declared later, so its shared
           z-index would otherwise win and drop the confirm to the same layer as
           the recording setup dialog (where DOM order puts it behind). This
           higher-specificity rule keeps a raise prompt on top. */
        .dialog-overlay.confirm-dialog-overlay {
          z-index: 1000000001;
        }

        .dialog-box {
          background: var(--card-background-color);
          border-radius: 12px;
          padding: 24px;
          max-width: 400px;
          width: 90%;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }

        .dialog-box-wide {
          max-width: min(1100px, 95vw);
          max-height: 85vh;
          overflow-y: auto;
        }

`;
