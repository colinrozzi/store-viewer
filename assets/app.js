/**
 * Theater Store Viewer - Frontend Application
 * A minimal label → content viewer/editor for Theater's content-addressed store
 */

class StoreViewer {
    constructor() {
        this.labels = [];
        this.currentLabel = null;
        this.editor = null;
        this.saveTimeout = null;
        this.isDirty = false;
        this.isLoading = false;
    }

    /**
     * Initialize the application
     */
    async init() {
        console.log('Initializing Store Viewer...');

        // Initialize CodeMirror editor
        const textarea = document.getElementById('editor');
        this.editor = CodeMirror.fromTextArea(textarea, {
            mode: 'javascript',
            theme: 'monokai',
            lineNumbers: false,
            lineWrapping: true,
            tabSize: 2,
            indentUnit: 2,
            indentWithTabs: false,
            autofocus: false,
        });

        // Listen for editor changes
        this.editor.on('change', () => {
            if (this.currentLabel && !this.isLoading) {
                this.isDirty = true;
                this.updateSaveButton();
                this.scheduleAutoSave();
            }
        });

        // Setup event listeners
        this.setupEventListeners();

        // Collapse sidebar on mobile by default
        if (this.isMobile()) {
            const sidebar = document.querySelector('.sidebar');
            sidebar.classList.add('collapsed');
        }

        // Load labels from the API
        await this.loadLabels();

        console.log('Store Viewer initialized');
    }

