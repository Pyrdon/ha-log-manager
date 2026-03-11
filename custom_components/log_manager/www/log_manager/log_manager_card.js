class LogManagerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._availableLoggers = [];
    this._uiBuilt = false;
    this._isAddSectionVisible = false;
    this._editingPath = null;

    // Restore the previously saved configuration state from the session.
    this._savedPath = sessionStorage.getItem("logManagerPath") || "";
    this._savedName = sessionStorage.getItem("logManagerName") || "";
  }

  // Create a utility function to debounce rapid input events.
  // This ensures the function is not called too frequently.
  _debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // Persist the current input values to browser session storage.
  _persistState() {
    if (this._pathInput) {
      sessionStorage.setItem("logManagerPath", this._pathInput.value);
    }
    if (this._friendlyNameInput) {
      sessionStorage.setItem("logManagerName", this._friendlyNameInput.value);
    }
  }

  // Clear the persisted state entirely after a successful save.
  _clearState() {
    if (this._pathInput) {
        this._pathInput.value = "";
    }
    if (this._friendlyNameInput) {
        this._friendlyNameInput.value = "";
    }
    this._editingPath = null;
    sessionStorage.removeItem("logManagerPath");
    sessionStorage.removeItem("logManagerName");
  }

  set hass(hass) {
    this._hass = hass;

    if (!this._uiBuilt) {
      this._buildUI();
      this._fetchLoggers();
      this._uiBuilt = true;
    }

    this._updateActiveList();
  }

  // Build the user interface and inject the HTML and CSS.
  _buildUI() {
    this.shadowRoot.innerHTML = `
      <style>
        /* Reduced bottom padding from 16px to 8px to remove dead space. */
        ha-card { padding: 16px 16px 8px 16px; display: flex; flex-direction: column; }
        .header { margin-bottom: 12px; }
        .section-title { font-size: 18px; font-weight: 500; margin: 0; }
        .active-list { margin-bottom: 0; display: flex; flex-direction: column; }

        .log-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 8px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--divider-color);
        }

        /* Removes dead space at the bottom of the list. */
        .log-row:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }

        /* Hide action buttons by default to reduce visual clutter. */
        .action-btn {
          opacity: 0;
          transition: opacity 0.2s ease-in-out;
          pointer-events: none;
        }

        /* Show action buttons only when hovering over the specific row. */
        .log-row:hover .action-btn {
          opacity: 1;
          pointer-events: auto;
        }

        .log-name {
          flex-grow: 1;
          font-size: 14px;
          word-break: break-all;
          margin-right: 16px;
          line-height: 1.2;
          transition: opacity 0.2s;
        }

        /* Apply gray text and slight transparency to unavailable entities. */
        .log-name.unavailable { opacity: 0.6; color: var(--secondary-text-color); }
        .log-controls { display: flex; align-items: center; gap: 8px; }

        select {
          padding: 6px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
        }

        /* Smooth animation styling for the add logger section. */
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

        /* Flex layout to align the section title and save button. */
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

        /* Dropdown wrapper styling for custom searchable select. */
        .input-wrapper { position: relative; margin-bottom: 12px; margin-top: 12px; }

        /* Apply shared styling to all text inputs. */
        input[type="text"] {
          width: calc(100% - 18px);
          padding: 8px;
          border-radius: 4px;
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          font-family: inherit;
        }

        /* Custom dropdown list to show all options cleanly over other elements. */
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

        /* Reduced padding and text size to fit more items on screen. */
        .option-item {
          padding: 4px 8px;
          cursor: pointer;
          color: var(--primary-text-color);
          font-size: 13px;
          word-break: break-all;
        }

        .option-item:hover { background: rgba(var(--rgb-primary-text-color), 0.05); }
        .option-item.highlight { font-weight: bold; color: var(--primary-color); }

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

        /* Flex layout to spread buttons across the bottom symmetrically. */
        .card-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-top: 1px solid var(--divider-color);
          padding-top: 8px;
          margin-top: 12px;
        }

        /* Keep width auto so buttons sit neatly on the left and right. */
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
      </style>
      <ha-card>
        <div class="header">
          <div class="section-title">Loggers</div>
        </div>

        <div id="active-list" class="active-list"></div>

        <div class="add-section-wrapper" id="add-section-wrapper">
          <div class="add-section">
            <div class="add-section-header">
              <div class="add-section-title">Configure Logger</div>
              <button id="add-btn" disabled>Save</button>
            </div>

            <div class="input-wrapper">
              <input type="text" id="path-input" placeholder="Search or enter logger path..." />
              <div id="options-list" class="options-list"></div>
            </div>

            <input type="text" id="friendly-name-input" class="friendly-input"
                   placeholder="Friendly Name (Optional)" />
          </div>
        </div>

        <div class="card-actions">
          <button class="toggle-add-btn" id="toggle-add-btn">
            <ha-icon icon="mdi:plus" id="toggle-icon"></ha-icon>
            <span id="toggle-text">Add Logger</span>
          </button>

          <button class="toggle-add-btn" onclick="window.location.href='/config/logs'">
            <ha-icon icon="mdi:text-box-search-outline"></ha-icon>
            View Core Logs
          </button>
        </div>
      </ha-card>
    `;

    this._activeList = this.shadowRoot.getElementById("active-list");
    this._pathInput = this.shadowRoot.getElementById("path-input");
    this._optionsList = this.shadowRoot.getElementById("options-list");
    this._friendlyNameInput = this.shadowRoot.getElementById("friendly-name-input");
    this._addBtn = this.shadowRoot.getElementById("add-btn");
    this._toggleAddBtn = this.shadowRoot.getElementById("toggle-add-btn");
    this._toggleIcon = this.shadowRoot.getElementById("toggle-icon");
    this._toggleText = this.shadowRoot.getElementById("toggle-text");
    this._addSectionWrapper = this.shadowRoot.getElementById("add-section-wrapper");

    // Load the stored input values if they exist.
    this._pathInput.value = this._savedPath;
    this._friendlyNameInput.value = this._savedName;

    // Toggle the visibility of the add logger section with animation handling.
    const toggleSection = () => {
      this._isAddSectionVisible = !this._isAddSectionVisible;

      if (this._isAddSectionVisible) {
        this._addSectionWrapper.classList.add("visible");
        this._toggleIcon.setAttribute("icon", "mdi:chevron-up");
        this._toggleText.innerText = "Cancel";

        // Allow the dropdown to overflow the wrapper after the animation completes.
        setTimeout(() => {
          if (this._isAddSectionVisible) {
            this._addSectionWrapper.style.overflow = "visible";
            this._pathInput.focus();
          }
        }, 300);

        this._renderDropdown();
      } else {
        // Re-hide the overflow immediately before animating closed.
        this._editingPath = null;
        this._addSectionWrapper.style.overflow = "hidden";
        this._addSectionWrapper.classList.remove("visible");
        this._toggleIcon.setAttribute("icon", "mdi:plus");
        this._toggleText.innerText = "Add Logger";
        this._clearState();
      }
    };

    this._toggleAddBtn.addEventListener("click", toggleSection);

    // Apply debounce to the input filtering to prevent UI stuttering.
    const debouncedFilter = this._debounce((val) => {
      this._filterDropdown(val);
    }, 200).bind(this);

    this._pathInput.addEventListener("input", (e) => {
      // Extract value immediately to prevent null reference errors on delayed execution.
      const val = e.target.value;
      debouncedFilter(val);
      this._persistState();
      this._validateAddButton();
    });

    this._pathInput.addEventListener("focus", () => {
      this._optionsList.style.display = "block";
      this._filterDropdown(this._pathInput.value);
    });

    this._pathInput.addEventListener("blur", () => {
      // Delay hiding the list to allow click events on the options to register.
      setTimeout(() => {
        this._optionsList.style.display = "none";
      }, 150);
    });

    // Handle ESC key to dismiss the dropdown or the entire configuration panel.
    const handleEscKey = (e) => {
      if (e.key === "Escape") {
        if (this._optionsList.style.display === "block") {
          this._optionsList.style.display = "none";
        } else if (this._isAddSectionVisible) {
          toggleSection();
        }
      }
    };

    this._pathInput.addEventListener("keydown", handleEscKey);
    this._friendlyNameInput.addEventListener("keydown", handleEscKey);

    this._friendlyNameInput.addEventListener("input", () => {
      this._persistState();
      this._validateAddButton();
    });

    // Handle the save button click event.
    this._addBtn.addEventListener("click", () => {
      const loggerPath = this._pathInput.value.trim();
      const friendlyName = this._friendlyNameInput.value.trim() || loggerPath;

      if (this._editingPath) {
        // Find the entity ID to forcefully purge it from the core registry.
        const oldEidObj = Object.values(this._hass.states).find(s => {
          return s.entity_id.startsWith("select.log_manager_") &&
                 s.attributes.logger_name === this._editingPath;
        });

        if (oldEidObj) {
          this._hass.connection.sendMessagePromise({
            type: "config/entity_registry/remove",
            entity_id: oldEidObj.entity_id
          }).catch(() => { });
        }

        // Remove the old logger from the backend dictionary.
        this._hass.callService("log_manager", "remove_logger", {
          logger_name: this._editingPath
        });

        // Add a small delay to ensure the removal propagates before recreating.
        setTimeout(() => {
          this._hass.callService("log_manager", "add_logger", {
            logger_name: loggerPath,
            friendly_name: friendlyName
          });
        }, 250);
      } else {
        // Standard creation flow.
        this._hass.callService("log_manager", "add_logger", {
          logger_name: loggerPath,
          friendly_name: friendlyName
        });
      }

      this._clearState();
      toggleSection();
    });
  }

  // Fetch the available loggers from the backend using a websocket message.
  _fetchLoggers() {
    this._hass.connection.sendMessagePromise({ type: "log_manager/get_loggers" }).then(res => {
      this._availableLoggers = res.sort();
      this._renderDropdown();
    });
  }

  // Populate the custom dropdown list with all available loggers not currently managed.
  _renderDropdown() {
    this._optionsList.innerHTML = "";

    // Define the list of important logger roots to highlight.
    const highlights = ["homeassistant.", "custom_components.", "pyscript."];

    // Find all currently managed paths to exclude them from the list.
    const activePaths = Object.values(this._hass.states)
      .filter(s => s.entity_id.startsWith("select.log_manager_"))
      .map(s => s.attributes.logger_name);

    this._availableLoggers.forEach(opt => {
      // Skip loggers that are already managed by the integration.
      if (activePaths.includes(opt) && opt !== this._editingPath) {
        return;
      }

      const item = document.createElement("div");
      item.className = "option-item";

      const isHighlight = highlights.some(prefix => opt.startsWith(prefix));
      if (isHighlight) {
        item.classList.add("highlight");
        item.textContent = `★ ${opt}`;
      } else {
        item.textContent = opt;
      }

      // Use mousedown so the selection fires before the input loses focus.
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._pathInput.value = opt;
        this._persistState();
        this._validateAddButton();
        this._optionsList.style.display = "none";
        this._friendlyNameInput.focus();
      });

      this._optionsList.appendChild(item);
    });
  }

  // Filter the visible items in the dropdown list based on user text.
  _filterDropdown(filterText) {
    // Strip spaces and underscores from the search string for flexible fuzzy matching.
    const normalizedFilter = filterText.toLowerCase().replace(/[\s_]+/g, "");

    Array.from(this._optionsList.children).forEach(child => {
      // Remove the star prefix before matching to ensure accurate filtering.
      const rawText = child.textContent.replace("★ ", "").toLowerCase();

      // Normalize the target text to allow matching formats like 'Log Manager'.
      const normalizedText = rawText.replace(/[\s_]+/g, "");

      child.style.display = normalizedText.includes(normalizedFilter) ? "block" : "none";
    });
  }

  // Update the list of active loggers currently managed by the integration.
  _updateActiveList() {
    const rawActiveEntities = Object.keys(this._hass.states).filter(eid => {
      return eid.startsWith("select.log_manager_");
    });

    if (rawActiveEntities.length === 0) {
      this._activeList.innerHTML = `
        <div class="empty-state"
          style="color: var(--secondary-text-color); font-style: italic;
          font-size: 14px; text-align: center; padding: 16px;">
          No loggers currently managed.
        </div>`;

      // Refresh the dropdown to ensure removed loggers reappear.
      if (this._isAddSectionVisible) {
        this._renderDropdown();
        this._filterDropdown(this._pathInput.value);
      }
      return;
    }

    const emptyState = this._activeList.querySelector(".empty-state");
    if (emptyState) {
        emptyState.remove();
    }

    // Enable flexbox so we can sort items visually using CSS order.
    this._activeList.style.display = "flex";
    this._activeList.style.flexDirection = "column";

    // Map entities to retrieve their friendly names for sorting.
    const mappedEntities = rawActiveEntities.map(eid => {
      const stateObj = this._hass.states[eid];
      const friendlyName = stateObj.attributes.friendly_name || eid;
      return { eid, friendlyName };
    });

    // Sort the array alphabetically by friendly name.
    mappedEntities.sort((a, b) => {
      return a.friendlyName.localeCompare(b.friendlyName, undefined, { sensitivity: "base" });
    });

    // Extract the sorted entity IDs.
    const activeEntities = mappedEntities.map(item => item.eid);

    // Remove rows that correspond to deleted entities.
    const existingRows = Array.from(this._activeList.querySelectorAll(".log-row"));
    existingRows.forEach(row => {
      if (!activeEntities.includes(row.dataset.entityId)) {
        row.remove();
      }
    });

    // Add new rows or update existing ones without destroying the DOM.
    activeEntities.forEach((eid, index) => {
      const stateObj = this._hass.states[eid];
      let row = this._activeList.querySelector(`.log-row[data-entity-id="${eid}"]`);

      // Gracefully handle entities that failed to initialize on the backend.
      const options = stateObj.attributes.options || [];
      const isUnavailable = stateObj.state === "unavailable" ||
                            stateObj.state === "unknown" ||
                            options.length === 0;
      const actualLoggerName = stateObj.attributes.logger_name || "Unknown";
      const displayName = stateObj.attributes.friendly_name || eid;

      // Rebuild the row cleanly if its availability state has changed.
      if (!row || row.dataset.isUnavailable !== String(isUnavailable)) {
        if (row) {
            row.remove();
        }

        row = document.createElement("div");
        row.className = "log-row";
        row.dataset.entityId = eid;
        row.dataset.isUnavailable = String(isUnavailable);

        const selectOptions = options.map(opt => {
          return `<option value="${opt}">${opt}</option>`;
        }).join("");

        const selectHtml = isUnavailable
          ? `<select class="level-select" disabled><option>Unavailable</option></select>`
          : `<select class="level-select">${selectOptions}</select>`;

        // Apply the unavailable CSS class to gray out text if necessary.
        row.innerHTML = `
          <div class="log-name ${isUnavailable ? "unavailable" : ""}">
            <div style="font-weight: 500;">${displayName}</div>
            <div style="color: var(--secondary-text-color); font-size: 12px; margin-top: 2px;">
              ${actualLoggerName}
            </div>
          </div>
          <div class="log-controls">
            ${selectHtml}
            <button class="icon-btn action-btn edit-btn" title="Edit">
              <ha-icon icon="mdi:pencil"></ha-icon>
            </button>
            <button class="icon-btn action-btn remove-btn" title="Remove">
              <ha-icon icon="mdi:delete"></ha-icon>
            </button>
          </div>
        `;

        if (!isUnavailable) {
          row.querySelector(".level-select").value = stateObj.state;
          row.querySelector(".level-select").addEventListener("change", (e) => {
            this._hass.callService("select", "select_option", {
              entity_id: eid,
              option: e.target.value
            });
          });

          row.querySelector(".edit-btn").addEventListener("click", () => {
            this._pathInput.value = actualLoggerName;
            this._friendlyNameInput.value = displayName;
            this._editingPath = actualLoggerName;

            if (!this._isAddSectionVisible) {
              this.shadowRoot.getElementById("toggle-add-btn").click();
            } else {
              this._validateAddButton();
              this._pathInput.focus();
            }
          });
        } else {
          // Disable the edit button cleanly if the entity is unavailable.
          row.querySelector(".edit-btn").disabled = true;
          row.querySelector(".edit-btn").style.opacity = "0.3";
          row.querySelector(".edit-btn").style.cursor = "not-allowed";
        }

        row.querySelector(".remove-btn").addEventListener("click", () => {
          // Display a confirmation dialog before sending the delete request.
          if (confirm(`Are you sure you want to remove the logger '${displayName}'?`)) {

            // Forcefully purge the entity from the core registry.
            this._hass.connection.sendMessagePromise({
              type: "config/entity_registry/remove",
              entity_id: eid
            }).catch(() => { });

            // Only attempt the python service call if the integration still recognizes it.
            if (!isUnavailable) {
              this._hass.callService("log_manager", "remove_logger", {
                logger_name: actualLoggerName,
                friendly_name: displayName
              });
            }
          }
        });

      } else {
        // Update the select value only if the user is not actively interacting with it.
        if (!isUnavailable) {
          const select = row.querySelector(".level-select");
          if (document.activeElement !== select) {
            select.value = stateObj.state;
          }
        }
      }

      // Only move the row if it's not already in the correct position in order to prevent flickering
      const expectedNode = this._activeList.children[index];
      if (expectedNode !== row) {
        this._activeList.insertBefore(row, expectedNode);
      }
    });

    // Re-render the dropdown list so deleted items instantly reappear.
    if (this._isAddSectionVisible) {
      this._renderDropdown();
      this._filterDropdown(this._pathInput.value);
    }
  }

  // Validate the input fields and enable or disable the save button.
  _validateAddButton() {
    const loggerPath = this._pathInput.value.trim();
    const friendlyName = this._friendlyNameInput.value.trim();

    // Check all currently active entities, explicitly excluding the one being edited.
    const activeStates = Object.values(this._hass.states).filter(s => {
      return s.entity_id.startsWith("select.log_manager_") &&
             s.attributes.logger_name !== this._editingPath;
    });

    const isDuplicatePath = activeStates.some(s => {
      return s.attributes.logger_name === loggerPath;
    });

    const isDuplicateName = activeStates.some(s => {
      return s.attributes.friendly_name === friendlyName && friendlyName !== "";
    });

    // Ensure the path exists in the known loggers list, unless it's the one being edited.
    const isUnknownPath = loggerPath.length > 0 &&
                          !this._availableLoggers.includes(loggerPath) &&
                          loggerPath !== this._editingPath;

    // Disable the button and show a hint if validation fails.
    if (isDuplicatePath || isDuplicateName || isUnknownPath) {
      this._addBtn.disabled = true;
      if (isDuplicatePath) {
          this._addBtn.innerText = "Path Managed";
      } else if (isDuplicateName) {
          this._addBtn.innerText = "Name Taken";
      } else if (isUnknownPath) {
          this._addBtn.innerText = "Unknown Path";
      }
      this._addBtn.style.background = "var(--error-color)";
    } else {
      this._addBtn.disabled = loggerPath.length === 0;
      this._addBtn.innerText = this._editingPath ? "Update" : "Save";
      this._addBtn.style.background = "var(--primary-color)";
    }
  }

  // Define the setConfig method required by Home Assistant custom cards.
  setConfig(config) {
    this.config = config;
  }
}

// Register the custom card in the Home Assistant visual editor.
window.customCards = window.customCards || [];
window.customCards.push({
  type: "log-manager-card",
  name: "Log Manager",
  description: "A control panel for managing loggers.",
});

// Define the custom HTML element.
customElements.define("log-manager-card", LogManagerCard);
