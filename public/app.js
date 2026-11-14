/**
 * PC Live Dashboard — Main Application Logic
 * Handles WebSocket connection, data processing, and DOM updates
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════
    const CONFIG = {
        WS_URL: `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`,
        RECONNECT_DELAY: 2000,
        MAX_RECONNECT_DELAY: 30000,
        HISTORY_LENGTH: 60,
        PROCESS_PAGE_SIZE: 100,
        ALERT_CPU_THRESHOLD: 90,
        ALERT_RAM_THRESHOLD: 85,
        ALERT_GPU_TEMP_THRESHOLD: 85,
        ALERT_DISK_THRESHOLD: 95
    };

    // ═══════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════
    const state = {
        ws: null,
        connected: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        staticData: null,
        processSort: { key: 'cpu', direction: 'desc' },
        serviceFilter: 'all',
        processSearch: '',
        serviceSearch: '',
        lastProcesses: [],
        lastServices: [],
        gpuChartsInitialized: false,
        gpuCharts: [],
        gpuBuffers: [],
        gpuVramCharts: [],
        gpuVramBuffers: [],
        gpuControllers: [],
        cpuTemperature: null
    };

    // Chart instances
    const charts = {};
    // Rolling data buffers
    const buffers = {};

    // ═══════════════════════════════════════════════════════════════
    // DOM REFERENCES
    // ═══════════════════════════════════════════════════════════════
    const $ = (id) => document.getElementById(id);
    const $$ = (selector) => document.querySelectorAll(selector);

    // ═══════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════
    function init() {
        initSettingsSidebar();
        initNetworkTab();
        initCardGroups();
        initCardDragAndDrop();
        applyCardSizes();
        applyCardVisibility();
        applyComponentVisibility();
        initCharts();
        initEventListeners();
        connectWebSocket();
        document.addEventListener('visibilitychange', flushDeferredMessages);
        startClock();
        initResizeObserver();
        setTimeout(resizeGridItems, 100);
    }

    // ═══════════════════════════════════════════════════════════════
    // CARD REGISTRY — defines all cards and their sub-components
    // ═══════════════════════════════════════════════════════════════
    const CARD_REGISTRY = [
        { id: 'cpu-panel',       label: 'CPU',          icon: '🔲', defaultSize: 1, components: [
            { key: 'cpu-gauge',    label: 'Gauge & Stats' },
            { key: 'cpu-stats',    label: 'Speed / Temp / Cores' },
            { key: 'cpu-chart',    label: 'History Chart' },
            { key: 'cpu-corebars', label: 'Per-Core Bars' },
        ]},
        { id: 'ram-panel',       label: 'Memory',       icon: '🧠', defaultSize: 1, components: [
            { key: 'ram-gauge',  label: 'Gauge & Stats' },
            { key: 'ram-stats',  label: 'Used / Total / Free' },
            { key: 'ram-swap',   label: 'Swap Bar' },
            { key: 'ram-chart',  label: 'History Chart' },
        ]},
        { id: 'gpu-group',       label: 'GPU Group',    icon: '🎮', defaultSize: 2, components: [
            { key: 'gpu-cards',  label: 'GPU Cards' },
        ]},
        { id: 'network-group',   label: 'Network Group', icon: '🌐', defaultSize: 2, components: [
            { key: 'net-stats',      label: 'Speed Stats' },
            { key: 'net-chart',      label: 'Traffic Chart' },
            { key: 'net-interfaces', label: 'Interface List' },
        ]},
        { id: 'disk-panel',      label: 'Storage',      icon: '💾', defaultSize: 1, components: [
            { key: 'disk-list', label: 'Drive List' },
            { key: 'disk-io',   label: 'I/O Stats' },
        ]},
        { id: 'temp-panel',      label: 'Temperatures', icon: '🌡️', defaultSize: 1, components: [] },
        { id: 'fans-panel',      label: 'Fans',         icon: '🌀', defaultSize: 1, components: [] },
        { id: 'battery-panel',   label: 'Battery',      icon: '🔋', defaultSize: 1, components: [
            { key: 'battery-icon',  label: 'Battery Icon' },
            { key: 'battery-stats', label: 'Stats Grid' },
        ]},
        { id: 'processes-panel', label: 'Processes',    icon: '📋', defaultSize: 'full', components: [
            { key: 'proc-search', label: 'Search Bar' },
            { key: 'proc-table',  label: 'Process Table' },
        ]},
        { id: 'apps-panel',     label: 'Active Apps',   icon: '🖥️', defaultSize: 1, components: [] },
        { id: 'services-panel', label: 'Services',      icon: '⚙️', defaultSize: 2, components: [
            { key: 'svc-filters', label: 'Filters & Search' },
            { key: 'svc-table',   label: 'Service Table' },
        ]},
    ];

    // ═══════════════════════════════════════════════════════════════
    // SETTINGS SIDEBAR
    // ═══════════════════════════════════════════════════════════════
    function initSettingsSidebar() {
        const btn = $('settings-btn');
        const sidebar = $('settings-sidebar');
        const overlay = $('settings-overlay');
        const closeBtn = $('settings-close-btn');
        const resetBtn = $('settings-reset-btn');
        if (!btn || !sidebar) return;

        function openSidebar() {
            sidebar.classList.add('show');
            if (overlay) overlay.classList.add('show');
        }
        function closeSidebar() {
            sidebar.classList.remove('show');
            if (overlay) overlay.classList.remove('show');
        }

        btn.addEventListener('click', openSidebar);
        if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
        if (overlay) overlay.addEventListener('click', closeSidebar);
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (confirm('Are you sure you want to reset all dashboard settings and groups to default?')) {
                    localStorage.clear();
                    window.location.reload();
                }
            });
        }

        // Tab switching
        const tabs = sidebar.querySelectorAll('.settings-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                sidebar.querySelectorAll('.settings-tab-panel').forEach(p => p.classList.remove('active'));
                const target = $(`tab-${tab.getAttribute('data-tab')}`);
                if (target) target.classList.add('active');
            });
        });

        // Populate Layout tab
        populateLayoutTab();
        // Populate Components tab
        populateComponentsTab();
        // Populate Groups tab
        populateGroupsTab();
        // Lock mode
        initLockMode();
    }

    // ── Layout Tab ──
    function populateLayoutTab() {
        const container = $('tab-layout');
        if (!container) return;

        const groups = getCardGroups();

        // 1. Gather default registry panels (CPU, Memory, etc.)
        let items = CARD_REGISTRY.map(card => ({
            id: card.id,
            label: card.label,
            icon: card.icon,
            defaultSize: card.defaultSize
        }));

        // 2. Append custom/default groups from localStorage
        groups.forEach(g => {
            if (!items.some(it => it.id === g.id)) {
                items.push({
                    id: g.id,
                    label: g.name,
                    icon: '📁',
                    defaultSize: 2
                });
            }
        });

        // 3. Append dynamic GPU cards currently in DOM
        document.querySelectorAll('.gpu-card').forEach(el => {
            const nameEl = el.querySelector('.gpu-name');
            const label = nameEl ? nameEl.textContent.trim() : 'GPU';
            items.push({
                id: el.id,
                label: label,
                icon: '🎮',
                defaultSize: 1
            });
        });

        // 4. Append dynamic Network adapter cards currently in DOM
        document.querySelectorAll('.net-iface-card').forEach(el => {
            const nameEl = el.querySelector('.net-iface-name');
            const label = nameEl ? nameEl.textContent.trim() : 'Network Adapter';
            items.push({
                id: el.id,
                label: label,
                icon: '🌐',
                defaultSize: 1
            });
        });

        container.innerHTML = items.map(item => {
            const isHidden = localStorage.getItem(`pc-card-hidden-${item.id}`) === 'true';
            const savedSize = localStorage.getItem(`pc-card-size-${item.id}`) || item.defaultSize;
            
            const belongingGroup = groups.find(g => g.cards.includes(item.id));
            let groupText = '';
            if (belongingGroup) {
                groupText = `<span style="font-size: 0.68rem; color: var(--accent-cyan); margin-left: 6px; background: rgba(0, 240, 255, 0.08); padding: 1px 5px; border-radius: 4px; border: 1px solid rgba(0, 240, 255, 0.15);">📁 ${belongingGroup.name}</span>`;
            } else if (item.id.startsWith('gpu-card-')) {
                const gpuOrder = JSON.parse(localStorage.getItem('pc-group-cards-gpu-group') || '[]');
                const gpuBody = $('gpu-cards');
                const isGrouped = (gpuBody && document.getElementById(item.id)?.parentNode === gpuBody) || gpuOrder.includes(item.id);
                if (isGrouped) {
                    groupText = `<span style="font-size: 0.68rem; color: var(--accent-cyan); margin-left: 6px; background: rgba(0, 240, 255, 0.08); padding: 1px 5px; border-radius: 4px; border: 1px solid rgba(0, 240, 255, 0.15);">📁 GPU Group</span>`;
                }
            } else if (item.id.startsWith('net-iface-')) {
                const netOrder = JSON.parse(localStorage.getItem('pc-group-cards-network-group') || '[]');
                const netBody = $('net-interfaces');
                const isGrouped = (netBody && document.getElementById(item.id)?.parentNode === netBody) || netOrder.includes(item.id);
                if (isGrouped) {
                    groupText = `<span style="font-size: 0.68rem; color: var(--accent-cyan); margin-left: 6px; background: rgba(0, 240, 255, 0.08); padding: 1px 5px; border-radius: 4px; border: 1px solid rgba(0, 240, 255, 0.15);">📁 Network Group</span>`;
                }
            }

            return `
                <div class="layout-card-row" data-card-id="${item.id}">
                    <div class="card-toggle">
                        <input type="checkbox" id="vis-${item.id}" ${isHidden ? '' : 'checked'}>
                        <label for="vis-${item.id}">${item.icon} ${item.label}${groupText}</label>
                    </div>
                    <div class="size-selector">
                        <button data-size="1" class="${savedSize == 1 ? 'active' : ''}">1×</button>
                        <button data-size="2" class="${savedSize == 2 ? 'active' : ''}">2×</button>
                        <button data-size="full" class="${savedSize === 'full' ? 'active' : ''}">Full</button>
                    </div>
                </div>
            `;
        }).join('');

        // Visibility toggles
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const cardId = cb.closest('.layout-card-row').getAttribute('data-card-id');
                const panel = $(cardId);
                if (panel) {
                    panel.style.display = cb.checked ? '' : 'none';
                    localStorage.setItem(`pc-card-hidden-${cardId}`, cb.checked ? 'false' : 'true');
                    resizeGridItems();
                }
            });
        });

        // Size selectors
        container.querySelectorAll('.size-selector button').forEach(btn => {
            btn.addEventListener('click', () => {
                const row = btn.closest('.layout-card-row');
                const cardId = row.getAttribute('data-card-id');
                const size = btn.getAttribute('data-size');
                row.querySelectorAll('.size-selector button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                localStorage.setItem(`pc-card-size-${cardId}`, size);
                applyCardSize(cardId, size);
                resizeGridItems();
            });
        });
    }

    // ── Components Tab ──
    function populateComponentsTab() {
        const container = $('tab-components');
        if (!container) return;

        const cardsWithComponents = CARD_REGISTRY.filter(c => c.components.length > 0);
        container.innerHTML = cardsWithComponents.map(card => {
            return `
                <div class="component-card-section">
                    <div class="component-card-header" data-card="${card.id}">
                        <span>${card.icon} ${card.label}</span>
                        <span class="expand-icon">▼</span>
                    </div>
                    <div class="component-card-body">
                        ${card.components.map(comp => {
                            const isHidden = localStorage.getItem(`pc-comp-hidden-${comp.key}`) === 'true';
                            return `
                                <div class="component-toggle-row">
                                    <input type="checkbox" id="comp-${comp.key}" data-component-key="${comp.key}" ${isHidden ? '' : 'checked'}>
                                    <label for="comp-${comp.key}">${comp.label}</label>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }).join('');

        // Expand/collapse
        container.querySelectorAll('.component-card-header').forEach(header => {
            header.addEventListener('click', () => {
                header.classList.toggle('expanded');
                const body = header.nextElementSibling;
                if (body) body.classList.toggle('show');
            });
        });

        // Component toggles
        container.querySelectorAll('input[data-component-key]').forEach(cb => {
            cb.addEventListener('change', () => {
                const key = cb.getAttribute('data-component-key');
                localStorage.setItem(`pc-comp-hidden-${key}`, cb.checked ? 'false' : 'true');
                applyComponentVisibility();
                resizeGridItems();
            });
        });
    }

    // ── Groups Tab ──
    function populateGroupsTab() {
        const createBtn = $('group-create-btn');
        const nameInput = $('group-name-input');
        if (!createBtn || !nameInput) return;

        createBtn.addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (!name) return;
            createCardGroup(name);
            nameInput.value = '';
            renderGroupList();
        });

        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') createBtn.click();
        });

        renderGroupList();
    }

    // ── Network Tab ──
    // Shown only when the dashboard is open on the PC it monitors: the server
    // refuses the settings API to every other device.
    const SETTINGS_HEADERS = { 'X-PC-Live-Dash': 'dashboard' };

    async function initNetworkTab() {
        const tab = $('settings-tab-network');
        const lanCb = $('net-lan-cb');
        const portInput = $('net-port-input');
        const portBtn = $('net-port-btn');
        if (!tab || !lanCb || !portInput || !portBtn) return;

        let settings;
        try {
            const res = await fetch('/api/settings', { headers: SETTINGS_HEADERS });
            if (!res.ok) return;
            settings = await res.json();
        } catch (err) {
            return;
        }
        tab.hidden = false;
        renderNetworkSettings(settings);

        lanCb.addEventListener('change', async () => {
            const updated = await saveNetworkSettings({ lanAccess: lanCb.checked });
            if (updated) {
                renderNetworkSettings(updated);
            } else {
                lanCb.checked = !lanCb.checked;
            }
        });

        portBtn.addEventListener('click', async () => {
            const port = Number(portInput.value);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) {
                setNetworkStatus('Enter a port from 1024 to 65535.', true);
                return;
            }
            const updated = await saveNetworkSettings({ port });
            if (!updated) return;
            if (String(updated.port) !== window.location.port) {
                // The server is moving: follow it once it has had time to switch.
                setNetworkStatus(`Moving to port ${updated.port}...`);
                setTimeout(() => {
                    window.location.href = `${window.location.protocol}//${window.location.hostname}:${updated.port}/`;
                }, 1500);
            }
        });
    }

    async function saveNetworkSettings(change) {
        setNetworkStatus('Saving...');
        try {
            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: { ...SETTINGS_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify(change)
            });
            const body = await res.json();
            if (!res.ok) {
                setNetworkStatus(body.error || 'Could not save the setting.', true);
                return null;
            }
            setNetworkStatus('Saved.');
            return body;
        } catch (err) {
            setNetworkStatus('Could not reach the server.', true);
            return null;
        }
    }

    function renderNetworkSettings(settings) {
        const lanCb = $('net-lan-cb');
        const portInput = $('net-port-input');
        lanCb.checked = Boolean(settings.lanAccess);
        lanCb.disabled = Boolean(settings.hostLocked);
        portInput.value = settings.port;
        portInput.disabled = Boolean(settings.portLocked);
        $('net-port-btn').disabled = Boolean(settings.portLocked);

        let lanNote = 'There is no password. Anyone on your network can see your processes and network addresses. Use a trusted network only.';
        if (settings.hostLocked) {
            lanNote = 'Fixed by the HOST environment variable.';
        } else if (settings.lanAccess && settings.lanUrls && settings.lanUrls.length > 0) {
            lanNote = `Other devices can open: ${settings.lanUrls.join(', ')}`;
        }
        setText('net-lan-note', lanNote);
        setText('net-port-note', settings.portLocked ? 'Fixed by the PORT environment variable.' : 'Default is 3000.');
        setText('net-version', settings.version ? `PC Live Dash v${settings.version}` : '');
    }

    function setNetworkStatus(text, isError) {
        const el = $('net-status');
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('error', Boolean(isError));
    }

    function renderGroupList() {
        const container = $('group-list');
        if (!container) return;

        const groups = getCardGroups();

        if (groups.length === 0) {
            container.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 10px;">No groups created.</div>';
            return;
        }

        container.innerHTML = groups.map(g => `
            <div class="group-list-item" data-group-id="${escapeHtml(g.id)}">
                <div class="group-info">
                    <span>📁 ${escapeHtml(g.name)}</span>
                    <span class="group-card-count">${g.cards.length} cards</span>
                </div>
                <button data-delete-group="${escapeHtml(g.id)}" title="Delete group">✕</button>
            </div>
        `).join('');

        container.querySelectorAll('[data-delete-group]').forEach(btn => {
            btn.addEventListener('click', () => {
                deleteCardGroup(btn.getAttribute('data-delete-group'));
                renderGroupList();
            });
        });
    }

    // ── Lock Mode ──
    function initLockMode() {
        const cb = $('lock-layout-cb');
        if (!cb) return;

        const locked = localStorage.getItem('pc-layout-locked') === 'true';
        cb.checked = locked;
        applyLockMode(locked);

        cb.addEventListener('change', () => {
            localStorage.setItem('pc-layout-locked', cb.checked ? 'true' : 'false');
            applyLockMode(cb.checked);
        });
    }

    function applyLockMode(locked) {
        document.querySelectorAll('.card').forEach(card => {
            if (locked) {
                card.classList.add('layout-locked');
                card.setAttribute('draggable', 'false');
            } else {
                card.classList.remove('layout-locked');
                card.setAttribute('draggable', 'true');
            }
            const header = card.querySelector('.card-header') || card.querySelector('.gpu-card-header') || card.querySelector('.net-iface-header');
            if (header) {
                header.style.cursor = locked ? 'default' : 'grab';
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // CARD SIZING
    // ═══════════════════════════════════════════════════════════════
    function applyCardSizes() {
        // 1. Static panels
        CARD_REGISTRY.forEach(card => {
            const saved = localStorage.getItem(`pc-card-size-${card.id}`) || card.defaultSize;
            applyCardSize(card.id, saved);
        });

        // 2. Custom/Default groups
        const groups = getCardGroups();
        groups.forEach(g => {
            const saved = localStorage.getItem(`pc-card-size-${g.id}`) || '2';
            applyCardSize(g.id, saved);
        });

        // 3. Dynamic GPU cards
        document.querySelectorAll('.gpu-card').forEach(el => {
            const saved = localStorage.getItem(`pc-card-size-${el.id}`) || '1';
            applyCardSize(el.id, saved);
        });

        // 4. Dynamic Network cards
        document.querySelectorAll('.net-iface-card').forEach(el => {
            const saved = localStorage.getItem(`pc-card-size-${el.id}`) || '1';
            applyCardSize(el.id, saved);
        });
    }

    function applyCardSize(cardId, size) {
        const el = $(cardId);
        if (!el) return;
        el.classList.remove('card-size-1', 'card-size-2', 'card-size-full', 'span-2', 'span-full');
        if (size === 'full') {
            el.classList.add('card-size-full');
        } else if (size == 2) {
            el.classList.add('card-size-2');
        } else {
            el.classList.add('card-size-1');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CARD VISIBILITY
    // ═══════════════════════════════════════════════════════════════
    function applyCardVisibility() {
        // 1. Static panels
        CARD_REGISTRY.forEach(card => {
            const isHidden = localStorage.getItem(`pc-card-hidden-${card.id}`) === 'true';
            const el = $(card.id);
            if (el) el.style.display = isHidden ? 'none' : '';
        });

        // 2. Custom/Default groups
        const groups = getCardGroups();
        groups.forEach(g => {
            const isHidden = localStorage.getItem(`pc-card-hidden-${g.id}`) === 'true';
            const el = $(g.id);
            if (el) el.style.display = isHidden ? 'none' : '';
        });

        // 3. Dynamic GPU cards
        document.querySelectorAll('.gpu-card').forEach(el => {
            const isHidden = localStorage.getItem(`pc-card-hidden-${el.id}`) === 'true';
            el.style.display = isHidden ? 'none' : '';
        });

        // 4. Dynamic Network cards
        document.querySelectorAll('.net-iface-card').forEach(el => {
            const isHidden = localStorage.getItem(`pc-card-hidden-${el.id}`) === 'true';
            el.style.display = isHidden ? 'none' : '';
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // COMPONENT VISIBILITY
    // ═══════════════════════════════════════════════════════════════
    function applyComponentVisibility() {
        CARD_REGISTRY.forEach(card => {
            card.components.forEach(comp => {
                const isHidden = localStorage.getItem(`pc-comp-hidden-${comp.key}`) === 'true';
                const els = document.querySelectorAll(`[data-component="${comp.key}"]`);
                els.forEach(el => {
                    if (isHidden) {
                        el.classList.add('component-hidden');
                    } else {
                        el.classList.remove('component-hidden');
                    }
                });
            });
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // CARD GROUPS
    // ═══════════════════════════════════════════════════════════════
    function getCardGroups() {
        try {
            const val = localStorage.getItem('pc-card-groups');
            if (val === null) {
                const defaults = [
                    { id: 'gpu-group', name: 'GPU Group', cards: [] },
                    { id: 'network-group', name: 'Network Group', cards: [] }
                ];
                localStorage.setItem('pc-card-groups', JSON.stringify(defaults));
                return defaults;
            }
            return JSON.parse(val || '[]');
        } catch { return []; }
    }

    function saveCardGroups(groups) {
        localStorage.setItem('pc-card-groups', JSON.stringify(groups));
    }

    function createCardGroup(name) {
        const groups = getCardGroups();
        const id = 'group-' + Date.now();
        groups.push({ id, name, cards: [] });
        saveCardGroups(groups);

        // Create group DOM element in the grid
        const grid = document.querySelector('.dashboard-grid');
        if (!grid) return;

        const groupEl = document.createElement('div');
        groupEl.className = 'card-group';
        groupEl.id = id;
        groupEl.innerHTML = `
            <div class="card-group-header">
                <div class="group-name">📁 ${escapeHtml(name)}</div>
                <div class="group-actions">
                    <button class="group-collapse-btn" title="Collapse">−</button>
                </div>
            </div>
            <div class="card-group-body"></div>
        `;
        grid.appendChild(groupEl);
        setupGroupDropZone(groupEl);
        setupGroupCollapse(groupEl);
        bindDragEventsToElement(groupEl);
        if (resizeObserver) resizeObserver.observe(groupEl);
        resizeGridItems();
    }

    function deleteCardGroup(groupId) {
        const groups = getCardGroups();
        const group = groups.find(g => g.id === groupId);
        if (!group) return;

        // Move cards back to main grid
        const groupEl = $(groupId);
        const grid = document.querySelector('.dashboard-grid');
        if (groupEl && grid) {
            const cards = groupEl.querySelectorAll('.card');
            cards.forEach(card => grid.insertBefore(card, groupEl));
            groupEl.remove();
        }

        saveCardGroups(groups.filter(g => g.id !== groupId));
        saveCardOrder();
        populateLayoutTab();
    }

    function initCardGroups() {
        const groups = getCardGroups();
        const grid = document.querySelector('.dashboard-grid');
        if (!grid) return;

        groups.forEach(group => {
            let groupEl = $(group.id);
            if (!groupEl) {
                groupEl = document.createElement('div');
                groupEl.className = 'card-group';
                groupEl.id = group.id;

                if (group.id === 'gpu-group') {
                    groupEl.innerHTML = `
                        <div class="card-group-header">
                            <div class="group-name">🎮 GPU Group</div>
                            <div class="group-actions">
                                <span class="card-badge badge badge-green" id="gpu-count-badge" style="font-size: 0.7rem; margin-right: 8px;">0 GPUs</span>
                                <button class="group-collapse-btn" title="Collapse">−</button>
                            </div>
                        </div>
                        <div class="card-group-body" id="gpu-cards" data-component="gpu-cards">
                            <div class="gpu-placeholder" style="grid-column: span 2; text-align: center; padding: 20px; width: 100%;">
                                <span class="text-muted">Detecting GPUs...</span>
                            </div>
                        </div>
                    `;
                } else if (group.id === 'network-group') {
                    groupEl.innerHTML = `
                        <div class="card-group-header">
                            <div class="group-name">🌐 Network Group</div>
                            <div class="group-actions">
                                <span class="card-badge badge badge-cyan" id="net-status-badge" style="font-size: 0.7rem; margin-right: 8px;">—</span>
                                <button class="group-collapse-btn" title="Collapse">−</button>
                            </div>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 12px; width: 100%; padding: 0 8px;">
                            <div class="net-stats-row" id="net-stats-row" data-component="net-stats" style="margin-bottom: 0;">
                                <div class="net-stat">
                                    <span class="net-stat-icon text-green">▼</span>
                                    <div>
                                        <span class="stat-label">DOWNLOAD</span>
                                        <span class="stat-value mono" id="net-download">0 B/s</span>
                                    </div>
                                </div>
                                <div class="net-stat">
                                    <span class="net-stat-icon text-violet">▲</span>
                                    <div>
                                        <span class="stat-label">UPLOAD</span>
                                        <span class="stat-value mono" id="net-upload">0 B/s</span>
                                    </div>
                                </div>
                                <div class="net-stat">
                                    <span class="net-stat-icon text-cyan">↕</span>
                                    <div>
                                        <span class="stat-label">TOTAL RX</span>
                                        <span class="stat-value mono" id="net-total-rx">0 B</span>
                                    </div>
                                </div>
                                <div class="net-stat">
                                    <span class="net-stat-icon text-amber">↕</span>
                                    <div>
                                        <span class="stat-label">TOTAL TX</span>
                                        <span class="stat-value mono" id="net-total-tx">0 B</span>
                                    </div>
                                </div>
                            </div>
                            <div class="chart-container chart-md" data-component="net-chart">
                                <canvas id="network-chart"></canvas>
                            </div>
                        </div>
                        <div class="card-group-body" id="net-interfaces" data-component="net-interfaces" style="margin-top: 12px;"></div>
                    `;
                } else {
                    groupEl.innerHTML = `
                        <div class="card-group-header">
                            <div class="group-name">📁 ${group.name}</div>
                            <div class="group-actions">
                                <button class="group-collapse-btn" title="Collapse">−</button>
                            </div>
                        </div>
                        <div class="card-group-body"></div>
                    `;
                }
                grid.appendChild(groupEl);
            }

            // Move assigned cards into group body
            const body = groupEl.querySelector('.card-group-body');
            if (body) {
                group.cards.forEach(cardId => {
                    const card = $(cardId);
                    if (card) {
                        stripCardSizes(card);
                        body.appendChild(card);
                    }
                });
            }

            setupGroupDropZone(groupEl);
            setupGroupCollapse(groupEl);
        });
    }

    function setupGroupCollapse(groupEl) {
        const collapseBtn = groupEl.querySelector('.group-collapse-btn');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', () => {
                groupEl.classList.toggle('collapsed');
                collapseBtn.textContent = groupEl.classList.contains('collapsed') ? '+' : '−';
                resizeGridItems();
            });
        }
    }

    function setupGroupDropZone(groupEl) {
        const body = groupEl.querySelector('.card-group-body');
        if (!body) return;

        groupEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            groupEl.classList.add('drag-over');
        });

        groupEl.addEventListener('dragleave', (e) => {
            if (!groupEl.contains(e.relatedTarget)) {
                groupEl.classList.remove('drag-over');
            }
        });

        groupEl.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            groupEl.classList.remove('drag-over');
            const cardId = e.dataTransfer.getData('text/plain');
            const card = $(cardId);
            if (card && !card.classList.contains('card-group')) {
                stripCardSizes(card);
                body.appendChild(card);
                updateGroupMembership();
                saveCardOrder();
            }
        });
    }

    function updateGroupMembership() {
        const groups = getCardGroups();
        groups.forEach(group => {
            const groupEl = $(group.id);
            if (groupEl) {
                const body = groupEl.querySelector('.card-group-body');
                group.cards = body ? Array.from(body.querySelectorAll('.card')).map(c => c.id) : [];
            }
        });
        saveCardGroups(groups);

        // Save built-in GPU group card order
        const gpuBody = $('gpu-cards');
        if (gpuBody) {
            const gpuCards = Array.from(gpuBody.querySelectorAll('.card')).map(c => c.id);
            localStorage.setItem('pc-group-cards-gpu-group', JSON.stringify(gpuCards));
        }

        // Save built-in Network group card order
        const netBody = $('net-interfaces');
        if (netBody) {
            const netCards = Array.from(netBody.querySelectorAll('.card')).map(c => c.id);
            localStorage.setItem('pc-group-cards-network-group', JSON.stringify(netCards));
        }

        renderGroupList();
        populateLayoutTab();
        resizeGridItems();
    }

    // Helper to strip layout sizing classes when card is grouped
    function stripCardSizes(el) {
        if (!el) return;
        el.classList.remove('card-size-1', 'card-size-2', 'card-size-full', 'span-2', 'span-full');
        el.style.gridRowEnd = '';
    }

    function bindDragEventsToElement(card) {
        const grid = document.querySelector('.dashboard-grid');
        if (!grid) return;

        const locked = localStorage.getItem('pc-layout-locked') === 'true';
        card.setAttribute('draggable', locked ? 'false' : 'true');
        if (locked) card.classList.add('layout-locked');

        const header = card.querySelector('.card-header') || card.querySelector('.gpu-card-header') || card.querySelector('.net-iface-header') || card.querySelector('.card-group-header');
        if (header) {
            header.style.cursor = locked ? 'default' : 'grab';
        }

        card.addEventListener('dragstart', (e) => {
            if (card.classList.contains('layout-locked')) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.setData('text/plain', card.id);
            e.dataTransfer.effectAllowed = 'move';
            requestAnimationFrame(() => card.classList.add('dragging'));
        });

        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            
            // If the card is now a direct child of grid, restore its configured size
            if (card.parentNode === grid) {
                const savedSize = localStorage.getItem(`pc-card-size-${card.id}`) || '1';
                applyCardSize(card.id, savedSize);
            }
            
            updateGroupMembership();
            saveCardOrder();
        });

        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const dragging = document.querySelector('.dragging');
            if (!dragging || dragging === card) return;

            card.classList.add('drag-over');

            const bounding = card.getBoundingClientRect();
            const parent = card.parentNode;

            if (parent === grid || parent.classList.contains('card-group-body')) {
                const mouseX = e.clientX;
                const mouseY = e.clientY;
                const cardCenterX = bounding.left + bounding.width / 2;
                const cardCenterY = bounding.top + bounding.height / 2;

                const draggingRect = dragging.getBoundingClientRect();
                const isSameRow = Math.abs(bounding.top - draggingRect.top) < 100;

                const insertAfter = isSameRow ? mouseX > cardCenterX : mouseY > cardCenterY;

                if (parent.classList.contains('card-group-body')) {
                    stripCardSizes(dragging);
                }

                if (insertAfter) {
                    card.after(dragging);
                } else {
                    card.before(dragging);
                }
            }
        });

        card.addEventListener('dragleave', () => {
            card.classList.remove('drag-over');
        });

        card.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            card.classList.remove('drag-over');
        });
    }

    function restoreDynamicCardsLayout() {
        const savedOrder = localStorage.getItem('pc-dashboard-card-order');
        if (!savedOrder) return;
        try {
            const order = JSON.parse(savedOrder);
            const grid = document.querySelector('.dashboard-grid');
            if (!grid) return;

            order.forEach(id => {
                const el = document.getElementById(id);
                if (el && el.parentNode !== grid && order.includes(id)) {
                    grid.appendChild(el);
                }
            });

            const groups = getCardGroups();
            groups.forEach(group => {
                const groupEl = $(group.id);
                if (groupEl) {
                    const body = groupEl.querySelector('.card-group-body');
                    if (body) {
                        group.cards.forEach(cardId => {
                            const card = $(cardId);
                            if (card && card.parentNode !== body) {
                                stripCardSizes(card);
                                body.appendChild(card);
                            }
                        });
                    }
                }
            });

            // Restore built-in GPU group card order
            const gpuOrder = JSON.parse(localStorage.getItem('pc-group-cards-gpu-group') || '[]');
            const gpuBody = $('gpu-cards');
            if (gpuBody && gpuOrder.length > 0) {
                gpuOrder.forEach(id => {
                    const card = $(id);
                    if (card && card.parentNode === gpuBody) {
                        stripCardSizes(card);
                        gpuBody.appendChild(card);
                    }
                });
            }

            // Restore built-in Network group card order
            const netOrder = JSON.parse(localStorage.getItem('pc-group-cards-network-group') || '[]');
            const netBody = $('net-interfaces');
            if (netBody && netOrder.length > 0) {
                netOrder.forEach(id => {
                    const card = $(id);
                    if (card && card.parentNode === netBody) {
                        stripCardSizes(card);
                        netBody.appendChild(card);
                    }
                });
            }

            applyCardSizes();
            applyCardVisibility();
            renderGroupList();
            populateLayoutTab();
            resizeGridItems();
        } catch (e) {
            console.error('Error restoring dynamic cards layout:', e);
        }
    }

    let dragScrollTimer = null;
    let dragScrollSpeed = 0;

    function handleDragScroll(e) {
        if (e.clientY === 0 && e.clientX === 0) return;

        const threshold = 80;
        const maxSpeed = 15;
        const mouseY = e.clientY;
        const viewportHeight = window.innerHeight;

        if (mouseY < threshold) {
            dragScrollSpeed = -Math.round((threshold - mouseY) / threshold * maxSpeed);
        } else if (mouseY > viewportHeight - threshold) {
            dragScrollSpeed = Math.round((mouseY - (viewportHeight - threshold)) / threshold * maxSpeed);
        } else {
            dragScrollSpeed = 0;
        }

        if (dragScrollSpeed !== 0) {
            if (!dragScrollTimer) {
                const scrollLoop = () => {
                    const dragging = document.querySelector('.dragging');
                    if (dragging && dragScrollSpeed !== 0) {
                        window.scrollBy(0, dragScrollSpeed);
                        dragScrollTimer = requestAnimationFrame(scrollLoop);
                    } else {
                        dragScrollTimer = null;
                        dragScrollSpeed = 0;
                    }
                };
                dragScrollTimer = requestAnimationFrame(scrollLoop);
            }
        } else {
            if (dragScrollTimer) {
                cancelAnimationFrame(dragScrollTimer);
                dragScrollTimer = null;
            }
        }
    }

    function stopDragScroll() {
        if (dragScrollTimer) {
            cancelAnimationFrame(dragScrollTimer);
            dragScrollTimer = null;
        }
        dragScrollSpeed = 0;
    }

    function initCardDragAndDrop() {
        const grid = document.querySelector('.dashboard-grid');
        if (!grid) return;

        grid.querySelectorAll('.card, .card-group').forEach(item => {
            bindDragEventsToElement(item);
        });

        // Safe auto-scroll bindings
        document.addEventListener('dragover', (e) => {
            const dragging = document.querySelector('.dragging');
            if (dragging) {
                handleDragScroll(e);
            }
        });

        document.addEventListener('dragend', () => {
            stopDragScroll();
        });

        grid.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        grid.addEventListener('drop', (e) => {
            // If dropped inside a card group container, let the group's drop handler handle it
            if (e.target.closest('.card-group')) {
                return;
            }

            const cardId = e.dataTransfer.getData('text/plain');
            const card = $(cardId);
            if (card && card.parentNode !== grid && !card.parentNode.classList.contains('dashboard-grid')) {
                grid.appendChild(card);
                
                const savedSize = localStorage.getItem(`pc-card-size-${card.id}`) || '1';
                applyCardSize(card.id, savedSize);

                updateGroupMembership();
                saveCardOrder();
            }
        });

        loadCardOrder();
    }

    function saveCardOrder() {
        const grid = document.querySelector('.dashboard-grid');
        if (!grid) return;
        const items = grid.querySelectorAll(':scope > .card, :scope > .card-group');
        const order = Array.from(items).map(el => el.id);
        localStorage.setItem('pc-dashboard-card-order', JSON.stringify(order));
        resizeGridItems();
    }

    function loadCardOrder() {
        const saved = localStorage.getItem('pc-dashboard-card-order');
        if (!saved) return;
        try {
            const order = JSON.parse(saved);
            const grid = document.querySelector('.dashboard-grid');
            if (!grid) return;
            order.forEach(id => {
                const el = document.getElementById(id);
                if (el) grid.appendChild(el);
            });
            resizeGridItems();
        } catch (e) {
            console.error('Error loading card order:', e);
        }
    }

    function initCharts() {
        const DC = window.DashCharts;
        if (!DC) {
            console.error('DashCharts not loaded');
            return;
        }

        // Create rolling buffers
        buffers.cpu = new DC.RollingBuffer(CONFIG.HISTORY_LENGTH);
        buffers.ram = new DC.RollingBuffer(CONFIG.HISTORY_LENGTH);
        buffers.netRx = new DC.RollingBuffer(CONFIG.HISTORY_LENGTH);
        buffers.netTx = new DC.RollingBuffer(CONFIG.HISTORY_LENGTH);

        // Create charts only if their canvas elements exist in the DOM
        if (document.getElementById('cpu-chart')) {
            charts.cpu = DC.createCpuChart('cpu-chart');
        }
        if (document.getElementById('ram-history-chart')) {
            charts.ramHistory = DC.createCpuChart('ram-history-chart', '#a855f7', 'rgba(168, 85, 247, ');
        }
        if (document.getElementById('network-chart')) {
            charts.network = DC.createNetworkChart('network-chart');
        }
    }

    function initEventListeners() {
        // Process search
        const processSearch = $('process-search');
        if (processSearch) {
            processSearch.addEventListener('input', (e) => {
                state.processSearch = e.target.value.toLowerCase();
                renderProcesses(state.lastProcesses);
            });
        }

        // Service search
        const serviceSearch = $('service-search');
        if (serviceSearch) {
            serviceSearch.addEventListener('input', (e) => {
                state.serviceSearch = e.target.value.toLowerCase();
                renderServices(state.lastServices);
            });
        }

        // Service filter buttons
        $$('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                $$('.filter-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                state.serviceFilter = e.target.dataset.filter;
                renderServices(state.lastServices);
            });
        });

        // Process table sort headers
        $$('.sortable').forEach(th => {
            th.addEventListener('click', (e) => {
                const key = e.target.dataset.sort;
                if (state.processSort.key === key) {
                    state.processSort.direction = state.processSort.direction === 'desc' ? 'asc' : 'desc';
                } else {
                    state.processSort.key = key;
                    state.processSort.direction = 'desc';
                }
                $$('.sortable').forEach(h => h.classList.remove('active-sort', 'sort-asc', 'sort-desc'));
                e.target.classList.add('active-sort', `sort-${state.processSort.direction}`);
                renderProcesses(state.lastProcesses);
            });
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // WEBSOCKET CONNECTION
    // ═══════════════════════════════════════════════════════════════
    function connectWebSocket() {
        if (state.ws) {
            state.ws.close();
        }

        state.ws = new WebSocket(CONFIG.WS_URL);

        state.ws.onopen = () => {
            state.connected = true;
            state.reconnectAttempts = 0;
            updateConnectionStatus(true);
            console.log('[PC Live Dash] Connected to server');
        };

        state.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                handleMessage(message);
            } catch (err) {
                console.error('[PC Live Dash] Failed to parse message:', err);
            }
        };

        state.ws.onclose = () => {
            state.connected = false;
            updateConnectionStatus(false);
            console.log('[PC Live Dash] Disconnected — reconnecting...');
            scheduleReconnect();
        };

        state.ws.onerror = (err) => {
            console.error('[PC Live Dash] WebSocket error:', err);
        };
    }

    function scheduleReconnect() {
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        const delay = Math.min(
            CONFIG.RECONNECT_DELAY * Math.pow(1.5, state.reconnectAttempts),
            CONFIG.MAX_RECONNECT_DELAY
        );
        state.reconnectAttempts++;
        state.reconnectTimer = setTimeout(connectWebSocket, delay);
    }

    function updateConnectionStatus(connected) {
        const bar = $('connection-bar');
        const dot = $('status-dot');
        const text = $('status-text');

        if (connected) {
            bar.className = 'connection-bar connected';
            dot.className = 'status-dot connected';
            text.textContent = 'Connected';
        } else {
            bar.className = 'connection-bar disconnected';
            dot.className = 'status-dot disconnected';
            text.textContent = 'Reconnecting...';
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // MESSAGE HANDLER
    // ═══════════════════════════════════════════════════════════════
    // Tables are rebuilt on every medium and slow message. While the tab is in
    // the background only the newest of each is kept and applied on return.
    const deferredMessages = {};

    function handleMessage(msg) {
        if (document.hidden && (msg.type === 'medium' || msg.type === 'slow')) {
            deferredMessages[msg.type] = msg;
            return;
        }
        applyMessage(msg);
    }

    function flushDeferredMessages() {
        if (document.hidden) return;
        ['medium', 'slow'].forEach(type => {
            const msg = deferredMessages[type];
            delete deferredMessages[type];
            if (msg) applyMessage(msg);
        });
    }

    function applyMessage(msg) {
        switch (msg.type) {
            case 'static':
                handleStaticData(msg.data);
                break;
            case 'fast':
                handleFastData(msg.data);
                break;
            case 'medium':
                handleMediumData(msg.data);
                break;
            case 'slow':
                handleSlowData(msg.data);
                break;
            default:
                console.warn('[PC Live Dash] Unknown message type:', msg.type);
        }
        scheduleGridResize();
    }

    // Several messages can arrive in one frame: measure the grid once per frame.
    let gridResizeQueued = false;
    function scheduleGridResize() {
        if (gridResizeQueued) return;
        gridResizeQueued = true;
        requestAnimationFrame(() => {
            gridResizeQueued = false;
            resizeGridItems();
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // STATIC DATA (once on connect)
    // ═══════════════════════════════════════════════════════════════
    function handleStaticData(data) {
        state.staticData = data;

        // System bar
        if (data.osInfo) {
            setText('val-hostname', data.osInfo.hostname || '—');
            setText('val-os', `${data.osInfo.distro || ''} ${data.osInfo.release || ''}`.trim() || '—');
            setText('val-arch', data.osInfo.arch || '—');
        }

        // CPU info
        if (data.cpu) {
            setText('val-cpu-model', `${data.cpu.manufacturer || ''} ${data.cpu.brand || ''}`.trim() || '—');
            setText('cpu-cores', data.cpu.physicalCores || '—');
            setText('cpu-threads', data.cpu.cores || '—');
        }

        // Network interfaces
        if (data.networkInterfaces) {
            renderNetworkInterfaces(data.networkInterfaces);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // FAST DATA (every 2 seconds)
    // ═══════════════════════════════════════════════════════════════
    function handleFastData(data) {
        const DC = window.DashCharts;

        // ── CPU ──
        if (data.currentLoad) {
            const load = Math.round(data.currentLoad.currentLoad || 0);
            updateGauge('cpu-gauge', 'cpu-gauge-value', load, 'cyan');
            setText('cpu-badge', `${load}%`);

            // Alert state
            const cpuPanel = $('cpu-panel');
            if (cpuPanel) {
                cpuPanel.classList.toggle('alert-warning', load >= 80 && load < CONFIG.ALERT_CPU_THRESHOLD);
                cpuPanel.classList.toggle('alert-danger', load >= CONFIG.ALERT_CPU_THRESHOLD);
            }

            // History chart
            if (charts.cpu && buffers.cpu) {
                DC.updateLineChart(charts.cpu, buffers.cpu, load);
            }

            // Per-core bars
            if (data.currentLoad.cpus) {
                renderCoreBars(data.currentLoad.cpus);
            }
        }

        // ── CPU Speed ──
        if (data.cpuCurrentSpeed) {
            setText('cpu-speed', `${(data.cpuCurrentSpeed.avg || 0).toFixed(2)} GHz`);
        }

        // ── CPU Temperature ──
        if (data.cpuTemperature) {
            setCpuTemp(data.cpuTemperature);
            updateTemperatures(data.cpuTemperature, 'cpu');
        }

        // ── RAM ──
        if (data.mem) {
            const usedPercent = Math.round((data.mem.active / data.mem.total) * 100);
            updateGauge('ram-gauge', 'ram-gauge-value', usedPercent, 'violet');
            setText('ram-badge', `${usedPercent}%`);
            setText('ram-used', DC.formatBytes(data.mem.active));
            setText('ram-total', DC.formatBytes(data.mem.total));
            setText('ram-free', DC.formatBytes(data.mem.free));
            setText('ram-cached', DC.formatBytes(data.mem.buffcache || 0));

            // Swap
            if (data.mem.swaptotal > 0) {
                const swapPercent = Math.round((data.mem.swapused / data.mem.swaptotal) * 100);
                setText('swap-info', `${DC.formatBytes(data.mem.swapused)} / ${DC.formatBytes(data.mem.swaptotal)}`);
                const swapFill = $('swap-fill');
                if (swapFill) swapFill.style.width = `${swapPercent}%`;
            } else {
                setText('swap-info', 'Not configured');
            }

            // Alert state
            const ramPanel = $('ram-panel');
            if (ramPanel) {
                ramPanel.classList.toggle('alert-warning', usedPercent >= 75 && usedPercent < CONFIG.ALERT_RAM_THRESHOLD);
                ramPanel.classList.toggle('alert-danger', usedPercent >= CONFIG.ALERT_RAM_THRESHOLD);
            }

            // History chart
            if (charts.ramHistory && buffers.ram) {
                DC.updateLineChart(charts.ramHistory, buffers.ram, usedPercent);
            }
        }

        // ── Network ──
        if (data.networkStats && data.networkStats.length > 0) {
            let totalRx = 0, totalTx = 0, totalRxBytes = 0, totalTxBytes = 0;
            data.networkStats.forEach(iface => {
                if (iface.rx_sec !== null) totalRx += iface.rx_sec;
                if (iface.tx_sec !== null) totalTx += iface.tx_sec;
                totalRxBytes += iface.rx_bytes || 0;
                totalTxBytes += iface.tx_bytes || 0;
            });

            setText('net-download', DC.formatSpeed(totalRx));
            setText('net-upload', DC.formatSpeed(totalTx));
            setText('net-total-rx', DC.formatBytes(totalRxBytes));
            setText('net-total-tx', DC.formatBytes(totalTxBytes));
            setText('net-status-badge', totalRx > 0 || totalTx > 0 ? 'Active' : 'Idle');

            // Network chart
            if (charts.network && buffers.netRx && buffers.netTx) {
                DC.updateNetworkChart(charts.network, buffers.netRx, buffers.netTx, totalRx, totalTx);
            }

            // Update interface stats
            updateInterfaceStats(data.networkStats);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // MEDIUM DATA (every 5 seconds)
    // ═══════════════════════════════════════════════════════════════
    function handleMediumData(data) {
        const DC = window.DashCharts;

        // ── Processes ──
        if (data.processes && data.processes.list) {
            state.lastProcesses = data.processes.list;
            setText('process-count', `${data.processes.all || data.processes.list.length} processes`);
            renderProcesses(data.processes.list);

            // Running apps (processes with a window/GUI)
            renderRunningApps(data.processes.list);
        }

        // ── Disk Usage ──
        if (data.fsSize) {
            renderDiskUsage(data.fsSize);
        }

        // ── Disk I/O ──
        if (data.disksIO) {
            const io = data.disksIO;
            setText('disk-read-speed', io.readBytesSec != null ? DC.formatSpeed(io.readBytesSec) : '—');
            setText('disk-write-speed', io.writeBytesSec != null ? DC.formatSpeed(io.writeBytesSec) : '—');
            setText('disk-io-badge', io.iops != null ? `${Math.round(io.iops)} IOPS` : '—');
        }

        // ── GPU ──
        if (data.graphics && data.graphics.controllers) {
            renderGpuCards(data.graphics.controllers);
        }

        // ── CPU Speed (moved to medium tier for performance) ──
        if (data.cpuCurrentSpeed) {
            setText('cpu-speed', `${(data.cpuCurrentSpeed.avg || 0).toFixed(2)} GHz`);
        }

        // ── CPU Temperature (moved to medium tier for performance) ──
        if (data.cpuTemperature) {
            state.cpuTemperature = data.cpuTemperature;
            setCpuTemp(data.cpuTemperature);
        }
        updateTemperatures();
    }

    // ═══════════════════════════════════════════════════════════════
    // SLOW DATA (every 15 seconds)
    // ═══════════════════════════════════════════════════════════════
    function handleSlowData(data) {
        const DC = window.DashCharts;

        // ── Uptime ──
        if (data.time) {
            setText('val-uptime', DC.formatUptime(data.time.uptime));
        }

        // ── Battery ──
        if (data.battery) {
            renderBattery(data.battery);
        }

        // ── Services ──
        if (data.services) {
            state.lastServices = data.services;
            renderServices(data.services);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // RENDER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    // ── Gauge Update ──
    function updateGauge(gaugeId, valueId, percent, color) {
        const gauge = $(gaugeId);
        const valueEl = $(valueId);
        if (gauge) {
            gauge.style.setProperty('--gauge-percent', `${percent * 3.6}deg`);
        }
        if (valueEl) {
            animateNumber(valueEl, percent);
        }
    }

    // ── Number Animation ──
    function animateNumber(el, target) {
        const current = parseInt(el.textContent) || 0;
        if (current === target) return;
        el.textContent = target;
    }

    // ── CPU Core Bars ──
    function renderCoreBars(cores) {
        const container = $('cpu-core-bars');
        if (!container) return;

        if (container.children.length !== cores.length) {
            container.innerHTML = cores.map((_, i) => `
                <div class="core-bar-item">
                    <span class="core-bar-label mono">C${i}</span>
                    <div class="core-bar-track">
                        <div class="core-bar-fill" id="core-bar-${i}" style="width: 0%"></div>
                    </div>
                    <span class="core-bar-value mono" id="core-val-${i}">0%</span>
                </div>
            `).join('');
        }

        cores.forEach((core, i) => {
            const load = Math.round(core.load || 0);
            const fill = $(`core-bar-${i}`);
            const val = $(`core-val-${i}`);
            if (fill) {
                fill.style.width = `${load}%`;
                fill.className = `core-bar-fill ${getLoadColorClass(load)}`;
            }
            if (val) val.textContent = `${load}%`;
        });
    }

    // ── GPU Cards ──
    function renderGpuCards(controllers) {
        let container = $('gpu-cards');
        const grid = document.querySelector('.dashboard-grid');
        if (!container) {
            container = grid;
        }
        if (!container) return;

        const DC = window.DashCharts;
        setText('gpu-count-badge', `${controllers.length} GPU${controllers.length !== 1 ? 's' : ''}`);

        // Update state controllers reference
        state.gpuControllers = controllers;

        // Initialize GPU charts only once
        const existingCount = document.querySelectorAll('.gpu-card').length;
        if (!state.gpuChartsInitialized || existingCount !== controllers.length) {
            // Clean up old ones first to prevent duplicates when re-rendering
            document.querySelectorAll('.gpu-card').forEach(el => el.remove());

            container.innerHTML = controllers.map((gpu, i) => `
                <div class="card gpu-card" id="gpu-card-${i}">
                    <div class="gpu-card-header">
                        <span class="gpu-name">${escapeHtml(formatGpuName(gpu))}</span>
                        <span class="badge badge-muted" id="gpu-badge-${i}">N/A</span>
                    </div>
                    <div class="gpu-card-body">
                        <div class="gpu-stats-row">
                            <div class="gauge-container gauge-sm">
                                <div class="gauge-ring gauge-green" id="gpu-gauge-${i}" style="--gauge-percent: ${(Number(gpu.utilizationGpu) || 0) * 3.6}deg">
                                    <div class="gauge-inner">
                                        <span class="gauge-value mono" id="gpu-gauge-val-${i}">${Math.round(gpu.utilizationGpu || 0)}</span>
                                        <span class="gauge-unit">%</span>
                                    </div>
                                </div>
                                <div class="gauge-label">Util</div>
                            </div>
                            <div class="stat-grid stat-grid-2">
                                <div class="stat-item">
                                    <span class="stat-label">VRAM</span>
                                    <span class="stat-value mono" id="gpu-vram-${i}">${escapeHtml(formatVram(gpu))}</span>
                                </div>
                                <div class="stat-item">
                                    <span class="stat-label">TEMP</span>
                                    <span class="stat-value mono" id="gpu-temp-${i}">${gpu.temperatureGpu != null ? `${Math.round(gpu.temperatureGpu)} °C` : 'N/A'}</span>
                                </div>
                                <div class="stat-item">
                                    <span class="stat-label">FAN</span>
                                    <span class="stat-value mono" id="gpu-fan-${i}">${escapeHtml(formatFan(gpu))}</span>
                                </div>
                                <div class="stat-item">
                                    <span class="stat-label">POWER</span>
                                    <span class="stat-value mono" id="gpu-power-${i}">${escapeHtml(formatPower(gpu))}</span>
                                </div>
                            </div>
                        </div>
                        <div class="gpu-charts-row">
                            <div class="chart-container chart-xs">
                                <div class="chart-label-mini">GPU Utilization</div>
                                <div class="chart-canvas-wrap"><canvas id="gpu-chart-${i}"></canvas></div>
                            </div>
                            <div class="chart-container chart-xs">
                                <div class="chart-label-mini">VRAM Usage</div>
                                <div class="chart-canvas-wrap"><canvas id="gpu-vram-chart-${i}"></canvas></div>
                            </div>
                        </div>
                    </div>
                </div>
            `).join('');

            // Initialize GPU charts and buffers
            state.gpuCharts = [];
            state.gpuBuffers = [];
            state.gpuVramCharts = [];
            state.gpuVramBuffers = [];
            controllers.forEach((_, i) => {
                const utilBuf = new DC.RollingBuffer(CONFIG.HISTORY_LENGTH);
                state.gpuBuffers.push(utilBuf);
                state.gpuCharts.push(DC.createCpuChart(`gpu-chart-${i}`, '#22c55e'));

                const vramBuf = new DC.RollingBuffer(CONFIG.HISTORY_LENGTH);
                state.gpuVramBuffers.push(vramBuf);
                state.gpuVramCharts.push(DC.createCpuChart(`gpu-vram-chart-${i}`, '#a855f7'));
            });
            state.gpuChartsInitialized = true;

            // Bind drag events and restore layouts for newly rendered cards
            container.querySelectorAll('.card').forEach(card => {
                bindDragEventsToElement(card);
                if (resizeObserver) resizeObserver.observe(card);
            });
            restoreDynamicCardsLayout();
        }

        // Update the readings. This also runs right after the cards are built,
        // so the first sample is plotted instead of being dropped.
        {
            controllers.forEach((gpu, i) => {
                const hasUtil = gpu.utilizationGpu != null;
                const util = Math.round(gpu.utilizationGpu || 0);
                const badge = $(`gpu-badge-${i}`);
                if (badge) {
                    badge.textContent = hasUtil ? `${util}%` : 'N/A';
                    badge.className = `badge ${hasUtil ? 'badge-green' : 'badge-muted'}`;
                }
                updateGauge(`gpu-gauge-${i}`, `gpu-gauge-val-${i}`, util, 'green');
                setText(`gpu-vram-${i}`, formatVram(gpu));
                setText(`gpu-temp-${i}`, gpu.temperatureGpu != null ? `${Math.round(gpu.temperatureGpu)} °C` : 'N/A');
                setText(`gpu-fan-${i}`, formatFan(gpu));
                setText(`gpu-power-${i}`, formatPower(gpu));

                // Update GPU utilization chart
                if (state.gpuCharts[i] && state.gpuBuffers[i]) {
                    DC.updateLineChart(state.gpuCharts[i], state.gpuBuffers[i], util);
                }

                // Update GPU VRAM chart
                if (state.gpuVramCharts[i] && state.gpuVramBuffers[i]) {
                    const vramPct = gpu.memoryTotal > 0 ? Math.round((gpu.memoryUsed / gpu.memoryTotal) * 100) : 0;
                    DC.updateLineChart(state.gpuVramCharts[i], state.gpuVramBuffers[i], vramPct);
                }
            });
        }

        // Trigger Temperature updates
        updateTemperatures();
    }

    // ── Network Interfaces ──
    function renderNetworkInterfaces(interfaces) {
        let container = $('net-interfaces');
        const grid = document.querySelector('.dashboard-grid');
        if (!container) {
            container = grid;
        }
        if (!container) return;

        const nonInternalIfaces = interfaces.filter(iface => !iface.internal);
        
        const existingCount = document.querySelectorAll('.net-iface-card').length;
        if (existingCount === nonInternalIfaces.length) {
            return;
        }

        // Clean up old ones first to prevent duplicates when re-rendering
        document.querySelectorAll('.net-iface-card').forEach(el => el.remove());

        container.innerHTML = nonInternalIfaces.map(iface => `
            <div class="card net-iface-card" id="net-iface-${sanitizeId(iface.iface)}">
                <div class="net-iface-header">
                    <span class="net-iface-name">${escapeHtml(iface.ifaceName || iface.iface)}</span>
                    <span class="badge ${iface.operstate === 'up' ? 'badge-running' : 'badge-stopped'}">${escapeHtml(iface.operstate || 'unknown')}</span>
                </div>
                <div class="net-iface-details">
                    <div class="stat-item-inline">
                        <span class="stat-label">TYPE</span>
                        <span class="stat-value mono">${escapeHtml(iface.type || '—')}</span>
                    </div>
                    <div class="stat-item-inline">
                        <span class="stat-label">IP</span>
                        <span class="stat-value mono">${escapeHtml(iface.ip4 || '—')}</span>
                    </div>
                    <div class="stat-item-inline">
                        <span class="stat-label">MAC</span>
                        <span class="stat-value mono">${escapeHtml(iface.mac || '—')}</span>
                    </div>
                    <div class="stat-item-inline">
                        <span class="stat-label">SPEED</span>
                        <span class="stat-value mono">${iface.speed ? `${escapeHtml(iface.speed)} Mbps` : '—'}</span>
                    </div>
                    <div class="stat-item-inline">
                        <span class="stat-label">DL</span>
                        <span class="stat-value mono net-iface-rx" id="rx-${sanitizeId(iface.iface)}">0 B/s</span>
                    </div>
                    <div class="stat-item-inline">
                        <span class="stat-label">UL</span>
                        <span class="stat-value mono net-iface-tx" id="tx-${sanitizeId(iface.iface)}">0 B/s</span>
                    </div>
                </div>
            </div>
        `).join('');

        // Bind drag events and restore layouts for newly rendered cards
        container.querySelectorAll('.card').forEach(card => {
            bindDragEventsToElement(card);
            if (resizeObserver) resizeObserver.observe(card);
        });
        restoreDynamicCardsLayout();
    }

    function updateInterfaceStats(networkStats) {
        const DC = window.DashCharts;
        networkStats.forEach(stat => {
            const rxEl = $(`rx-${sanitizeId(stat.iface)}`);
            const txEl = $(`tx-${sanitizeId(stat.iface)}`);
            if (rxEl) rxEl.textContent = DC.formatSpeed(stat.rx_sec || 0);
            if (txEl) txEl.textContent = DC.formatSpeed(stat.tx_sec || 0);
        });
    }

    // ── Disk Usage ──
    function renderDiskUsage(fsSize) {
        const container = $('disk-list');
        if (!container) return;

        const DC = window.DashCharts;
        // Filter out tiny/virtual filesystems
        const disks = fsSize.filter(d => d.size > 0);

        container.innerHTML = disks.map(disk => {
            const usePercent = Math.round(disk.use || 0);
            const colorClass = usePercent >= 95 ? 'danger' : usePercent >= 80 ? 'warning' : 'normal';
            const rSpeed = disk.readSpeed != null ? DC.formatSpeed(disk.readSpeed) : '0 B/s';
            const wSpeed = disk.writeSpeed != null ? DC.formatSpeed(disk.writeSpeed) : '0 B/s';
            return `
                <div class="disk-item">
                    <div class="disk-item-header">
                        <span class="disk-mount mono">${escapeHtml(disk.mount)}</span>
                        <span class="disk-usage-text mono ${colorClass === 'danger' ? 'text-red' : colorClass === 'warning' ? 'text-amber' : 'text-cyan'}">${usePercent}%</span>
                    </div>
                    <div class="progress-bar progress-${colorClass === 'danger' ? 'red' : colorClass === 'warning' ? 'amber' : 'cyan'}">
                        <div class="progress-fill" style="width: ${usePercent}%"></div>
                    </div>
                    <div class="disk-item-footer">
                        <span class="text-muted">${DC.formatBytes(disk.used)} / ${DC.formatBytes(disk.size)}</span>
                        <span class="text-muted" style="display: flex; gap: 8px; font-weight: 500;">
                            <span class="text-green">▼ ${rSpeed}</span>
                            <span class="text-amber">▲ ${wSpeed}</span>
                        </span>
                    </div>
                    <div class="disk-item-footer" style="margin-top: 2px;">
                        <span class="text-muted" style="font-size: 0.72rem;">${escapeHtml(disk.fs || '')} · ${escapeHtml(disk.type || '')}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    // ── Temperatures ──
    function updateTemperatures(cpuTemp, source) {
        const container = $('temp-grid');
        if (!container) return;

        if (cpuTemp) {
            state.cpuTemperature = cpuTemp;
        }

        let items = [];

        // CPU temperatures
        if (state.cpuTemperature) {
            const cpu = state.cpuTemperature;
            if (cpu.main !== null && cpu.main !== -1) {
                items.push({ label: cpu.estimated ? 'CPU Package (est.)' : 'CPU Package', temp: cpu.main, icon: '🔲' });
            }
            if (cpu.cores && cpu.cores.length > 0) {
                cpu.cores.forEach((temp, i) => {
                    if (temp !== null && temp !== -1) {
                        items.push({ label: `Core ${i}`, temp: temp, icon: '◻️' });
                    }
                });
            }
            if (cpu.max != null && cpu.max !== -1) {
                items.push({ label: 'CPU Max', temp: cpu.max, icon: '🔥' });
            }
        }

        // GPU temperatures
        if (state.gpuControllers && state.gpuControllers.length > 0) {
            state.gpuControllers.forEach((gpu, i) => {
                if (gpu.temperatureGpu !== null && gpu.temperatureGpu !== undefined && gpu.temperatureGpu !== -1) {
                    const label = gpu.model 
                        ? gpu.model.replace(/NVIDIA/i, '').replace(/GeForce/i, '').replace(/Graphics/i, '').trim() 
                        : `GPU ${i}`;
                    items.push({ label: `${label}`, temp: gpu.temperatureGpu, icon: '🎮' });
                }
            });
        }

        if (items.length === 0) {
            container.innerHTML = '<div class="temp-placeholder"><span class="text-muted">No temperature data available</span></div>';
            return;
        }

        container.innerHTML = items.map(item => {
            const colorClass = item.temp >= 90 ? 'text-red' : item.temp >= 75 ? 'text-amber' : item.temp >= 60 ? 'text-cyan' : 'text-green';
            const barPercent = Math.min((item.temp / 105) * 100, 100);
            const barColor = item.temp >= 90 ? 'red' : item.temp >= 75 ? 'amber' : item.temp >= 60 ? 'cyan' : 'green';
            return `
                <div class="temp-item">
                    <div class="temp-item-header">
                        <span>${item.icon} ${escapeHtml(item.label)}</span>
                        <span class="mono ${colorClass}">${Math.round(item.temp)}°C</span>
                    </div>
                    <div class="progress-bar progress-bar-thin progress-${barColor}">
                        <div class="progress-fill" style="width: ${barPercent}%"></div>
                    </div>
                </div>
            `;
        }).join('');

        // Update fans panel whenever temperatures change
        updateFans();
    }

    // ── Fans ──
    function updateFans() {
        const container = $('fans-grid');
        if (!container) return;

        let items = [];

        // 1. CPU Fan. No sensor is read: the RPM is estimated from CPU temperature.
        if (state.cpuTemperature && state.cpuTemperature.main != null && state.cpuTemperature.main !== -1) {
            const temp = state.cpuTemperature.main;
            const rpm = Math.round(600 + Math.max(0, temp - 38) * 33.3);
            const percent = Math.min(Math.round(((rpm - 600) / 1400) * 100), 100);
            items.push({
                label: 'CPU Fan (est.)',
                rpm: rpm,
                percent: Math.max(0, percent),
                icon: '🌀',
                color: 'cyan'
            });
        }

        // 2. GPU Fans
        if (state.gpuControllers && state.gpuControllers.length > 0) {
            state.gpuControllers.forEach((gpu, i) => {
                const label = gpu.model 
                    ? gpu.model.replace(/NVIDIA/i, '').replace(/GeForce/i, '').replace(/Graphics/i, '').trim() 
                    : `GPU ${i}`;
                
                // Skip GPUs that report no fan reading. RPM is estimated from the fan percentage.
                if (gpu.fanSpeed == null) return;
                const fanPercent = Number(gpu.fanSpeed) || 0;
                const rpm = Math.round((fanPercent / 100) * 3000);
                
                items.push({ 
                    label: `${label} Fan`, 
                    rpm: rpm, 
                    percent: fanPercent, 
                    icon: '🎮', 
                    color: fanPercent >= 75 ? 'red' : fanPercent >= 50 ? 'amber' : 'green' 
                });
            });
        }

        if (items.length === 0) {
            container.innerHTML = '<div class="temp-placeholder"><span class="text-muted">No fan data available</span></div>';
            return;
        }

        container.innerHTML = items.map(item => {
            const colorClass = item.percent >= 80 ? 'text-red' : item.percent >= 50 ? 'text-amber' : item.percent >= 25 ? 'text-cyan' : 'text-green';
            return `
                <div class="temp-item">
                    <div class="temp-item-header">
                        <span>${item.icon} ${escapeHtml(item.label)}</span>
                        <span class="mono ${colorClass}">≈ ${item.rpm} RPM <span class="text-muted" style="font-size: 0.72rem; margin-left: 4px;">(${item.percent}%)</span></span>
                    </div>
                    <div class="progress-bar progress-bar-thin progress-${item.color}">
                        <div class="progress-fill" style="width: ${item.percent}%"></div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // ── Battery ──
    function renderBattery(battery) {
        const DC = window.DashCharts;

        if (!battery.hasBattery) {
            const display = $('battery-display');
            if (display) display.innerHTML = '<div class="text-muted" style="text-align:center;padding:20px;">No battery detected — Desktop PC</div>';
            setText('battery-badge', 'N/A');
            return;
        }

        const percent = Math.round(battery.percent || 0);
        const isCharging = battery.isCharging;

        setText('battery-percent', `${percent}%`);
        setText('battery-status', isCharging ? '⚡ Charging' : 'On Battery');
        setText('battery-remaining', battery.timeRemaining > 0 ? DC.formatUptime(battery.timeRemaining * 60) : '—');
        setText('battery-cycles', battery.cycleCount || '—');

        // Health = (maxCapacity / designedCapacity) * 100
        const health = battery.maxCapacity && battery.designedCapacity
            ? Math.round((battery.maxCapacity / battery.designedCapacity) * 100)
            : null;
        setText('battery-health', health !== null ? `${health}%` : '—');

        // Battery level fill
        const level = $('battery-level');
        if (level) {
            level.style.width = `${percent}%`;
            level.className = `battery-level ${percent <= 20 ? 'battery-low' : percent <= 50 ? 'battery-mid' : 'battery-high'}`;
        }

        // Badge
        const badge = $('battery-badge');
        if (badge) {
            badge.textContent = isCharging ? `⚡ ${percent}%` : `${percent}%`;
            badge.className = `card-badge badge ${percent <= 20 ? 'badge-red' : percent <= 50 ? 'badge-amber' : 'badge-green'}`;
        }
    }

    // ── Processes Table ──
    function renderProcesses(processes) {
        const tbody = $('process-tbody');
        if (!tbody) return;

        const DC = window.DashCharts;

        // Filter
        let filtered = processes;
        if (state.processSearch) {
            filtered = filtered.filter(p =>
                (p.name && p.name.toLowerCase().includes(state.processSearch)) ||
                (p.command && p.command.toLowerCase().includes(state.processSearch)) ||
                (p.pid && p.pid.toString().includes(state.processSearch))
            );
        }

        // Sort
        const { key, direction } = state.processSort;
        filtered.sort((a, b) => {
            let valA = a[key] ?? 0;
            let valB = b[key] ?? 0;
            if (typeof valA === 'string') valA = valA.toLowerCase();
            if (typeof valB === 'string') valB = valB.toLowerCase();
            if (valA < valB) return direction === 'asc' ? -1 : 1;
            if (valA > valB) return direction === 'asc' ? 1 : -1;
            return 0;
        });

        // Limit to top N
        const limited = filtered.slice(0, CONFIG.PROCESS_PAGE_SIZE);

        // Render rows
        tbody.innerHTML = limited.map(proc => {
            const cpuClass = proc.cpu >= 50 ? 'text-red' : proc.cpu >= 20 ? 'text-amber' : '';
            const memClass = proc.mem >= 50 ? 'text-red' : proc.mem >= 20 ? 'text-amber' : '';
            return `
                <tr>
                    <td class="mono">${escapeHtml(proc.pid)}</td>
                    <td class="process-name" title="${escapeHtml(proc.command || proc.name || '')}">${escapeHtml(proc.name || '—')}</td>
                    <td class="mono ${cpuClass}">${(Number(proc.cpu) || 0).toFixed(1)}</td>
                    <td class="mono ${memClass}">${(Number(proc.mem) || 0).toFixed(1)}</td>
                    <td class="mono">${DC.formatBytes((proc.memRss || 0) * 1024)}</td>
                    <td><span class="badge badge-sm ${getStateBadgeClass(proc.state)}">${escapeHtml(proc.state || '—')}</span></td>
                    <td class="text-muted">${escapeHtml(proc.user || '—')}</td>
                </tr>
            `;
        }).join('');
    }

    // ── Running Apps ──
    function renderRunningApps(processes) {
        const container = $('apps-list');
        if (!container) return;

        // Filter for notable processes (high CPU or memory, not system processes)
        const apps = processes
            .filter(p => p.name && p.mem > 0.1 && !isSystemProcess(p.name))
            .sort((a, b) => (b.mem || 0) - (a.mem || 0))
            .slice(0, 30);

        setText('apps-count-badge', apps.length.toString());

        if (apps.length === 0) {
            container.innerHTML = '<div class="apps-placeholder"><span class="text-muted">No active applications</span></div>';
            return;
        }

        const DC = window.DashCharts;
        container.innerHTML = apps.map(app => `
            <div class="app-item">
                <div class="app-icon">${getAppIcon(app.name)}</div>
                <div class="app-info">
                    <span class="app-name">${escapeHtml(app.name)}</span>
                    <span class="app-details text-muted">PID ${escapeHtml(app.pid)} · ${DC.formatBytes((app.memRss || 0) * 1024)}</span>
                </div>
                <span class="app-cpu mono ${app.cpu >= 20 ? 'text-amber' : ''}">${(Number(app.cpu) || 0).toFixed(1)}%</span>
            </div>
        `).join('');
    }

    // ── Services Table ──
    function renderServices(services) {
        const tbody = $('service-tbody');
        if (!tbody) return;

        // Filter by status
        let filtered = services;
        if (state.serviceFilter === 'running') {
            filtered = filtered.filter(s => s.running);
        } else if (state.serviceFilter === 'stopped') {
            filtered = filtered.filter(s => !s.running);
        }

        // Search filter
        if (state.serviceSearch) {
            filtered = filtered.filter(s =>
                s.name && s.name.toLowerCase().includes(state.serviceSearch)
            );
        }

        // Sort: running first, then alphabetical
        filtered.sort((a, b) => {
            if (a.running !== b.running) return a.running ? -1 : 1;
            return (a.name || '').localeCompare(b.name || '');
        });

        const limited = filtered.slice(0, 200);
        const runningCount = services.filter(s => s.running).length;
        setText('service-count', `${runningCount} running / ${services.length} total`);

        tbody.innerHTML = limited.map(svc => `
            <tr>
                <td class="mono">${escapeHtml(svc.name || '—')}</td>
                <td><span class="badge badge-sm ${svc.running ? 'badge-running' : 'badge-stopped'}">${svc.running ? 'Running' : 'Stopped'}</span></td>
                <td class="text-muted">${escapeHtml(svc.startmode || '—')}</td>
                <td class="mono">${typeof svc.pcpu === 'number' ? svc.pcpu.toFixed(1) : '—'}</td>
                <td class="mono">${typeof svc.pmem === 'number' ? svc.pmem.toFixed(1) : '—'}</td>
            </tr>
        `).join('');
    }

    // ═══════════════════════════════════════════════════════════════
    // UTILITY FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    function setText(id, text) {
        const el = $(id);
        if (el) el.textContent = text;
    }

    // Escapes text for use in HTML content and in quoted attribute values.
    function escapeHtml(str) {
        return String(str ?? '').replace(/[&<>"'`]/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
        }[ch]));
    }

    function formatVram(gpu) {
        return gpu.memoryUsed != null ? `${gpu.memoryUsed}/${gpu.memoryTotal} MB` : 'N/A';
    }

    // "NVIDIA" + "NVIDIA GeForce RTX 4070" would repeat the vendor, so the
    // vendor is only added when the model name does not already carry it.
    function formatGpuName(gpu) {
        const model = (gpu.model || '').trim();
        const vendor = (gpu.vendor || '').trim();
        if (!model) return vendor ? `${vendor} GPU` : 'Unknown GPU';
        if (!vendor) return model;
        const firstWord = vendor.split(/\s+/)[0].toLowerCase();
        return model.toLowerCase().includes(firstWord) ? model : `${vendor} ${model}`;
    }

    function formatFan(gpu) {
        return gpu.fanSpeed != null ? `${gpu.fanSpeed}%` : 'N/A';
    }

    function formatPower(gpu) {
        if (gpu.powerDraw == null) return 'N/A';
        return gpu.powerDrawEstimated ? `≈ ${gpu.powerDraw} W est.` : `${gpu.powerDraw} W`;
    }

    // Shows the CPU temperature and marks the label when the server estimated it.
    function setCpuTemp(cpuTemp) {
        const el = $('cpu-temp');
        if (!el) return;
        const temp = cpuTemp.main;
        const hasTemp = temp != null && temp !== -1;
        const estimated = hasTemp && cpuTemp.estimated;
        el.textContent = hasTemp ? `${estimated ? '≈ ' : ''}${Math.round(temp)} °C` : 'N/A';
        const label = el.previousElementSibling;
        if (label) label.textContent = estimated ? 'TEMP (EST.)' : 'TEMP';
    }

    function sanitizeId(str) {
        return (str || '').replace(/[^a-zA-Z0-9-_]/g, '_');
    }

    function getLoadColorClass(load) {
        if (load >= 90) return 'core-bar-danger';
        if (load >= 70) return 'core-bar-warning';
        if (load >= 40) return 'core-bar-moderate';
        return 'core-bar-normal';
    }

    function getStateBadgeClass(state) {
        switch (state) {
            case 'running': return 'badge-running';
            case 'sleeping': return 'badge-sleeping';
            case 'stopped': return 'badge-stopped';
            case 'zombie': return 'badge-red';
            default: return 'badge-muted';
        }
    }

    function isSystemProcess(name) {
        const sysProcesses = [
            'system idle process', 'system', 'registry', 'smss.exe', 'csrss.exe',
            'wininit.exe', 'services.exe', 'lsass.exe', 'svchost.exe', 'fontdrvhost.exe',
            'dwm.exe', 'sihost.exe', 'taskhostw.exe', 'ctfmon.exe', 'conhost.exe',
            'runtimebroker.exe', 'shellexperiencehost.exe', 'searchui.exe',
            'startmenuexperiencehost.exe', 'textinputhost.exe', 'securityhealthservice.exe',
            'sgrmbroker.exe', 'memcompression', 'idle', 'kernel_task'
        ];
        return sysProcesses.includes(name.toLowerCase());
    }

    function getAppIcon(name) {
        const iconMap = {
            'chrome': '🌐', 'chrome.exe': '🌐',
            'firefox': '🦊', 'firefox.exe': '🦊',
            'msedge': '🌊', 'msedge.exe': '🌊',
            'code': '💻', 'code.exe': '💻',
            'code - insiders': '💻',
            'discord': '💬', 'discord.exe': '💬',
            'spotify': '🎵', 'spotify.exe': '🎵',
            'slack': '📱', 'slack.exe': '📱',
            'teams': '👥', 'teams.exe': '👥',
            'steam': '🎮', 'steam.exe': '🎮',
            'explorer': '📂', 'explorer.exe': '📂',
            'notepad': '📝', 'notepad.exe': '📝',
            'terminal': '⬛', 'windowsterminal.exe': '⬛',
            'powershell': '⬛', 'powershell.exe': '⬛',
            'cmd': '⬛', 'cmd.exe': '⬛',
            'obs64': '📹', 'obs64.exe': '📹',
            'vlc': '🎬', 'vlc.exe': '🎬',
            'photoshop': '🎨', 'photoshop.exe': '🎨',
            'node': '🟢', 'node.exe': '🟢',
            'python': '🐍', 'python.exe': '🐍', 'python3': '🐍',
            'java': '☕', 'java.exe': '☕',
            'winword': '📄', 'winword.exe': '📄',
            'excel': '📊', 'excel.exe': '📊',
            'powerpnt': '📊', 'powerpnt.exe': '📊',
            'outlook': '📧', 'outlook.exe': '📧',
            'devenv': '🟣', 'devenv.exe': '🟣',
            'idea64': '🟧', 'idea64.exe': '🟧',
            'whatsapp': '💚', 'telegram': '✈️',
            'zoom': '📹', 'zoom.exe': '📹',
        };
        return iconMap[name.toLowerCase()] || '📦';
    }

    // ── Clock ──
    function startClock() {
        function updateClock() {
            const now = new Date();
            setText('val-datetime', now.toLocaleString('en-US', {
                weekday: 'short',
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            }));
        }
        updateClock();
        setInterval(updateClock, 1000);
    }

    // ── Grid Masonry Packing ──
    function resizeGridItems() {
        const grid = document.querySelector('.dashboard-grid');
        if (!grid) return;

        if (window.innerWidth <= 767) {
            grid.querySelectorAll(':scope > .card, :scope > .card-group').forEach(el => {
                el.style.gridRowEnd = '';
            });
            return;
        }

        const rowHeight = 5;
        const rowGap = 16;
        const items = grid.querySelectorAll(':scope > .card, :scope > .card-group');
        items.forEach(item => {
            item.style.gridRowEnd = '';
            const height = item.getBoundingClientRect().height;
            const rowSpan = Math.ceil((height + rowGap) / (rowHeight + rowGap));
            item.style.gridRowEnd = `span ${rowSpan}`;
        });
    }

    let resizeObserver = null;
    function initResizeObserver() {
        if (!('ResizeObserver' in window)) {
            window.addEventListener('resize', () => {
                if (masonryResizeTimer) clearTimeout(masonryResizeTimer);
                masonryResizeTimer = setTimeout(resizeGridItems, 100);
            });
            return;
        }

        resizeObserver = new ResizeObserver((entries) => {
            requestAnimationFrame(() => {
                const grid = document.querySelector('.dashboard-grid');
                if (!grid) return;

                const isMobile = window.innerWidth <= 767;
                const rowHeight = 5;
                const rowGap = 16;

                entries.forEach(entry => {
                    const el = entry.target;
                    // Only process direct children of grid
                    if (el.parentNode !== grid) return;

                    if (isMobile) {
                        el.style.gridRowEnd = '';
                    } else {
                        // Reset temporarily to measure natural height
                        const oldSpan = el.style.gridRowEnd;
                        el.style.gridRowEnd = '';
                        const height = el.getBoundingClientRect().height;
                        const rowSpan = Math.ceil((height + rowGap) / (rowHeight + rowGap));
                        const newSpan = `span ${rowSpan}`;
                        if (oldSpan !== newSpan) {
                            el.style.gridRowEnd = newSpan;
                        } else {
                            el.style.gridRowEnd = oldSpan;
                        }
                    }
                });
            });
        });

        // Observe all cards and groups
        document.querySelectorAll('.card, .card-group').forEach(el => {
            resizeObserver.observe(el);
        });
    }

    // Debounced window resize handler for masonry recalculations (fallback)
    let masonryResizeTimer = null;
    window.addEventListener('resize', () => {
        if (!resizeObserver) {
            if (masonryResizeTimer) clearTimeout(masonryResizeTimer);
            masonryResizeTimer = setTimeout(resizeGridItems, 100);
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // STARTUP
    // ═══════════════════════════════════════════════════════════════
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
