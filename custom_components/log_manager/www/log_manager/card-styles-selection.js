// Shadow-DOM styles — row-selection model and stylesheet close.
export const CARD_STYLES_SELECTION = `        /* Explicit row selection model (replaces native text selection). */
        .selectable-entry {
          user-select: none;
          -webkit-user-select: none;
          -webkit-user-drag: none;
        }

        .selectable-entry.selected {
          background: rgba(var(--rgb-primary-color), 0.18) !important;
          border-left: 3px solid var(--primary-color) !important;
          outline: 2px solid var(--primary-color);
          outline-offset: -2px;
        }

        .log-preview-col.msg-col {
          flex: 1;
          min-width: 0;
          white-space: pre-wrap;
          word-break: break-all;
        }
      </style>
`;