    /**
     * Setup all event listeners
     */
    setupEventListeners() {
        // New label button
        document.getElementById('new-label-btn').addEventListener('click', () => {
            this.promptCreateLabel();
        });

        // Save button
        document.getElementById('save-btn').addEventListener('click', () => {
            this.saveLabel();
        });

        // Search input
        document.getElementById('search-input').addEventListener('input', (e) => {
            this.filterLabels(e.target.value);
        });

        // Sidebar toggle buttons
        const toggleSidebar = () => {
            const sidebar = document.querySelector('.sidebar');
            sidebar.classList.toggle('collapsed');
        };

        document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
        document.getElementById('sidebar-toggle-editor').addEventListener('click', toggleSidebar);

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl+S or Cmd+S to save
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (this.currentLabel && this.isDirty) {
                    this.saveLabel();
                }
            }
            // Ctrl+B or Cmd+B to toggle sidebar
            if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault();
                const sidebar = document.querySelector('.sidebar');
                sidebar.classList.toggle('collapsed');
            }
        });
    }

    /**
     * Load all labels from the API
     */
    async loadLabels() {
        try {
            console.log('Loading labels...');
            const response = await fetch('/api/labels');

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            this.labels = await response.json();
            console.log(`Loaded ${this.labels.length} labels`);

            this.renderLabelList();
        } catch (error) {
            console.error('Failed to load labels:', error);
            this.showError('Failed to load labels from the server.');
            document.getElementById('label-list').innerHTML =
                '<div class="empty-message">Failed to load labels</div>';
        }
    }

    /**
     * Render the label list in the sidebar
     */
    renderLabelList(filter = '') {
        const container = document.getElementById('label-list');

        // Filter labels based on search query
        let filtered = this.labels;
        if (filter) {
            const lowerFilter = filter.toLowerCase();
            filtered = this.labels.filter(label =>
                label.toLowerCase().includes(lowerFilter)
            );
        }

        // Handle empty list
        if (filtered.length === 0) {
            const message = filter
                ? `No labels matching "${filter}"`
                : 'No labels found. Create one to get started!';
            container.innerHTML = `<div class="empty-message">${message}</div>`;
            return;
        }

        // Sort labels alphabetically
        const sorted = [...filtered].sort((a, b) => a.localeCompare(b));

        // Generate HTML for each label
        const html = sorted.map(label => {
            const isActive = this.currentLabel === label;
            const escapedLabel = this.escapeHtml(label);
            return `
                <div class="label-item ${isActive ? 'active' : ''}"
                     data-name="${escapedLabel}"
                     title="${escapedLabel}">
                    <span class="label-name">${escapedLabel}</span>
                </div>
            `;
        }).join('');

        container.innerHTML = html;

        // Add click handlers
        container.querySelectorAll('.label-item').forEach(item => {
            item.addEventListener('click', () => {
                const labelName = item.dataset.name;
                this.selectLabel(labelName);
            });
        });
    }

    /**
     * Select and load a label
     */
    async selectLabel(name) {
        // Check for unsaved changes
        if (this.isDirty && this.currentLabel) {
            const shouldSave = confirm(
                `You have unsaved changes in "${this.currentLabel}". Save before switching?`
            );
            if (shouldSave) {
                await this.saveLabel();
            }
        }

        try {
            console.log(`Selecting label: ${name}`);
            this.isLoading = true;

            const response = await fetch(`/api/labels/${encodeURIComponent(name)}`);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            // Update current label
            this.currentLabel = name;
            this.isDirty = false;

            // Show editor view
            document.getElementById('empty-state').classList.add('hidden');
            document.getElementById('editor-view').classList.remove('hidden');

            // Update label name display
            document.getElementById('label-name').value = name;

            // Handle text vs binary content
            if (data.is_text) {
                // Show editor, hide binary view
                document.getElementById('editor-wrapper').classList.remove('hidden');
                document.getElementById('binary-view').classList.add('hidden');

                // Load content into editor
                this.editor.setValue(data.content);
                this.editor.clearHistory();

                // Detect and set mode based on file extension
                this.setEditorMode(name);

                // Enable save button
                document.getElementById('save-btn').disabled = false;

                console.log(`Loaded text content for: ${name} (${data.size_bytes} bytes)`);
            } else {
                // Show binary view, hide editor
                document.getElementById('editor-wrapper').classList.add('hidden');
                document.getElementById('binary-view').classList.remove('hidden');

                // Display binary info
                const info = `Size: ${this.formatBytes(data.size_bytes)}\nEncoding: Base64`;
                document.getElementById('binary-info').textContent = info;

                // Disable save button
                document.getElementById('save-btn').disabled = true;

                console.log(`Loaded binary content for: ${name} (${data.size_bytes} bytes)`);
            }

            // Update UI
            this.updateSaveButton();
            this.renderLabelList(document.getElementById('search-input').value);

            // Auto-collapse sidebar on mobile after selecting a label
            if (this.isMobile()) {
                const sidebar = document.querySelector('.sidebar');
                sidebar.classList.add('collapsed');
            }

        } catch (error) {
            console.error('Failed to load label:', error);
            this.showError(`Failed to load label: ${name}`);
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Save the current label's content
     */
    async saveLabel() {
        if (!this.currentLabel || !this.isDirty) {
            return;
        }

        try {
            console.log(`Saving label: ${this.currentLabel}`);

            const content = this.editor.getValue();
            const statusEl = document.getElementById('save-status');

            statusEl.textContent = 'Saving...';

            const response = await fetch(`/api/labels/${encodeURIComponent(this.currentLabel)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            this.isDirty = false;
            this.updateSaveButton();

            statusEl.textContent = 'Saved';
            setTimeout(() => {
                statusEl.textContent = '';
            }, 2000);

            console.log(`Saved: ${this.currentLabel}`);

        } catch (error) {
            console.error('Failed to save:', error);
            this.showError(`Failed to save label: ${this.currentLabel}`);
            document.getElementById('save-status').textContent = 'Save failed';
        }
    }

    /**
     * Prompt user to create a new label
     */
    async promptCreateLabel() {
        const name = prompt('Enter label name:');

        if (!name) {
            return; // User cancelled
        }

        if (name.trim() === '') {
            alert('Label name cannot be empty');
            return;
        }

        // Check if label already exists
        if (this.labels.includes(name)) {
            const shouldOpen = confirm(
                `Label "${name}" already exists. Do you want to open it instead?`
            );
            if (shouldOpen) {
                await this.selectLabel(name);
            }
            return;
        }

        try {
            console.log(`Creating label: ${name}`);

            const response = await fetch('/api/labels', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    content: '', // Start with empty content
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            console.log(`Created label: ${name}`);

            // Reload labels and select the new one
            await this.loadLabels();
            await this.selectLabel(name);

        } catch (error) {
            console.error('Failed to create label:', error);
            this.showError(`Failed to create label: ${name}`);
        }
    }

    /**
     * Filter labels by search query
     */
    filterLabels(query) {
        this.renderLabelList(query);
    }

    /**
     * Update save button state
     */
    updateSaveButton() {
        const btn = document.getElementById('save-btn');
        if (!btn) return;

        btn.disabled = !this.isDirty;
        btn.textContent = this.isDirty ? 'Save *' : 'Save';
    }

    /**
     * Schedule auto-save after delay
     */
    scheduleAutoSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            if (this.isDirty && this.currentLabel) {
                console.log('Auto-saving...');
                this.saveLabel();
            }
        }, 1000); // Auto-save after 1 second of inactivity
    }

    /**
     * Set CodeMirror mode based on file extension
     */
    setEditorMode(filename) {
        const ext = filename.split('.').pop().toLowerCase();

        const modeMap = {
            'js': 'javascript',
            'json': { name: 'javascript', json: true },
            'ts': 'javascript',
            'jsx': 'jsx',
            'tsx': 'jsx',
            'md': 'markdown',
            'py': 'python',
            'rs': 'rust',
            'html': 'htmlmixed',
            'htm': 'htmlmixed',
            'xml': 'xml',
            'css': 'css',
            'scss': 'css',
            'sass': 'css',
            'txt': 'text',
        };

        const mode = modeMap[ext] || 'javascript';
        this.editor.setOption('mode', mode);
    }

    /**
     * Show error message to user
     */
    showError(message) {
        alert(`Error: ${message}`);
    }

    /**
     * Format bytes to human-readable string
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    /**
     * Escape HTML special characters
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Detect if the user is on a mobile device
     */
    isMobile() {
        return window.innerWidth <= 768 ||
               /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }
}

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const viewer = new StoreViewer();
    viewer.init().catch(error => {
        console.error('Failed to initialize Store Viewer:', error);
        alert('Failed to initialize the application. Please refresh the page.');
    });
});
