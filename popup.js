/**
 * Quick Novel Translator (STV) - Popup Controller
 * Bilingual (vi/en), Per-site Permissions, Accessible Modals, Dual-Engine TTS, Glossary I/O.
 */
(function () {
    'use strict';

    const I18n = window.STV_I18n;
    const UrlValidator = window.STV_UrlValidator;
    const GlossaryUtils = window.STV_GlossaryUtils;
    const IconDescriber = window.STV_IconDescriber;

    const DEFAULT_SETTINGS = {
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        apikey: '',
        model: 'stepfun/step-3.5-flash',
        shortcut: 'Ctrl+Q',
        prompt: '',
        fontFamily: 'Be Vietnam Pro',
        fontSize: 22,
        lineHeight: 1.8,
        ttsEngine: 'ws_default',
        ttsWsEndpoint: 'wss://tts.stv-novel.local/v1/tts',
        ttsWsVoice: 'vi-VN-HoaiMyNeural',
        ttsWsFallback: true,
        ttsEndpoint: 'http://127.0.0.1:8000',
        ttsBackend: 'auto',
        ttsStability: 'balanced',
        ttsVoice: '',
        ttsApiKey: '',
        ttsSpeed: 1.0,
        ttsAutoPlay: false,
        ttsAutoNext: true,
        ttsPreloadSec: 60,
        ttsDownloadMinutes: 30,
        ttsDownloadSource: 'current',
        ttsColabUrl: '',
        ttsColabVoice: '',
        ttsColabGpu: 'T4',
        ttsExportTranslateConcurrency: 3,
        ttsIconMode: 'auto',
        ttsIconStyle: 'tagged',
        stvDebugLog: false,
        stv_theme: 'dark'
    };

    function normalizeExportTranslateConcurrency(raw) {
        const parsed = Math.floor(Number(raw));
        return Number.isFinite(parsed)
            ? Math.max(1, Math.min(6, parsed))
            : DEFAULT_SETTINGS.ttsExportTranslateConcurrency;
    }

    const COLAB_NOTEBOOK_URL = 'https://colab.research.google.com/github/trankhiembaolong/quick-novel-translator/blob/main/colab/VieNeu_Colab_GPU.ipynb';

    const DEFAULT_MODEL_PRESETS = [
        { id: 'stepfun/step-3.5-flash', provider: 'stepfun', modelName: 'step-3.5-flash', ownedBy: '', displayName: '' },
        { id: 'google/gemini-2.5-flash', provider: 'google', modelName: 'gemini-2.5-flash', ownedBy: '', displayName: '' },
        { id: 'google/gemini-2.5-pro', provider: 'google', modelName: 'gemini-2.5-pro', ownedBy: '', displayName: '' },
        { id: 'openai/gpt-4.1-mini', provider: 'openai', modelName: 'gpt-4.1-mini', ownedBy: '', displayName: '' },
        { id: 'anthropic/claude-sonnet-4', provider: 'anthropic', modelName: 'claude-sonnet-4', ownedBy: '', displayName: '' },
        { id: 'deepseek/deepseek-v3-0324', provider: 'deepseek', modelName: 'deepseek-v3-0324', ownedBy: '', displayName: '' }
    ];

    const state = {
        activeTab: null,
        activeOrigin: null,
        activeHost: null,
        hasSitePerm: false,
        savedSelector: null,
        apiEndpointHost: null,
        apiEndpointOriginPattern: null,
        hasApiEndpointPerm: false,
        profiles: { Default: [] },
        activeProfile: 'Default',
        searchQuery: '',
        filterMode: 'all',
        selectedOrigs: new Set(),
        searchTimer: null,
        cleanIssues: [],
        glossarySubtab: 'terms',
        customIcons: {},
        learnedIcons: {},
        iconKindFilter: 'all',
        iconFilterMode: 'all',
        iconSearchQuery: '',
        iconSearchTimer: null,
        vieneuRunning: false,
        colabOnline: false,
        colabGpuName: '',
        colabWorkers: 6,
        colabBatchSize: 0,
        fetchedModels: [],
        modelsEndpoint: '',
        isFetchingModels: false,
        modelDropdownOpen: false,
        modelSearchQuery: '',
        modelProviderFilter: 'all',
        selectedModelProviderKey: ''
    };

    const $ = (id) => document.getElementById(id);
    const t = (key, params) => (I18n ? I18n.t(key, params) : key);

    // -------------------------------------------------------------------------
    // Accessible WAI-ARIA Dialogs (replaces alert / confirm / prompt)
    // -------------------------------------------------------------------------
    function showDialog({ title, message, mode = 'alert', defaultValue = '', placeholder = '' }) {
        return new Promise((resolve) => {
            const overlay = $('app-dialog-overlay');
            const titleEl = $('app-dialog-title');
            const msgEl = $('app-dialog-message');
            const inputEl = $('app-dialog-input');
            const cancelBtn = $('app-dialog-cancel');
            const confirmBtn = $('app-dialog-confirm');

            titleEl.textContent = title || '';
            msgEl.textContent = message || '';

            if (mode === 'prompt') {
                inputEl.hidden = false;
                inputEl.value = defaultValue || '';
                inputEl.placeholder = placeholder || '';
            } else {
                inputEl.hidden = true;
                inputEl.value = '';
            }

            cancelBtn.hidden = mode === 'alert';
            overlay.hidden = false;

            const cleanup = (result) => {
                overlay.hidden = true;
                cancelBtn.removeEventListener('click', onCancel);
                confirmBtn.removeEventListener('click', onConfirm);
                overlay.removeEventListener('keydown', onKeyDown);
                resolve(result);
            };

            const onCancel = () => cleanup(mode === 'prompt' ? null : false);
            const onConfirm = () => cleanup(mode === 'prompt' ? inputEl.value : true);
            const onKeyDown = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    onCancel();
                } else if (e.key === 'Enter' && (mode !== 'prompt' || document.activeElement === inputEl)) {
                    e.preventDefault();
                    onConfirm();
                }
            };

            cancelBtn.addEventListener('click', onCancel);
            confirmBtn.addEventListener('click', onConfirm);
            overlay.addEventListener('keydown', onKeyDown);

            setTimeout(() => {
                if (mode === 'prompt') {
                    inputEl.focus();
                    inputEl.select();
                } else {
                    confirmBtn.focus();
                }
            }, 0);
        });
    }

    const showAlert = (title, message) => showDialog({ title, message, mode: 'alert' });
    const showConfirm = (title, message) => showDialog({ title, message, mode: 'confirm' });
    const showPrompt = (title, message, defaultValue = '', placeholder = '') =>
        showDialog({ title, message, mode: 'prompt', defaultValue, placeholder });

    // -------------------------------------------------------------------------
    // Theme & Localization
    // -------------------------------------------------------------------------
    function applyTheme(theme) {
        const next = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        const btn = $('btn-theme-toggle');
        if (btn) btn.textContent = next === 'dark' ? '🌙' : '☀️';
    }

    function refreshLocalizedUI() {
        if (I18n) {
            I18n.applyToDOM(document);
            const locale = I18n.getLocale();
            const langBtn = $('btn-lang-toggle');
            if (langBtn) langBtn.textContent = locale.toUpperCase();
            const settingsLocale = $('settings-locale');
            if (settingsLocale) settingsLocale.value = locale;
        }
        renderSitePermissionUI();
        renderApiEndpointPermissionUI();
        renderGlossaryList();
        renderIconLibraryList();
        updateVieNeuBadgeUI(state.vieneuRunning);
        updateColabStatusUI();
        if (state.modelDropdownOpen) {
            renderModelDropdown();
        }
    }

    // -------------------------------------------------------------------------
    // Tabs
    // -------------------------------------------------------------------------
    function switchMainTab(target) {
        const buttons = document.querySelectorAll('.tab-btn');
        const panels = document.querySelectorAll('.tab-panel');
        buttons.forEach((b) => {
            const active = b.getAttribute('data-tab') === target;
            b.classList.toggle('active', active);
            b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        panels.forEach((p) => {
            const active = p.id === `panel-${target}`;
            p.classList.toggle('active', active);
            p.hidden = !active;
        });
        if (target === 'glossary') {
            renderGlossaryList();
            void loadIconLibraryData();
        } else if (target === 'tts') {
            syncTtsPlaybackUI();
            if ($('tts-engine-select')?.value === 'vieneu') {
                checkVieNeuHealth();
            }
            if ($('tts-download-source')?.value === 'colab_gpu' && $('tts-colab-url')?.value.trim()) {
                void checkColabHealth({ requestPerm: false, silent: true });
            }
        }
    }

    function initTabs() {
        const buttons = document.querySelectorAll('.tab-btn');
        buttons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-tab');
                if (target) switchMainTab(target);
            });
        });
    }

    // -------------------------------------------------------------------------
    // Site-by-Site Permissions & Saved Selector
    // -------------------------------------------------------------------------
    async function refreshActiveTabInfo() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        state.activeTab = tab || null;
        state.activeOrigin = null;
        state.activeHost = null;
        state.hasSitePerm = false;
        state.savedSelector = null;

        if (tab && tab.url && /^https?:\/\//i.test(tab.url)) {
            try {
                const parsed = new URL(tab.url);
                state.activeOrigin = parsed.origin;
                state.activeHost = parsed.hostname;
                state.hasSitePerm = await chrome.permissions.contains({
                    origins: [`${state.activeOrigin}/*`]
                });
                const selKey = `stv_selector_${state.activeHost}`;
                const data = await chrome.storage.local.get([selKey]);
                state.savedSelector = data[selKey] || null;
            } catch (_) {
                // Ignore malformed URLs
            }
        }
        renderSitePermissionUI();
    }

    function renderSitePermissionUI() {
        const badge = $('site-perm-badge');
        const permText = $('site-perm-text');
        const grantBtn = $('btn-grant-site');
        const selectorText = $('site-selector-text');
        const clearBtn = $('btn-clear-selector');

        if (!badge || !permText || !grantBtn) return;

        badge.classList.remove('granted', 'needed');

        if (!state.activeOrigin) {
            permText.textContent = t('site_access_restricted');
            grantBtn.hidden = true;
        } else if (state.hasSitePerm) {
            badge.classList.add('granted');
            permText.textContent = t('site_access_granted');
            grantBtn.hidden = true;
        } else {
            badge.classList.add('needed');
            permText.textContent = t('site_access_needed');
            grantBtn.hidden = false;
        }

        if (selectorText && clearBtn) {
            if (state.savedSelector && state.activeHost) {
                selectorText.textContent = t('site_selector_saved', { host: state.activeHost });
                clearBtn.hidden = false;
            } else {
                selectorText.textContent = t('site_selector_none');
                clearBtn.hidden = true;
            }
        }
    }

    async function ensureSitePermission() {
        if (!state.activeOrigin) return false;
        if (state.hasSitePerm) return true;
        try {
            const granted = await chrome.permissions.request({
                origins: [`${state.activeOrigin}/*`]
            });
            state.hasSitePerm = !!granted;
            renderSitePermissionUI();
            return state.hasSitePerm;
        } catch (_) {
            return false;
        }
    }

    function parseApiEndpointOrigin(rawUrl) {
        try {
            const parsed = new URL(String(rawUrl || '').trim());
            if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
                return null;
            }
            return {
                host: parsed.host,
                origin: parsed.origin,
                originPattern: `${parsed.protocol}//${parsed.hostname}/*`
            };
        } catch (_) {
            return null;
        }
    }

    function renderApiEndpointPermissionUI() {
        const row = $('api-perm-row');
        const badge = $('api-perm-badge');
        const textEl = $('api-perm-text');
        const grantBtn = $('btn-grant-api-host');
        if (!row || !badge || !textEl || !grantBtn) return;

        if (!state.apiEndpointHost || !state.apiEndpointOriginPattern) {
            row.hidden = true;
            return;
        }

        row.hidden = false;
        badge.classList.remove('granted', 'needed');
        if (state.hasApiEndpointPerm) {
            badge.classList.add('granted');
            textEl.textContent = t('api_access_granted', { host: state.apiEndpointHost });
            grantBtn.hidden = true;
        } else {
            badge.classList.add('needed');
            textEl.textContent = t('api_access_needed', { host: state.apiEndpointHost });
            grantBtn.hidden = false;
        }
    }

    async function refreshApiEndpointPermission(rawEndpoint = null) {
        const endpoint = String(rawEndpoint ?? $('api-endpoint')?.value ?? '').trim();
        const info = parseApiEndpointOrigin(endpoint);
        state.apiEndpointHost = info ? info.host : null;
        state.apiEndpointOriginPattern = info ? info.originPattern : null;
        state.hasApiEndpointPerm = false;

        if (info && chrome.permissions && typeof chrome.permissions.contains === 'function') {
            try {
                state.hasApiEndpointPerm = Boolean(await chrome.permissions.contains({
                    origins: [info.originPattern]
                }));
            } catch (_) {
                state.hasApiEndpointPerm = false;
            }
        }
        renderApiEndpointPermissionUI();
        return state.hasApiEndpointPerm;
    }

    async function ensureApiEndpointPermission(rawEndpoint = null, { promptIfMissing = true } = {}) {
        const endpoint = String(rawEndpoint ?? $('api-endpoint')?.value ?? '').trim();
        const info = parseApiEndpointOrigin(endpoint);
        if (!info) {
            state.apiEndpointHost = null;
            state.apiEndpointOriginPattern = null;
            state.hasApiEndpointPerm = false;
            renderApiEndpointPermissionUI();
            return false;
        }

        state.apiEndpointHost = info.host;
        state.apiEndpointOriginPattern = info.originPattern;

        let alreadyGranted = false;
        if (chrome.permissions && typeof chrome.permissions.contains === 'function') {
            try {
                alreadyGranted = Boolean(await chrome.permissions.contains({
                    origins: [info.originPattern]
                }));
            } catch (_) {
                alreadyGranted = false;
            }
        }

        if (alreadyGranted) {
            state.hasApiEndpointPerm = true;
            renderApiEndpointPermissionUI();
            try {
                await chrome.runtime.sendMessage({ action: 'sync_api_dnr_rules', endpoint });
            } catch (_) {}
            return true;
        }

        if (!promptIfMissing) {
            state.hasApiEndpointPerm = false;
            renderApiEndpointPermissionUI();
            return false;
        }

        let granted = false;
        if (chrome.permissions && typeof chrome.permissions.request === 'function') {
            try {
                granted = Boolean(await chrome.permissions.request({
                    origins: [info.originPattern]
                }));
            } catch (_) {
                granted = false;
            }
        }
        state.hasApiEndpointPerm = granted;
        renderApiEndpointPermissionUI();
        try {
            await chrome.runtime.sendMessage({ action: 'sync_api_dnr_rules', endpoint });
        } catch (_) {}
        return granted;
    }

    // -------------------------------------------------------------------------
    // Settings Load / Save & Onboarding
    // -------------------------------------------------------------------------
    async function loadSettingsIntoUI() {
        const keys = [
            ...Object.keys(DEFAULT_SETTINGS),
            'ttsAutoNextChapter',
            'ttsPreloadSeconds',
            'ttsStabilityProfile',
            'ttsWsAutoFallback',
            'stv_cached_models',
            'stv_cached_models_endpoint'
        ];
        const stored = await chrome.storage.local.get(keys);
        const cfg = { ...DEFAULT_SETTINGS, ...stored };

        if (Array.isArray(stored.stv_cached_models) && stored.stv_cached_models.length > 0) {
            state.fetchedModels = stored.stv_cached_models.map(sanitizeModelEntry).filter(Boolean);
            state.modelsEndpoint = stored.stv_cached_models_endpoint || '';
        }

        applyTheme(cfg.stv_theme);

        $('main-model').value = cfg.model || DEFAULT_SETTINGS.model;
        $('api-endpoint').value = cfg.endpoint || DEFAULT_SETTINGS.endpoint;
        $('api-key').value = cfg.apikey || '';
        $('api-model').value = cfg.model || DEFAULT_SETTINGS.model;
        $('api-shortcut').value = cfg.shortcut || DEFAULT_SETTINGS.shortcut;
        $('api-prompt').value = cfg.prompt || '';
        $('api-fontfamily').value = cfg.fontFamily || DEFAULT_SETTINGS.fontFamily;
        $('api-fontsize').value = cfg.fontSize ?? DEFAULT_SETTINGS.fontSize;
        $('api-lineheight').value = cfg.lineHeight ?? DEFAULT_SETTINGS.lineHeight;

        const activeEngine = cfg.ttsEngine || 'ws_default';
        $('tts-engine-select').value = activeEngine;
        $('tts-speed-range').value = cfg.ttsSpeed ?? 1.0;
        $('tts-speed-label-val').textContent = `${Number(cfg.ttsSpeed ?? 1.0).toFixed(1)}x`;
        $('tts-download-minutes').value = cfg.ttsDownloadMinutes ?? DEFAULT_SETTINGS.ttsDownloadMinutes;
        const dlSource = cfg.ttsDownloadSource === 'colab_gpu' ? 'colab_gpu' : 'current';
        $('tts-download-source').value = dlSource;
        $('tts-colab-url').value = cfg.ttsColabUrl || '';
        const colabGpuVal = ['T4', 'L4', 'A100', 'auto'].includes(cfg.ttsColabGpu) ? cfg.ttsColabGpu : DEFAULT_SETTINGS.ttsColabGpu;
        $('tts-colab-gpu').value = colabGpuVal;
        $('tts-export-translate-concurrency').value = String(normalizeExportTranslateConcurrency(cfg.ttsExportTranslateConcurrency));
        populateColabVoiceSelect([], cfg.ttsColabVoice || '');

        $('tts-ws-endpoint').value = cfg.ttsWsEndpoint || DEFAULT_SETTINGS.ttsWsEndpoint;
        $('tts-ws-voice').value = cfg.ttsWsVoice || DEFAULT_SETTINGS.ttsWsVoice;
        $('tts-ws-fallback').checked = (cfg.ttsWsAutoFallback ?? cfg.ttsWsFallback) !== false;

        $('tts-endpoint').value = cfg.ttsEndpoint || DEFAULT_SETTINGS.ttsEndpoint;
        const normalizedBackend = cfg.ttsBackend === 'onnx' ? 'cpu_fp32' : (cfg.ttsBackend || DEFAULT_SETTINGS.ttsBackend);
        $('tts-backend').value = normalizedBackend;
        $('tts-stability').value = cfg.ttsStabilityProfile || cfg.ttsStability || DEFAULT_SETTINGS.ttsStability;
        $('tts-apikey').value = cfg.ttsApiKey || '';
        $('tts-autoplay').checked = !!cfg.ttsAutoPlay;
        $('tts-autonext').checked = (cfg.ttsAutoNextChapter ?? cfg.ttsAutoNext) !== false;
        $('tts-preload-sec').value = cfg.ttsPreloadSeconds ?? cfg.ttsPreloadSec ?? DEFAULT_SETTINGS.ttsPreloadSec;
        $('tts-icon-mode').value = ['auto', 'local', 'off'].includes(cfg.ttsIconMode) ? cfg.ttsIconMode : DEFAULT_SETTINGS.ttsIconMode;
        $('tts-icon-style').value = cfg.ttsIconStyle === 'natural' ? 'natural' : DEFAULT_SETTINGS.ttsIconStyle;
        $('settings-debug-log').checked = !!cfg.stvDebugLog;

        toggleVieNeuCard(activeEngine);
        toggleColabPanel(dlSource);
        populateVoiceQuickSelect(activeEngine, activeEngine === 'vieneu' ? (cfg.ttsVoice || '') : (cfg.ttsWsVoice || DEFAULT_SETTINGS.ttsWsVoice));
        syncTtsPlaybackUI();
        await refreshApiEndpointPermission(cfg.endpoint || DEFAULT_SETTINGS.endpoint);
        $('onboarding-card').hidden = !!(cfg.apikey && cfg.apikey.trim());
    }

    function populateVoiceQuickSelect(engine, selectedVoice) {
        const select = $('tts-voice-quick');
        if (!select) return;
        select.textContent = '';
        if (engine === 'vieneu') {
            if (selectedVoice) {
                const opt = document.createElement('option');
                opt.value = selectedVoice;
                opt.textContent = selectedVoice;
                select.appendChild(opt);
                select.value = selectedVoice;
            }
            return;
        }
        const defaults = [
            { id: 'vi-VN-HoaiMyNeural', label: 'vi-VN-HoaiMyNeural (Nữ)' },
            { id: 'vi-VN-NamMinhNeural', label: 'vi-VN-NamMinhNeural (Nam)' }
        ];
        if (selectedVoice && !defaults.some((v) => v.id === selectedVoice)) {
            defaults.unshift({ id: selectedVoice, label: selectedVoice });
        }
        defaults.forEach((v) => {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = v.label;
            select.appendChild(opt);
        });
        select.value = selectedVoice || defaults[0].id;
    }

    async function syncTtsPlaybackUI() {
        const stopBtn = $('btn-tts-stop');
        if (!stopBtn) return;
        if (!state.activeTab || !state.activeTab.id || !state.hasSitePerm) {
            stopBtn.hidden = true;
            return;
        }
        try {
            const res = await chrome.scripting.executeScript({
                target: { tabId: state.activeTab.id },
                func: () => (typeof window.STV_getTTSState === 'function' ? window.STV_getTTSState() : null)
            });
            const ttsState = res && res[0] && res[0].result;
            stopBtn.hidden = !(ttsState && ttsState.isPlaying);
        } catch (_) {
            stopBtn.hidden = true;
        }
    }

    function toggleVieNeuCard(engine) {
        const card = $('vieneu-advanced-card');
        if (card) card.hidden = engine !== 'vieneu';
    }

    function validateEndpointFields() {
        if (!UrlValidator) return { ok: true };
        const aiUrl = $('api-endpoint').value.trim();
        const wsUrl = $('tts-ws-endpoint').value.trim();
        const vieneuUrl = $('tts-endpoint').value.trim();
        const colabUrl = $('tts-colab-url').value.trim();

        if (!UrlValidator.isValidUrl(aiUrl, ['http:', 'https:'])) {
            return { ok: false, message: `API Endpoint không hợp lệ: ${aiUrl || '(trống)'}` };
        }
        if (wsUrl && !UrlValidator.isValidUrl(wsUrl, ['ws:', 'wss:', 'http:', 'https:'])) {
            return { ok: false, message: `WebSocket Endpoint không hợp lệ: ${wsUrl}` };
        }
        if (vieneuUrl && !UrlValidator.isValidUrl(vieneuUrl, ['http:', 'https:'])) {
            return { ok: false, message: `VieNeu URL không hợp lệ: ${vieneuUrl}` };
        }
        if (colabUrl && !UrlValidator.isValidUrl(colabUrl, ['http:', 'https:'])) {
            return { ok: false, message: `Colab Tunnel URL không hợp lệ: ${colabUrl}` };
        }
        return { ok: true };
    }

    async function applyReaderSettingsToActiveTab() {
        if (!state.activeTab || !state.activeTab.id || !state.activeOrigin) return;
        const cfg = {
            fontSize: `${Math.min(48, Math.max(10, Number($('api-fontsize').value) || 18))}px`,
            lineHeight: String(Math.min(3, Math.max(1.1, Number($('api-lineheight').value) || 1.75))),
            fontFamily: $('api-fontfamily').value.trim() || DEFAULT_SETTINGS.fontFamily
        };
        try {
            await chrome.scripting.executeScript({
                target: { tabId: state.activeTab.id },
                files: ['i18n.js', 'page-ui.js', 'extractor.js', 'translator.js']
            });
            await chrome.scripting.executeScript({
                target: { tabId: state.activeTab.id },
                func: (settings) => {
                    const apply = window.STV_applyReaderLayoutStyles;
                    const box = window.STV_activeContentBox ||
                        (typeof window.STV_findContentBoxInDocument === 'function'
                            ? window.STV_findContentBoxInDocument(document, '')
                            : null);
                    if (typeof apply === 'function' && box) {
                        window.STV_activeContentBox = box;
                        apply(box, settings.fontSize, settings.lineHeight, settings.fontFamily);
                        if (typeof window.STV_ensureFloatingReaderIcon === 'function') {
                            window.STV_ensureFloatingReaderIcon();
                        }
                        return true;
                    }
                    return false;
                },
                args: [cfg]
            });
        } catch (err) {
            console.warn('[STV Popup] Không áp dụng được giao diện lên tab hiện tại:', err);
        }
    }

    async function saveAllSettings({ requestHostPermission = false } = {}) {
        const statusEl = $('save-status');
        const showStatus = (message, ok = true) => {
            if (!statusEl) return;
            statusEl.hidden = false;
            statusEl.style.display = 'flex';
            statusEl.classList.toggle('success', ok);
            statusEl.classList.toggle('error', !ok);
            statusEl.style.color = ok ? 'var(--success)' : 'var(--danger)';
            statusEl.textContent = message;
        };
        showStatus(t('settings_saving') || 'Đang lưu...');
        try {
            const validation = validateEndpointFields();
            if (!validation.ok) {
                showStatus(validation.message || t('settings_invalid_url'), false);
                return false;
            }

            const apiKeyVal = $('api-key').value.trim();
            const modelVal = $('api-model').value.trim() || DEFAULT_SETTINGS.model;
            const wsVoiceVal = $('tts-ws-voice').value.trim() || DEFAULT_SETTINGS.ttsWsVoice;

            const payload = {
                endpoint: $('api-endpoint').value.trim(),
                apikey: apiKeyVal,
                model: modelVal,
                shortcut: $('api-shortcut').value.trim() || DEFAULT_SETTINGS.shortcut,
                prompt: $('api-prompt').value,
                fontFamily: $('api-fontfamily').value.trim() || DEFAULT_SETTINGS.fontFamily,
                fontSize: Math.min(48, Math.max(10, Number($('api-fontsize').value) || DEFAULT_SETTINGS.fontSize)),
                lineHeight: Math.min(3, Math.max(1.1, Number($('api-lineheight').value) || DEFAULT_SETTINGS.lineHeight)),
                ttsEngine: $('tts-engine-select').value,
                ttsWsEndpoint: $('tts-ws-endpoint').value.trim() || DEFAULT_SETTINGS.ttsWsEndpoint,
                ttsWsVoice: wsVoiceVal,
                ttsWsFallback: $('tts-ws-fallback').checked,
                ttsWsAutoFallback: $('tts-ws-fallback').checked,
                ttsEndpoint: $('tts-endpoint').value.trim() || DEFAULT_SETTINGS.ttsEndpoint,
                ttsBackend: $('tts-backend').value,
                ttsStabilityProfile: $('tts-stability').value || 'balanced',
                ttsStability: $('tts-stability').value || 'balanced',
                ttsApiKey: $('tts-apikey').value.trim(),
                ttsSpeed: Number($('tts-speed-range').value) || 1.0,
                ttsAutoPlay: $('tts-autoplay').checked,
                ttsAutoNext: $('tts-autonext').checked,
                ttsAutoNextChapter: $('tts-autonext').checked,
                ttsPreloadSec: Math.min(300, Math.max(5, Number($('tts-preload-sec').value) || DEFAULT_SETTINGS.ttsPreloadSec)),
                ttsPreloadSeconds: Math.min(300, Math.max(5, Number($('tts-preload-sec').value) || DEFAULT_SETTINGS.ttsPreloadSec)),
                ttsDownloadMinutes: Math.min(240, Math.max(1, Number($('tts-download-minutes').value) || DEFAULT_SETTINGS.ttsDownloadMinutes)),
                ttsDownloadSource: $('tts-download-source').value === 'colab_gpu' ? 'colab_gpu' : 'current',
                ttsColabUrl: $('tts-colab-url').value.trim().replace(/\/+$/, ''),
                ttsColabVoice: $('tts-colab-voice').value.trim(),
                ttsColabGpu: $('tts-colab-gpu').value || DEFAULT_SETTINGS.ttsColabGpu,
                ttsExportTranslateConcurrency: normalizeExportTranslateConcurrency($('tts-export-translate-concurrency')?.value),
                ttsIconMode: $('tts-icon-mode').value || DEFAULT_SETTINGS.ttsIconMode,
                ttsIconStyle: $('tts-icon-style').value || DEFAULT_SETTINGS.ttsIconStyle,
                stvDebugLog: $('settings-debug-log').checked
            };

            await chrome.storage.local.set(payload);
            const verify = await chrome.storage.local.get(['ttsAutoPlay', 'ttsAutoNext', 'stvDebugLog', 'model']);
            if (verify.model !== payload.model ||
                verify.ttsAutoPlay !== payload.ttsAutoPlay ||
                verify.ttsAutoNext !== payload.ttsAutoNext ||
                verify.stvDebugLog !== payload.stvDebugLog) {
                throw new Error('Chrome không xác nhận được dữ liệu đã lưu');
            }
            $('main-model').value = modelVal;
            if (payload.ttsEngine !== 'vieneu') {
                populateVoiceQuickSelect(payload.ttsEngine, wsVoiceVal);
            }
            $('onboarding-card').hidden = !!apiKeyVal;
            await refreshApiEndpointPermission(payload.endpoint);
            if (requestHostPermission && state.apiEndpointOriginPattern && !state.hasApiEndpointPerm) {
                await ensureApiEndpointPermission(payload.endpoint, { promptIfMissing: true });
            }
            try {
                await chrome.runtime.sendMessage({ action: 'sync_api_dnr_rules', endpoint: payload.endpoint });
            } catch (_) {}
            await applyReaderSettingsToActiveTab();
            const savedMsg = (requestHostPermission && state.apiEndpointOriginPattern && !state.hasApiEndpointPerm)
                ? t('settings_saved_need_api_perm')
                : t('settings_saved');
            showStatus(savedMsg);
            setTimeout(() => {
                if (statusEl && statusEl.textContent === savedMsg) {
                    statusEl.textContent = '';
                    statusEl.hidden = true;
                }
            }, 2500);
            return true;
        } catch (err) {
            showStatus(`Không lưu được: ${err?.message || err}`, false);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Model Picker, API Fetch & Provider-Aware Dropdown
    // -------------------------------------------------------------------------
    function isOpaqueProviderId(val) {
        if (typeof val !== 'string') return true;
        const s = val.trim();
        if (!s) return true;
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
            || /^[0-9a-f]{24}$|^[0-9a-f]{32}$/i.test(s)
            || /^\d{12,}$/.test(s);
    }

    function formatShortOpaqueLabel(rawId) {
        const cleaned = String(rawId || '').replace(/[^a-z0-9]/gi, '');
        return cleaned ? `#${cleaned.slice(0, 6).toLowerCase()}` : '#unknown';
    }

    function sanitizeModelEntry(entry) {
        if (!entry) return null;
        if (typeof entry === 'string') {
            const cleanId = entry.trim();
            if (!cleanId) return null;
            const slashIdx = cleanId.indexOf('/');
            const prov = slashIdx > 0 && slashIdx < cleanId.length - 1 ? cleanId.slice(0, slashIdx).trim() : 'default';
            const name = slashIdx > 0 && slashIdx < cleanId.length - 1 ? cleanId.slice(slashIdx + 1).trim() : cleanId;
            return {
                id: cleanId,
                provider: prov,
                providerKey: prov,
                providerId: '',
                isOpaqueProvider: false,
                modelName: name,
                ownedBy: '',
                displayName: ''
            };
        }
        if (typeof entry !== 'object') return null;

        const id = String(entry.id || '').trim();
        if (!id) return null;
        const slashIdx = id.indexOf('/');
        const slashPrefix = slashIdx > 0 && slashIdx < id.length - 1 ? id.slice(0, slashIdx).trim() : '';
        const modelName = String(entry.modelName || (slashPrefix ? id.slice(slashIdx + 1) : id)).trim() || id;
        const rawProvider = String(entry.provider || '').trim();
        const rawOwnedBy = String(entry.ownedBy || '').trim();
        const displayName = String(entry.displayName || '').trim();
        const opaqueCandidate = (entry.providerId && isOpaqueProviderId(entry.providerId) ? String(entry.providerId).trim() : '')
            || (isOpaqueProviderId(rawProvider) ? rawProvider : '')
            || (isOpaqueProviderId(rawOwnedBy) ? rawOwnedBy : '')
            || (entry.providerKey && isOpaqueProviderId(entry.providerKey) ? String(entry.providerKey).trim() : '');

        let provider = 'default';
        let providerKey = 'default';
        let providerId = String(entry.providerId || opaqueCandidate || '').trim();
        let ownedBy = '';
        let isOpaqueProvider = false;

        if (entry.isOpaqueProvider === true) {
            const key = String(entry.providerKey || providerId || rawProvider).trim() || 'default';
            provider = rawProvider && rawProvider.startsWith('#') ? rawProvider : formatShortOpaqueLabel(key);
            providerKey = key;
            providerId = providerId || key;
            ownedBy = '';
            isOpaqueProvider = true;
        } else if (slashPrefix) {
            provider = slashPrefix;
            providerKey = String(entry.providerKey || slashPrefix).trim() || slashPrefix;
            ownedBy = isOpaqueProviderId(rawOwnedBy) ? '' : rawOwnedBy;
            isOpaqueProvider = false;
        } else if (rawProvider && !isOpaqueProviderId(rawProvider)) {
            provider = rawProvider;
            providerKey = String(entry.providerKey || rawProvider).trim() || rawProvider;
            ownedBy = isOpaqueProviderId(rawOwnedBy) ? '' : rawOwnedBy;
            isOpaqueProvider = false;
        } else if (rawOwnedBy && !isOpaqueProviderId(rawOwnedBy)) {
            provider = rawOwnedBy;
            providerKey = String(entry.providerKey || rawOwnedBy).trim() || rawOwnedBy;
            ownedBy = rawOwnedBy;
            isOpaqueProvider = false;
        } else if (opaqueCandidate) {
            provider = formatShortOpaqueLabel(opaqueCandidate);
            providerKey = String(entry.providerKey || opaqueCandidate).trim() || opaqueCandidate;
            providerId = opaqueCandidate;
            ownedBy = '';
            isOpaqueProvider = true;
        }

        return {
            id,
            provider,
            providerKey,
            providerId,
            isOpaqueProvider,
            modelName,
            ownedBy,
            displayName
        };
    }

    function getActiveModelCatalog() {
        return state.fetchedModels.length > 0 ? state.fetchedModels : DEFAULT_MODEL_PRESETS;
    }

    function getProviderBadgeHue(provider) {
        const str = String(provider || 'default');
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
        }
        return Math.abs(hash) % 360;
    }

    function positionModelDropdownFallback() {
        const supportsAnchorArea = typeof CSS !== 'undefined' &&
            typeof CSS.supports === 'function' &&
            CSS.supports('position-area: block-end');
        if (supportsAnchorArea) return;

        const panel = $('model-dropdown-panel');
        const anchor = document.querySelector('.model-picker-row') || $('main-model');
        if (!panel || !anchor) return;

        const rect = anchor.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth || 400;
        const vh = window.innerHeight || document.documentElement.clientHeight || 520;
        const width = Math.min(376, vw - 24);
        const centeredLeft = rect.left + (rect.width - width) / 2;
        const left = Math.max(12, Math.min(centeredLeft, vw - width - 12));
        const spaceBelow = vh - rect.bottom - 10;
        const spaceAbove = rect.top - 10;

        panel.style.width = `${Math.round(width)}px`;
        panel.style.left = `${Math.round(left)}px`;
        if (spaceBelow >= 170 || spaceBelow >= spaceAbove) {
            panel.style.top = `${Math.round(rect.bottom + 6)}px`;
            panel.style.bottom = 'auto';
            panel.style.maxHeight = `${Math.max(140, Math.min(340, Math.floor(spaceBelow)))}px`;
        } else {
            panel.style.top = 'auto';
            panel.style.bottom = `${Math.round(vh - rect.top + 6)}px`;
            panel.style.maxHeight = `${Math.max(140, Math.min(340, Math.floor(spaceAbove)))}px`;
        }
    }

    async function selectModelFromDropdown(modelId, providerKey = '') {
        const clean = String(modelId || '').trim();
        if (!clean) return;
        state.selectedModelProviderKey = String(providerKey || '').trim();
        $('main-model').value = clean;
        $('api-model').value = clean;
        await chrome.storage.local.set({ model: clean });
        closeModelDropdown({ restoreFocus: true });
    }

    function buildModelOptionBtn(item, currentModelId) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'model-option-btn';
        btn.dataset.modelId = item.id;
        btn.dataset.providerKey = item.providerKey || item.provider || '';

        const isSelected = item.id === currentModelId && (
            !item.isOpaqueProvider ||
            !state.selectedModelProviderKey ||
            item.providerKey === state.selectedModelProviderKey
        );
        if (isSelected) {
            btn.classList.add('selected');
            btn.setAttribute('aria-pressed', 'true');
        }

        if (item.ownedBy) {
            btn.title = `${item.id} (${item.ownedBy})`;
        } else if (item.providerId) {
            btn.title = `${item.id} (ID: ${item.providerId})`;
        } else {
            btn.title = item.id;
        }

        const main = document.createElement('span');
        main.className = 'model-option-main';

        const top = document.createElement('span');
        top.className = 'model-option-top';

        const badge = document.createElement('span');
        badge.className = 'model-provider-badge';
        badge.style.setProperty('--prov-hue', String(getProviderBadgeHue(item.providerKey || item.provider)));
        badge.textContent = item.provider || 'default';

        const nameEl = document.createElement('span');
        nameEl.className = 'model-option-name';
        nameEl.textContent = item.modelName || item.id;

        top.appendChild(badge);
        top.appendChild(nameEl);
        main.appendChild(top);

        const metaParts = [];
        const modelLabelLower = (item.modelName || item.id).toLowerCase();
        if (item.ownedBy && !isOpaqueProviderId(item.ownedBy) && item.ownedBy.toLowerCase() !== String(item.provider || '').toLowerCase()) {
            metaParts.push(`By: ${item.ownedBy}`);
        } else if (
            item.displayName &&
            item.displayName.toLowerCase() !== modelLabelLower &&
            item.displayName.toLowerCase() !== item.id.toLowerCase()
        ) {
            metaParts.push(item.displayName);
        }

        if (metaParts.length > 0) {
            const metaEl = document.createElement('span');
            metaEl.className = 'model-option-meta';
            metaEl.textContent = metaParts.join(' · ');
            main.appendChild(metaEl);
        }

        btn.appendChild(main);

        if (isSelected) {
            const check = document.createElement('span');
            check.className = 'model-option-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = '✓';
            btn.appendChild(check);
        }

        btn.addEventListener('click', () => {
            void selectModelFromDropdown(item.id, item.providerKey || item.provider || '');
        });
        return btn;
    }

    function renderModelDropdown() {
        const filtersEl = $('model-provider-filters');
        const metaEl = $('model-dropdown-meta');
        const listEl = $('model-dropdown-list');
        if (!filtersEl || !metaEl || !listEl) return;

        const catalog = getActiveModelCatalog().map(sanitizeModelEntry).filter(Boolean);
        const providerCounts = new Map();
        for (const item of catalog) {
            const key = item.providerKey || item.provider || 'default';
            const existing = providerCounts.get(key);
            if (existing) {
                existing.count += 1;
            } else {
                providerCounts.set(key, {
                    label: item.provider || 'default',
                    count: 1,
                    tooltip: item.providerId || item.provider || 'default'
                });
            }
        }

        if (state.modelProviderFilter !== 'all' && !providerCounts.has(state.modelProviderFilter)) {
            state.modelProviderFilter = 'all';
        }

        // Provider filter chips (hidden when 0 or 1 provider)
        filtersEl.textContent = '';
        filtersEl.hidden = providerCounts.size <= 1;
        if (providerCounts.size > 1) {
            const filterFrag = document.createDocumentFragment();
            const createChip = (provKey, label, tooltip) => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'model-provider-chip';
                if (state.modelProviderFilter === provKey) chip.classList.add('active');
                chip.textContent = label;
                if (tooltip) chip.title = tooltip;
                chip.addEventListener('click', () => {
                    state.modelProviderFilter = provKey;
                    renderModelDropdown();
                });
                return chip;
            };

            filterFrag.appendChild(createChip('all', `${t('model_provider_all')} (${catalog.length})`, ''));
            const sortedProviders = Array.from(providerCounts.entries())
                .sort((a, b) => a[1].label.localeCompare(b[1].label));
            for (const [provKey, info] of sortedProviders) {
                filterFrag.appendChild(createChip(provKey, `${info.label} (${info.count})`, info.tooltip));
            }
            filtersEl.appendChild(filterFrag);
        }

        // Source / count hint
        if (state.fetchedModels.length > 0) {
            const hasOpaque = catalog.some((m) => m.isOpaqueProvider);
            metaEl.textContent = t(hasOpaque ? 'model_fetched_count_opaque' : 'model_fetched_count', {
                count: catalog.length,
                providers: providerCounts.size
            });
        } else {
            metaEl.textContent = t('model_list_default_hint');
        }

        // Filter items by provider & multi-token query
        const rawQuery = state.modelSearchQuery.trim();
        const tokens = rawQuery ? rawQuery.toLowerCase().split(/\s+/).filter(Boolean) : [];
        const filtered = catalog.filter((item) => {
            const itemProvKey = item.providerKey || item.provider || 'default';
            if (state.modelProviderFilter !== 'all' && itemProvKey !== state.modelProviderFilter) {
                return false;
            }
            if (tokens.length === 0) return true;
            const haystack = `${item.id} ${item.modelName || ''} ${item.provider || ''} ${item.ownedBy || ''} ${item.displayName || ''} ${item.providerId || ''}`.toLowerCase();
            return tokens.every((tok) => haystack.includes(tok));
        });

        listEl.textContent = '';
        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'glossary-empty';
            empty.textContent = t('model_no_match', { query: rawQuery });
            listEl.appendChild(empty);
            return;
        }

        const currentModelId = ($('main-model')?.value || '').trim();
        const listFrag = document.createDocumentFragment();

        if (filtered.length > 12 && tokens.length === 0 && state.modelProviderFilter === 'all' && providerCounts.size > 1) {
            const grouped = new Map();
            for (const item of filtered) {
                const provKey = item.providerKey || item.provider || 'default';
                if (!grouped.has(provKey)) grouped.set(provKey, []);
                grouped.get(provKey).push(item);
            }
            for (const [provKey, items] of grouped.entries()) {
                const provInfo = providerCounts.get(provKey);
                const provLabel = provInfo ? provInfo.label : (items[0]?.provider || 'default');
                const header = document.createElement('div');
                header.className = 'model-group-header';

                const titleSpan = document.createElement('span');
                const owners = new Set(items.map((x) => x.ownedBy).filter((o) => o && !isOpaqueProviderId(o)));
                const ownerNote = owners.size === 1 ? Array.from(owners)[0] : '';
                titleSpan.textContent = ownerNote && ownerNote.toLowerCase() !== provLabel.toLowerCase()
                    ? `${provLabel} · ${ownerNote}`
                    : provLabel;

                const countSpan = document.createElement('span');
                countSpan.textContent = String(items.length);

                header.appendChild(titleSpan);
                header.appendChild(countSpan);
                listFrag.appendChild(header);

                for (const item of items) {
                    listFrag.appendChild(buildModelOptionBtn(item, currentModelId));
                }
            }
        } else {
            const sortedFlat = [...filtered].sort((a, b) => {
                const nameCmp = (a.modelName || a.id).toLowerCase().localeCompare((b.modelName || b.id).toLowerCase());
                if (nameCmp !== 0) return nameCmp;
                return (a.provider || '').toLowerCase().localeCompare((b.provider || '').toLowerCase());
            });
            for (const item of sortedFlat) {
                listFrag.appendChild(buildModelOptionBtn(item, currentModelId));
            }
        }

        listEl.appendChild(listFrag);
    }

    function openModelDropdown() {
        const panel = $('model-dropdown-panel');
        const triggerBtn = $('btn-model-dropdown');
        if (!panel) return;

        renderModelDropdown();
        positionModelDropdownFallback();

        if (typeof panel.showPopover === 'function') {
            try {
                if (!panel.matches(':popover-open')) {
                    panel.showPopover();
                }
            } catch {
                panel.classList.add('is-open');
            }
        } else {
            panel.classList.add('is-open');
        }

        state.modelDropdownOpen = true;
        if (triggerBtn) triggerBtn.setAttribute('aria-expanded', 'true');

        setTimeout(() => {
            const searchInput = $('model-search-input');
            if (searchInput) searchInput.focus();
            const selectedBtn = $('model-dropdown-list')?.querySelector('.model-option-btn.selected');
            if (selectedBtn && typeof selectedBtn.scrollIntoView === 'function') {
                selectedBtn.scrollIntoView({ block: 'nearest' });
            }
        }, 0);
    }

    function closeModelDropdown({ restoreFocus = false } = {}) {
        const panel = $('model-dropdown-panel');
        const triggerBtn = $('btn-model-dropdown');
        if (!panel) return;

        if (typeof panel.hidePopover === 'function') {
            try {
                if (panel.matches(':popover-open')) {
                    panel.hidePopover();
                }
            } catch {
                panel.classList.remove('is-open');
            }
        }
        panel.classList.remove('is-open');
        state.modelDropdownOpen = false;
        if (triggerBtn) triggerBtn.setAttribute('aria-expanded', 'false');

        if (restoreFocus) {
            const mainModel = $('main-model');
            if (mainModel) mainModel.focus();
        }
    }

    function toggleModelDropdown() {
        const panel = $('model-dropdown-panel');
        if (!panel) return;
        const isCurrentlyOpen = typeof panel.matches === 'function' && typeof panel.showPopover === 'function'
            ? panel.matches(':popover-open')
            : state.modelDropdownOpen;
        if (isCurrentlyOpen) {
            closeModelDropdown({ restoreFocus: true });
        } else {
            openModelDropdown();
        }
    }

    async function handleFetchModelsClick() {
        if (state.isFetchingModels) return;
        const fetchBtn = $('btn-fetch-models');
        const statusEl = $('status-text');
        const endpoint = $('api-endpoint')?.value.trim() || '';
        const apiKey = $('api-key')?.value.trim() || '';

        state.isFetchingModels = true;
        if (fetchBtn) {
            fetchBtn.disabled = true;
            fetchBtn.classList.add('is-loading');
        }
        if (statusEl) {
            statusEl.classList.remove('error', 'success');
            statusEl.textContent = t('model_fetching');
        }

        if (endpoint) {
            const info = parseApiEndpointOrigin(endpoint);
            if (info && (!state.hasApiEndpointPerm || state.apiEndpointOriginPattern !== info.originPattern)) {
                await ensureApiEndpointPermission(endpoint, { promptIfMissing: true });
            }
        }

        try {
            const res = await chrome.runtime.sendMessage({
                action: 'fetch_ai_models',
                endpoint,
                apiKey
            });
            if (!res || !res.ok) {
                const errMsg = res?.error || 'Unknown error';
                if (statusEl) {
                    statusEl.classList.add('error');
                    statusEl.textContent = t('model_fetch_error', { error: errMsg });
                }
                return;
            }
            const models = (Array.isArray(res.models) ? res.models : []).map(sanitizeModelEntry).filter(Boolean);
            if (models.length === 0) {
                if (statusEl) {
                    statusEl.classList.add('error');
                    statusEl.textContent = t('model_fetch_empty');
                }
                return;
            }

            state.fetchedModels = models;
            state.modelsEndpoint = res.modelsUrl || endpoint;
            state.modelProviderFilter = 'all';
            state.modelSearchQuery = '';
            state.selectedModelProviderKey = '';
            const searchInput = $('model-search-input');
            if (searchInput) searchInput.value = '';

            await chrome.storage.local.set({
                stv_cached_models: models,
                stv_cached_models_endpoint: state.modelsEndpoint
            });

            const providerCount = new Set(models.map((m) => m.providerKey || m.provider || 'default')).size;
            if (statusEl) {
                statusEl.classList.add('success');
                statusEl.textContent = t('model_fetched_count', {
                    count: models.length,
                    providers: providerCount
                });
            }
            openModelDropdown();
        } catch (err) {
            if (statusEl) {
                statusEl.classList.add('error');
                statusEl.textContent = t('model_fetch_error', { error: err?.message || String(err) });
            }
        } finally {
            state.isFetchingModels = false;
            if (fetchBtn) {
                fetchBtn.disabled = false;
                fetchBtn.classList.remove('is-loading');
            }
        }
    }

    // -------------------------------------------------------------------------
    // Translate & Picker Actions
    // -------------------------------------------------------------------------
    async function handleTranslateClick() {
        const statusEl = $('status-text');
        const { apikey } = await chrome.storage.local.get(['apikey']);
        if (!apikey || !apikey.trim()) {
            statusEl.textContent = t('status_need_key');
            const onboarding = $('onboarding-card');
            if (onboarding) {
                onboarding.hidden = false;
                $('onboarding-api-key').focus();
            }
            return;
        }
        if (!state.activeTab || !state.activeOrigin) {
            statusEl.textContent = t('site_access_restricted');
            return;
        }
        const ok = await ensureSitePermission();
        if (!ok) {
            statusEl.textContent = t('site_access_needed');
            return;
        }

        const storedEndpointCfg = await chrome.storage.local.get(['endpoint']);
        const activeEndpoint = String(storedEndpointCfg?.endpoint || $('api-endpoint')?.value || DEFAULT_SETTINGS.endpoint).trim();
        const apiInfo = parseApiEndpointOrigin(activeEndpoint);
        if (apiInfo && (!state.hasApiEndpointPerm || state.apiEndpointOriginPattern !== apiInfo.originPattern)) {
            await ensureApiEndpointPermission(activeEndpoint, { promptIfMissing: true });
        }

        statusEl.textContent = t('status_translating');
        await chrome.storage.local.set({ model: $('main-model').value.trim() || DEFAULT_SETTINGS.model });
        try {
            const res = await chrome.runtime.sendMessage({
                action: 'translate_active_tab',
                tabId: state.activeTab.id
            });
            if (res && res.ok) {
                window.close();
            } else {
                statusEl.textContent = (res && res.error) || t('status_ready');
            }
        } catch (err) {
            statusEl.textContent = err.message || t('status_ready');
        }
    }

    async function handlePickClick() {
        const statusEl = $('status-text');
        if (!state.activeTab || !state.activeOrigin) {
            statusEl.textContent = t('site_access_restricted');
            return;
        }
        const ok = await ensureSitePermission();
        if (!ok) {
            statusEl.textContent = t('site_access_needed');
            return;
        }
        statusEl.textContent = t('status_picking');
        await chrome.scripting.executeScript({
            target: { tabId: state.activeTab.id },
            files: ['i18n.js', 'page-ui.js', 'picker.js']
        });
        window.close();
    }

    // -------------------------------------------------------------------------
    // TTS & VieNeu Actions
    // -------------------------------------------------------------------------
    async function loadTtsExecutionOptions(extra = {}) {
        const stored = await chrome.storage.local.get([
            'ttsEngine', 'ttsWsEndpoint', 'ttsWsVoice', 'ttsWsFallback', 'ttsWsAutoFallback',
            'ttsEndpoint', 'ttsBackend', 'ttsStability', 'ttsStabilityProfile', 'ttsVoice',
            'ttsSpeed', 'ttsAutoNext', 'ttsAutoNextChapter', 'ttsPreloadSec', 'ttsPreloadSeconds',
            'ttsDownloadMinutes', 'ttsDownloadSource', 'ttsColabUrl', 'ttsColabVoice', 'ttsColabGpu',
            'ttsExportTranslateConcurrency',
            'ttsIconMode', 'ttsIconStyle'
        ]);

        const engine = $('tts-engine-select').value || stored.ttsEngine || 'ws_default';
        const quickVoice = $('tts-voice-quick').value.trim();
        const downloadSource = $('tts-download-source')?.value || stored.ttsDownloadSource || 'current';
        const colabServerUrl = ($('tts-colab-url')?.value || stored.ttsColabUrl || '').trim().replace(/\/+$/, '');
        const colabVoice = ($('tts-colab-voice')?.value || stored.ttsColabVoice || '').trim();
        const colabGpuTier = $('tts-colab-gpu')?.value || stored.ttsColabGpu || DEFAULT_SETTINGS.ttsColabGpu;
        const colabProfile = getColabGpuProfile(colabGpuTier);
        const exportTranslateConcurrency = normalizeExportTranslateConcurrency(
            $('tts-export-translate-concurrency')?.value ?? stored.ttsExportTranslateConcurrency
        );
        return {
            engine,
            wsEndpoint: stored.ttsWsEndpoint || DEFAULT_SETTINGS.ttsWsEndpoint,
            wsVoice: engine === 'vieneu'
                ? (stored.ttsWsVoice || DEFAULT_SETTINGS.ttsWsVoice)
                : (quickVoice || stored.ttsWsVoice || DEFAULT_SETTINGS.ttsWsVoice),
            voice: engine === 'vieneu' ? (quickVoice || stored.ttsVoice || '') : undefined,
            wsAutoFallback: (stored.ttsWsAutoFallback ?? stored.ttsWsFallback) !== false,
            serverUrl: stored.ttsEndpoint || DEFAULT_SETTINGS.ttsEndpoint,
            backend: stored.ttsBackend || DEFAULT_SETTINGS.ttsBackend,
            stabilityProfile: stored.ttsStabilityProfile || stored.ttsStability || DEFAULT_SETTINGS.ttsStability,
            speed: Number($('tts-speed-range').value) || stored.ttsSpeed || 1.0,
            autoNextChapter: (stored.ttsAutoNextChapter ?? stored.ttsAutoNext) !== false,
            preloadLeadSec: stored.ttsPreloadSeconds ?? stored.ttsPreloadSec ?? DEFAULT_SETTINGS.ttsPreloadSec,
            downloadMinutes: Number($('tts-download-minutes').value) || stored.ttsDownloadMinutes || DEFAULT_SETTINGS.ttsDownloadMinutes,
            downloadSource: downloadSource === 'colab_gpu' ? 'colab_gpu' : 'current',
            colabServerUrl,
            colabVoice,
            colabGpuTier: colabProfile.tier,
            colabWorkers: colabProfile.workers,
            colabMaxChunkChars: colabProfile.maxChunkChars,
            exportTranslateConcurrency,
            iconMode: $('tts-icon-mode')?.value || stored.ttsIconMode || DEFAULT_SETTINGS.ttsIconMode,
            iconStyle: $('tts-icon-style')?.value || stored.ttsIconStyle || DEFAULT_SETTINGS.ttsIconStyle,
            ...extra
        };
    }

    async function handleTtsPlay() {
        const statusEl = $('tts-status-text');
        statusEl.classList.remove('error');
        if (!state.activeTab || !state.activeOrigin) {
            statusEl.textContent = t('site_access_restricted');
            return;
        }
        const ok = await ensureSitePermission();
        if (!ok) {
            statusEl.textContent = t('site_access_needed');
            return;
        }

        const opts = await loadTtsExecutionOptions();

        await chrome.scripting.executeScript({
            target: { tabId: state.activeTab.id },
            files: ['i18n.js', 'page-ui.js', 'extractor.js', 'tts-icon-describer.js', 'tts-player.js']
        });
        await chrome.scripting.executeScript({
            target: { tabId: state.activeTab.id },
            func: (ttsOpts) => {
                if (typeof window.STV_startTTS === 'function') {
                    window.STV_startTTS(ttsOpts);
                }
            },
            args: [opts]
        });
        if ($('btn-tts-stop')) $('btn-tts-stop').hidden = false;
        window.close();
    }

    async function handleTtsDownload() {
        const statusEl = $('tts-status-text');
        statusEl.classList.remove('error');
        if (!state.activeTab || !state.activeOrigin) {
            statusEl.textContent = t('site_access_restricted');
            return;
        }
        const ok = await ensureSitePermission();
        if (!ok) {
            statusEl.textContent = t('site_access_needed');
            return;
        }

        const minutes = Math.min(240, Math.max(1, parseInt($('tts-download-minutes').value, 10) || DEFAULT_SETTINGS.ttsDownloadMinutes));
        $('tts-download-minutes').value = minutes;
        await chrome.storage.local.set({ ttsDownloadMinutes: minutes });

        const opts = await loadTtsExecutionOptions({ downloadMinutes: minutes });
        if (opts.downloadSource === 'colab_gpu') {
            const colabUrl = (opts.colabServerUrl || '').trim().replace(/\/+$/, '');
            if (!colabUrl || !UrlValidator || !UrlValidator.isValidUrl(colabUrl, ['http:', 'https:'])) {
                const msg = t('tts_colab_err_url_missing');
                statusEl.textContent = msg;
                statusEl.classList.add('error');
                setColabHint(msg, 'error');
                return;
            }
            const permOk = await ensureColabTunnelPermission(colabUrl, { promptIfMissing: true });
            if (!permOk) {
                const msg = t('tts_colab_perm_needed');
                statusEl.textContent = msg;
                statusEl.classList.add('error');
                setColabHint(msg, 'error');
                return;
            }
            if (!state.colabOnline) {
                const okColab = await checkColabHealth({ requestPerm: false, silent: false });
                if (!okColab) {
                    statusEl.textContent = t('tts_colab_err_connect_fail', { url: colabUrl });
                    statusEl.classList.add('error');
                    return;
                }
            }
            opts.colabServerUrl = colabUrl;
            opts.colabVoice = ($('tts-colab-voice')?.value || opts.colabVoice || '').trim();
        } else if (opts.engine === 'webspeech') {
            statusEl.textContent = t('tts_dl_webspeech_unsupported');
            statusEl.classList.add('error');
            return;
        }
        statusEl.classList.remove('error');

        await chrome.scripting.executeScript({
            target: { tabId: state.activeTab.id },
            files: ['i18n.js', 'page-ui.js', 'extractor.js', 'tts-icon-describer.js', 'tts-player.js']
        });
        await chrome.scripting.executeScript({
            target: { tabId: state.activeTab.id },
            func: (ttsOpts) => {
                if (typeof window.STV_startTTSDownload === 'function') {
                    window.STV_startTTSDownload(ttsOpts);
                }
            },
            args: [opts]
        });
        window.close();
    }

    async function handleTtsStop() {
        if (!state.activeTab || !state.activeOrigin || !state.hasSitePerm) return;
        try {
            await chrome.scripting.executeScript({
                target: { tabId: state.activeTab.id },
                func: () => {
                    if (typeof window.STV_stopTTS === 'function') {
                        window.STV_stopTTS();
                    }
                }
            });
            $('tts-status-text').textContent = t('tts_status_stopped');
            if ($('btn-tts-stop')) $('btn-tts-stop').hidden = true;
        } catch (_) {
            // Ignore if page not injected
        }
    }

    function updateVieNeuBadgeUI(running) {
        state.vieneuRunning = !!running;
        const badge = $('tts-server-badge');
        const label = $('tts-server-label');
        const btn = $('btn-tts-server-toggle');
        if (!badge || !label || !btn) return;

        badge.classList.toggle('online', !!running);
        const backend = $('tts-backend') ? $('tts-backend').value : 'auto';
        label.textContent = running ? t('tts_vieneu_ready', { backend }) : t('tts_vieneu_off');
        btn.textContent = running ? t('btn_vieneu_stop') : t('btn_vieneu_start');
    }

    async function checkVieNeuHealth({ updateOnFail = true } = {}) {
        const endpoint = ($('tts-endpoint') && $('tts-endpoint').value.trim()) || DEFAULT_SETTINGS.ttsEndpoint;
        if (!UrlValidator || !UrlValidator.isValidUrl(endpoint, ['http:', 'https:'])) {
            if (updateOnFail) updateVieNeuBadgeUI(false);
            return false;
        }
        try {
            const res = await chrome.runtime.sendMessage({
                action: 'vieneu_check_health',
                serverUrl: endpoint
            });
            const ok = !!(res && res.ok);
            if (ok) {
                updateVieNeuBadgeUI(true);
                await loadVieNeuVoices();
            } else if (updateOnFail) {
                updateVieNeuBadgeUI(false);
            }
            return ok;
        } catch (_) {
            if (updateOnFail) updateVieNeuBadgeUI(false);
            return false;
        }
    }

    async function loadVieNeuVoices() {
        const select = $('tts-voice-quick');
        if (!select || $('tts-engine-select')?.value !== 'vieneu') return;
        const endpoint = ($('tts-endpoint') && $('tts-endpoint').value.trim()) || DEFAULT_SETTINGS.ttsEndpoint;
        const apiKey = ($('tts-apikey') && $('tts-apikey').value.trim()) || '';
        try {
            const res = await chrome.runtime.sendMessage({
                action: 'vieneu_get_voices',
                serverUrl: endpoint,
                apiKey
            });
            if (!res || !res.ok || !Array.isArray(res.voices)) throw new Error(res?.error || 'Không tải được danh sách giọng đọc');
            const stored = await chrome.storage.local.get(['ttsVoice']);
            const previous = select.value || stored.ttsVoice || '';
            select.textContent = '';
            res.voices.forEach((voice) => {
                const id = typeof voice === 'string' ? voice : (voice.id || voice.name || voice.voice || '');
                if (!id) return;
                const option = document.createElement('option');
                option.value = id;
                option.textContent = typeof voice === 'string' ? voice : (voice.name || voice.label || id);
                select.appendChild(option);
            });
            if (!select.options.length) throw new Error('VieNeu không trả về voice nào');
            select.value = Array.from(select.options).some((o) => o.value === previous) ? previous : select.options[0].value;
            await chrome.storage.local.set({ ttsVoice: select.value });
        } catch (err) {
            select.textContent = '';
            const fallback = document.createElement('option');
            fallback.value = '';
            fallback.textContent = 'VieNeu (mặc định)';
            select.appendChild(fallback);
            select.value = '';
        }
    }

    async function toggleVieNeuServer() {
        if (state.vieneuStarting) return;
        const hintEl = $('tts-host-hint');
        const toggleBtn = $('btn-tts-server-toggle');
        const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
        if (!granted) {
            hintEl.textContent = t('tts_vieneu_host_missing_guide');
            hintEl.hidden = false;
            return;
        }

        const cmd = state.vieneuRunning ? 'stop' : 'start';
        const endpoint = ($('tts-endpoint') && $('tts-endpoint').value.trim()) || DEFAULT_SETTINGS.ttsEndpoint;
        let port = 8000;
        try {
            const u = new URL(endpoint);
            if (u.port) port = Number(u.port);
        } catch (_) {}

        if (cmd === 'stop') {
            if (toggleBtn) toggleBtn.disabled = true;
            try {
                await chrome.runtime.sendMessage({
                    action: 'vieneu_native_control',
                    command: 'stop',
                    port,
                    backend: $('tts-backend') ? $('tts-backend').value : 'auto'
                });
            } finally {
                if (toggleBtn) toggleBtn.disabled = false;
                hintEl.hidden = true;
                updateVieNeuBadgeUI(false);
            }
            return;
        }

        state.vieneuStarting = true;
        if (toggleBtn) toggleBtn.disabled = true;
        $('tts-server-label').textContent = t('tts_vieneu_starting');

        try {
            const res = await chrome.runtime.sendMessage({
                action: 'vieneu_native_control',
                command: 'start',
                port,
                backend: $('tts-backend') ? $('tts-backend').value : 'auto'
            });

            if (!res || !res.ok) {
                if (!res || res.notInstalled) {
                    hintEl.textContent = t('tts_vieneu_host_missing_guide');
                } else {
                    hintEl.textContent = res.error
                        ? `${res.error}\n${t('tts_vieneu_host_missing_guide')}`
                        : t('tts_vieneu_host_missing_guide');
                }
                hintEl.hidden = false;
                updateVieNeuBadgeUI(false);
                return;
            }

            hintEl.hidden = true;
            const maxAttempts = 60;
            for (let i = 0; i < maxAttempts; i++) {
                if (i === 10) {
                    hintEl.textContent = t('tts_vieneu_first_run_hint');
                    hintEl.hidden = false;
                }
                await new Promise((r) => setTimeout(r, 1500));
                const ready = await checkVieNeuHealth({ updateOnFail: false });
                if (ready) {
                    hintEl.hidden = true;
                    return;
                }
            }

            updateVieNeuBadgeUI(false);
            hintEl.textContent = res.logFile
                ? t('tts_vieneu_timeout_with_log', { sec: 90, log: res.logFile })
                : t('tts_vieneu_timeout_no_log', { sec: 90 });
            hintEl.hidden = false;
        } finally {
            state.vieneuStarting = false;
            if (toggleBtn) toggleBtn.disabled = false;
        }
    }

    async function showVieNeuGuide() {
        const url = chrome.runtime.getURL('vieneu-setup.html');
        try {
            if (chrome.tabs && typeof chrome.tabs.create === 'function') {
                await chrome.tabs.create({ url });
                window.close();
                return;
            }
        } catch (_) {
            // Fallback below if tabs.create is unavailable
        }
        window.open(url, '_blank', 'noopener');
    }

    // -------------------------------------------------------------------------
    // Google Colab GPU Export Helpers
    // -------------------------------------------------------------------------
    function getColabGpuProfile(tier) {
        const normalized = String(tier || 'T4').trim().toUpperCase();
        if (normalized === 'A100') {
            return { tier: 'A100', workers: 12, maxChunkChars: 350, label: 'A100 · 12x' };
        }
        if (normalized === 'L4') {
            return { tier: 'L4', workers: 8, maxChunkChars: 320, label: 'L4 · 8x' };
        }
        if (normalized === 'AUTO') {
            return { tier: 'auto', workers: 6, maxChunkChars: 300, label: 'Auto GPU' };
        }
        return { tier: 'T4', workers: 6, maxChunkChars: 300, label: 'T4 · 6x' };
    }

    function toggleColabPanel(source) {
        const panel = $('tts-colab-panel');
        if (panel) panel.hidden = source !== 'colab_gpu';
        updateColabStatusUI();
    }

    function setColabHint(text, tone = '') {
        const hintEl = $('tts-colab-hint');
        if (!hintEl) return;
        hintEl.classList.remove('error', 'success');
        if (tone === 'error') hintEl.classList.add('error');
        else if (tone === 'success') hintEl.classList.add('success');
        hintEl.textContent = text || t('tts_colab_step_hint');
    }

    function updateColabStatusUI() {
        const badge = $('tts-colab-badge');
        const label = $('tts-colab-status-label');
        const pill = $('tts-colab-gpu-pill');
        const profile = getColabGpuProfile($('tts-colab-gpu')?.value || DEFAULT_SETTINGS.ttsColabGpu);

        if (badge) {
            badge.classList.toggle('online', !!state.colabOnline);
            badge.classList.toggle('granted', !!state.colabOnline);
        }
        if (label) {
            label.textContent = state.colabOnline
                ? t('tts_colab_badge_online', {
                    gpu: state.colabGpuName || profile.tier,
                    workers: state.colabWorkers || profile.workers
                })
                : t('tts_colab_badge_offline');
        }
        if (pill) {
            if (state.colabOnline && state.colabGpuName) {
                pill.textContent = state.colabBatchSize > 0
                    ? `Batch ${state.colabBatchSize}`
                    : `${state.colabWorkers || profile.workers}x`;
            } else {
                pill.textContent = profile.label;
            }
        }
    }

    function getColabWildcardPattern(rawUrl) {
        try {
            const parsed = new URL(String(rawUrl || '').trim());
            if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
                return null;
            }
            const host = parsed.hostname.toLowerCase();
            if (host.endsWith('.trycloudflare.com')) {
                return 'https://*.trycloudflare.com/*';
            }
            if (host.endsWith('.ngrok-free.app')) {
                return 'https://*.ngrok-free.app/*';
            }
            if (host.endsWith('.ngrok.app')) {
                return 'https://*.ngrok.app/*';
            }
            return `${parsed.protocol}//${parsed.hostname}/*`;
        } catch (_) {
            return null;
        }
    }

    async function ensureColabTunnelPermission(rawUrl, { promptIfMissing = true } = {}) {
        const info = parseApiEndpointOrigin(rawUrl);
        const wildcard = getColabWildcardPattern(rawUrl);
        if (!info || !wildcard) return false;
        if (!chrome.permissions || typeof chrome.permissions.contains !== 'function') {
            return true;
        }

        let granted = false;
        try {
            granted = Boolean(await chrome.permissions.contains({ origins: [info.originPattern] }))
                || Boolean(await chrome.permissions.contains({ origins: [wildcard] }));
        } catch (_) {
            granted = false;
        }

        if (!granted && promptIfMissing && typeof chrome.permissions.request === 'function') {
            try {
                granted = Boolean(await chrome.permissions.request({ origins: [wildcard] }));
            } catch (_) {
                granted = false;
            }
        }

        if (granted) {
            try {
                await chrome.runtime.sendMessage({ action: 'sync_api_dnr_rules', colabUrl: rawUrl });
            } catch (_) {}
        }
        return granted;
    }

    function populateColabVoiceSelect(voices, selectedVoice = '') {
        const select = $('tts-colab-voice');
        if (!select) return;
        const previous = selectedVoice || select.value || '';
        select.textContent = '';
        if (Array.isArray(voices) && voices.length > 0) {
            voices.forEach((voice) => {
                const id = typeof voice === 'string' ? voice : (voice.id || voice.name || voice.voice || '');
                if (!id) return;
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = typeof voice === 'string' ? voice : (voice.name || voice.label || id);
                select.appendChild(opt);
            });
        }
        if (!select.options.length) {
            const fallback = document.createElement('option');
            fallback.value = previous || '';
            fallback.textContent = previous || 'VieNeu (mặc định)';
            select.appendChild(fallback);
        }
        select.value = Array.from(select.options).some((o) => o.value === previous)
            ? previous
            : select.options[0].value;
    }

    async function loadColabVoices(serverUrl) {
        const select = $('tts-colab-voice');
        if (!select) return;
        const apiKey = ($('tts-apikey') && $('tts-apikey').value.trim()) || '';
        const stored = await chrome.storage.local.get(['ttsColabVoice']);
        const preferred = select.value || stored.ttsColabVoice || '';
        try {
            const res = await chrome.runtime.sendMessage({
                action: 'vieneu_get_voices',
                serverUrl,
                apiKey,
                isColab: true
            });
            if (!res || !res.ok || !Array.isArray(res.voices)) {
                throw new Error(res?.error || 'Failed to load Colab voices');
            }
            populateColabVoiceSelect(res.voices, preferred);
            await chrome.storage.local.set({ ttsColabVoice: select.value });
        } catch (_) {
            populateColabVoiceSelect([], preferred);
        }
    }

    async function checkColabHealth({ requestPerm = false, silent = false } = {}) {
        const input = $('tts-colab-url');
        const url = (input ? input.value.trim() : '').replace(/\/+$/, '');
        if (!url || !UrlValidator || !UrlValidator.isValidUrl(url, ['http:', 'https:'])) {
            state.colabOnline = false;
            state.colabGpuName = '';
            state.colabBatchSize = 0;
            updateColabStatusUI();
            if (!silent) setColabHint(t('tts_colab_err_url_missing'), 'error');
            return false;
        }

        if (requestPerm) {
            const permOk = await ensureColabTunnelPermission(url, { promptIfMissing: true });
            if (!permOk) {
                state.colabOnline = false;
                updateColabStatusUI();
                if (!silent) setColabHint(t('tts_colab_perm_needed'), 'error');
                return false;
            }
        }

        const label = $('tts-colab-status-label');
        if (label) label.textContent = t('tts_colab_badge_checking');

        try {
            const apiKey = ($('tts-apikey') && $('tts-apikey').value.trim()) || '';
            const res = await chrome.runtime.sendMessage({
                action: 'vieneu_check_health',
                serverUrl: url,
                apiKey,
                isColab: true
            });
            if (!res || !res.ok) {
                throw new Error(res?.error || 'Unreachable');
            }
            const profile = getColabGpuProfile($('tts-colab-gpu')?.value || DEFAULT_SETTINGS.ttsColabGpu);
            state.colabOnline = true;
            state.colabGpuName = String(res.data?.gpu_name || res.data?.gpu_tier || profile.tier);
            const reportedWorkers = Number(res.data?.export_max_streams || res.data?.max_streams || profile.workers);
            state.colabWorkers = Number.isFinite(reportedWorkers) && reportedWorkers >= 1
                ? reportedWorkers
                : profile.workers;
            state.colabBatchSize = res.data?.batch_supported
                ? (Number(res.data?.batch_max_size) || 0)
                : 0;
            updateColabStatusUI();
            setColabHint(t('tts_colab_step_hint'));
            await chrome.storage.local.set({ ttsColabUrl: url });
            await loadColabVoices(url);
            return true;
        } catch (_) {
            state.colabOnline = false;
            state.colabGpuName = '';
            state.colabBatchSize = 0;
            updateColabStatusUI();
            if (!silent) setColabHint(t('tts_colab_err_connect_fail', { url }), 'error');
            return false;
        }
    }

    function extractUrlFromClipboardText(text) {
        const match = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
        if (!match) return '';
        return match[0].replace(/[),.;!?/]+$/, '');
    }

    async function copyTextToClipboard(text) {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return;
        }
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:-9999px;opacity:0';
        document.body.appendChild(area);
        area.select();
        try {
            document.execCommand('copy');
        } finally {
            area.remove();
        }
    }

    function buildColabOneClickScript(tier = 'T4') {
        const safeTier = ['T4', 'L4', 'A100', 'auto'].includes(tier) ? tier : 'T4';
        return [
            `# STV VieNeu-TTS Colab GPU Server (${safeTier})`,
            'import os, re, sys, time, json, shutil, subprocess, urllib.request',
            'from IPython.display import HTML, clear_output, display',
            'subprocess.run("apt-get update -qq && apt-get install -y -qq espeak-ng > /dev/null 2>&1", shell=True, check=True)',
            'if not shutil.which("cloudflared"):',
            '    subprocess.run("curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared", shell=True, check=True)',
            'repo_dir = "/content/vieneu-tts"',
            'if not os.path.isdir(repo_dir):',
            '    subprocess.run(["git", "clone", "--depth", "1", "https://github.com/pnnbao97/VieNeu-TTS.git", repo_dir], check=True)',
            'subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-e", repo_dir, "fastapi", "uvicorn", "huggingface_hub", "tokenizers"], check=True)',
            'runner_path = os.path.join(repo_dir, "vieneu_colab_runner.py")',
            'try:',
            '    urllib.request.urlretrieve("https://raw.githubusercontent.com/trankhiembaolong/quick-novel-translator/main/colab/vieneu_colab_runner.py", runner_path)',
            'except Exception:',
            '    runner_path = ""',
            `env = {**os.environ, "HOST": "127.0.0.1", "PORT": "8000", "VIENEU_COLAB_GPU_TIER": "${safeTier}", "VIENEU_WATERMARK": "0", "PYTHONUNBUFFERED": "1"}`,
            'server_log = open("/content/vieneu_server.log", "w", encoding="utf-8")',
            'cmd = [sys.executable, runner_path] if (runner_path and os.path.exists(runner_path)) else [sys.executable, "-m", "apps.openai_speech"]',
            'server_proc = subprocess.Popen(cmd, cwd=repo_dir, env=env, stdout=server_log, stderr=subprocess.STDOUT)',
            'health = {}',
            'for _ in range(300):',
            '    if server_proc.poll() is not None:',
            '        raise RuntimeError(open("/content/vieneu_server.log").read()[-2000:])',
            '    try:',
            '        with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=2) as r:',
            '            if r.status == 200:',
            '                health = json.loads(r.read().decode("utf-8"))',
            '                break',
            '    except Exception:',
            '        pass',
            '    time.sleep(2)',
            'tunnel_proc = subprocess.Popen(["cloudflared", "tunnel", "--url", "http://127.0.0.1:8000", "--no-autoupdate"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)',
            'tunnel_url = ""',
            'for _ in range(300):',
            '    line = tunnel_proc.stdout.readline()',
            '    m = re.search(r"https://[a-zA-Z0-9-]+\\.trycloudflare\\.com", line or "")',
            '    if m:',
            '        tunnel_url = m.group(0)',
            '        break',
            'clear_output(wait=True)',
            'display(HTML(f"<div style=\'padding:14px;border:2px solid #10b981;border-radius:12px;background:#ecfdf5;color:#064e3b;font-family:sans-serif\'><b>🟢 {health.get(\\"gpu_name\\", \\"Colab GPU\\")} ready ({health.get(\\"export_max_streams\\", 6)} workers)</b><br><input id=\'stv-u\' readonly value=\'{tunnel_url}\' style=\'width:72%;padding:8px;margin-top:8px\'><button onclick=\\"navigator.clipboard.writeText(document.getElementById(\'stv-u\').value);this.innerText=\'✓ Copied!\'\\" style=\'padding:9px 14px;margin-left:8px;background:#10b981;color:#fff;border:0;border-radius:6px;cursor:pointer\'>📋 Copy Link</button></div>"))',
            'while server_proc.poll() is None and tunnel_proc.poll() is None:',
            '    time.sleep(5)'
        ].join('\n');
    }

    async function copyColabOneClickScript() {
        const tier = $('tts-colab-gpu')?.value || DEFAULT_SETTINGS.ttsColabGpu;
        const script = buildColabOneClickScript(tier);
        const btn = $('btn-tts-colab-copy');
        try {
            await copyTextToClipboard(script);
            if (btn) {
                btn.textContent = t('tts_colab_btn_copied');
                setTimeout(() => {
                    if (btn) btn.textContent = t('tts_colab_btn_copy');
                }, 2000);
            }
        } catch (_) {
            setColabHint(t('setup_copy_btn_tip_fail'), 'error');
        }
    }

    async function openColabNotebook() {
        try {
            await copyColabOneClickScript();
        } catch (_) {}
        try {
            if (chrome.tabs && typeof chrome.tabs.create === 'function') {
                await chrome.tabs.create({ url: COLAB_NOTEBOOK_URL });
                return;
            }
        } catch (_) {}
        window.open(COLAB_NOTEBOOK_URL, '_blank', 'noopener');
    }

    async function handleColabPasteClick() {
        const input = $('tts-colab-url');
        let clipText = '';
        try {
            if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
                clipText = await navigator.clipboard.readText();
            }
        } catch (_) {
            clipText = '';
        }
        const extracted = extractUrlFromClipboardText(clipText);
        if (!extracted || !UrlValidator || !UrlValidator.isValidUrl(extracted, ['http:', 'https:'])) {
            setColabHint(t('tts_colab_clipboard_empty'), 'error');
            if (input) input.focus();
            return;
        }
        if (input) input.value = extracted;
        state.colabOnline = false;
        await chrome.storage.local.set({ ttsColabUrl: extracted });
        await checkColabHealth({ requestPerm: true, silent: false });
    }

    // -------------------------------------------------------------------------
    // Glossary Management (In-Memory, Debounced Search, Filter Pills, JSON I/O)
    // -------------------------------------------------------------------------
    function normalizeGlossaryDict(raw) {
        const dict = {};
        if (!raw) return dict;
        if (Array.isArray(raw)) {
            raw.forEach((item) => {
                if (!item || typeof item.orig !== 'string') return;
                const orig = item.orig.trim();
                const hanviet = String(item.hanviet || item.viet || '').trim();
                if (orig && hanviet) dict[orig] = { hanviet, locked: !!item.locked };
            });
            return dict;
        }
        if (typeof raw === 'object') {
            Object.entries(raw).forEach(([orig, info]) => {
                const cleanOrig = String(orig || '').trim();
                if (!cleanOrig || !info) return;
                const hanviet = typeof info === 'string'
                    ? info.trim()
                    : String(info.hanviet || info.viet || '').trim();
                if (hanviet) dict[cleanOrig] = { hanviet, locked: !!(info && info.locked) };
            });
        }
        return dict;
    }

    function getActiveDict() {
        if (!state.profiles[state.activeProfile] || typeof state.profiles[state.activeProfile] !== 'object') {
            state.profiles[state.activeProfile] = {};
        }
        return state.profiles[state.activeProfile];
    }

    async function loadGlossaryData() {
        const all = await chrome.storage.local.get(null);
        const profiles = {};
        const prefix = 'stv_glossary_profile_';

        Object.keys(all || {}).forEach((k) => {
            if (k.startsWith(prefix)) {
                const name = k.slice(prefix.length);
                if (name) profiles[name] = normalizeGlossaryDict(all[k]);
            }
        });

        // One-time migration from legacy glossaryProfiles schema if needed
        if (Object.keys(profiles).length === 0 && all && all.glossaryProfiles && typeof all.glossaryProfiles === 'object') {
            const toMigrate = {};
            Object.entries(all.glossaryProfiles).forEach(([name, entries]) => {
                profiles[name] = normalizeGlossaryDict(entries);
                toMigrate[`${prefix}${name}`] = profiles[name];
            });
            const legacyActive = all.activeGlossaryProfile && profiles[all.activeGlossaryProfile]
                ? all.activeGlossaryProfile
                : 'Default';
            toMigrate.stv_active_glossary_profile = legacyActive;
            await chrome.storage.local.set(toMigrate);
        }

        if (!profiles.Default) profiles.Default = {};
        state.profiles = profiles;
        const storedActive = all && (all.stv_active_glossary_profile || all.activeGlossaryProfile);
        state.activeProfile = (storedActive && state.profiles[storedActive]) ? storedActive : 'Default';

        renderProfileSelect();
        renderGlossaryList();
    }

    async function persistGlossaryData(extraProfiles = []) {
        const payload = {
            stv_active_glossary_profile: state.activeProfile,
            [`stv_glossary_profile_${state.activeProfile}`]: getActiveDict()
        };
        extraProfiles.forEach((name) => {
            if (name && state.profiles[name]) {
                payload[`stv_glossary_profile_${name}`] = state.profiles[name];
            }
        });
        await chrome.storage.local.set(payload);
    }

    function renderProfileSelect() {
        const sel = $('glossary-profile-select');
        if (!sel) return;
        sel.textContent = '';
        Object.keys(state.profiles).forEach((name) => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === state.activeProfile) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    function getFilteredTerms() {
        const dict = getActiveDict();
        const q = state.searchQuery.trim().toLowerCase();
        return Object.entries(dict)
            .map(([orig, info]) => ({
                orig,
                hanviet: (info && info.hanviet) || '',
                locked: !!(info && info.locked)
            }))
            .filter((entry) => {
                if (state.filterMode === 'locked' && !entry.locked) return false;
                if (state.filterMode === 'unlocked' && entry.locked) return false;
                if (q) {
                    const orig = entry.orig.toLowerCase();
                    const viet = entry.hanviet.toLowerCase();
                    return orig.includes(q) || viet.includes(q);
                }
                return true;
            });
    }

    function updateBatchToolbar(filtered) {
        const toolbar = $('glossary-batch-actions');
        const delBtn = $('btn-delete-selected');
        const selectAll = $('select-all-terms');
        if (!toolbar || !delBtn || !selectAll) return;

        const total = Object.keys(getActiveDict()).length;
        toolbar.hidden = total === 0;
        delBtn.textContent = t('btn_delete_selected', { count: state.selectedOrigs.size });
        delBtn.disabled = state.selectedOrigs.size === 0;
        selectAll.checked = filtered.length > 0 && filtered.every((e) => state.selectedOrigs.has(e.orig));
    }

    function renderGlossaryList() {
        const listEl = $('glossary-list');
        const headingEl = $('glossary-list-heading');
        if (!listEl) return;

        const totalCount = Object.keys(getActiveDict()).length;
        const filtered = getFilteredTerms();

        if (headingEl) {
            headingEl.textContent = t('glossary_list_title', { count: totalCount }).replace(/\s*\(\d+\)\s*$/, '');
        }
        const countEl = $('glossary-count');
        if (countEl) countEl.textContent = String(totalCount);
        updateBatchToolbar(filtered);

        listEl.textContent = '';
        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'glossary-empty';
            empty.textContent = state.searchQuery.trim()
                ? t('glossary_no_match', { query: state.searchQuery.trim() })
                : t('glossary_empty');
            listEl.appendChild(empty);
            return;
        }

        const frag = document.createDocumentFragment();
        filtered.forEach((entry) => {
            const row = document.createElement('div');
            row.className = 'glossary-item';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = state.selectedOrigs.has(entry.orig);
            cb.addEventListener('change', () => {
                if (cb.checked) state.selectedOrigs.add(entry.orig);
                else state.selectedOrigs.delete(entry.orig);
                updateBatchToolbar(filtered);
            });

            const textWrap = document.createElement('div');
            textWrap.className = 'glossary-item-text';

            const origSpan = document.createElement('span');
            origSpan.className = 'glossary-item-orig';
            origSpan.textContent = entry.orig;

            const vietSpan = document.createElement('span');
            vietSpan.className = 'glossary-item-viet';
            vietSpan.textContent = entry.viet || entry.hanviet || '';

            textWrap.appendChild(origSpan);
            textWrap.appendChild(vietSpan);

            const lockBtn = document.createElement('button');
            lockBtn.type = 'button';
            lockBtn.className = 'icon-btn-sm' + (entry.locked ? ' locked' : '');
            lockBtn.textContent = entry.locked ? '🔒' : '🔓';
            lockBtn.title = entry.locked ? 'Locked' : 'Unlocked';
            lockBtn.addEventListener('click', async () => {
                const dict = getActiveDict();
                if (!dict[entry.orig]) return;
                dict[entry.orig].locked = !dict[entry.orig].locked;
                const isLocked = dict[entry.orig].locked;
                lockBtn.classList.toggle('locked', isLocked);
                lockBtn.textContent = isLocked ? '🔒' : '🔓';
                await persistGlossaryData();
                if (state.filterMode !== 'all') renderGlossaryList();
            });

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'icon-btn-sm';
            editBtn.textContent = '✏️';
            editBtn.addEventListener('click', async () => {
                const nextViet = await showPrompt(entry.orig, t('glossary_viet_ph'), entry.hanviet || '');
                if (nextViet !== null && nextViet.trim()) {
                    const dict = getActiveDict();
                    dict[entry.orig] = { hanviet: nextViet.trim(), locked: true };
                    await persistGlossaryData();
                    renderGlossaryList();
                }
            });

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'icon-btn-sm';
            delBtn.textContent = '🗑️';
            delBtn.addEventListener('click', async () => {
                const ok = await showConfirm(t('modal_delete_terms_title'), t('modal_delete_term_msg', { orig: entry.orig }));
                if (!ok) return;
                const dict = getActiveDict();
                delete dict[entry.orig];
                state.selectedOrigs.delete(entry.orig);
                await persistGlossaryData();
                renderGlossaryList();
            });

            row.appendChild(cb);
            row.appendChild(textWrap);
            row.appendChild(lockBtn);
            row.appendChild(editBtn);
            row.appendChild(delBtn);
            frag.appendChild(row);
        });
        listEl.appendChild(frag);
    }

    async function handleAddTerm() {
        const origInput = $('add-orig');
        const vietInput = $('add-hanviet');
        const orig = origInput.value.trim();
        const viet = vietInput.value.trim();
        if (!orig || !viet) return;

        const dict = getActiveDict();
        dict[orig] = { hanviet: viet, locked: true };
        origInput.value = '';
        vietInput.value = '';
        await persistGlossaryData();
        renderGlossaryList();
    }

    function handleExportGlossary() {
        const dict = getActiveDict();
        const payload = JSON.stringify({
            profile: state.activeProfile,
            exportedAt: new Date().toISOString(),
            terms: dict
        }, null, 2);
        const blob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `stv-glossary-${state.activeProfile.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    async function handleImportGlossaryFile(file) {
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const rawTerms = (parsed && typeof parsed === 'object' && parsed.terms !== undefined)
                ? parsed.terms
                : parsed;
            const incomingDict = normalizeGlossaryDict(rawTerms);
            const incomingEntries = Object.entries(incomingDict);
            if (incomingEntries.length === 0 && !Array.isArray(rawTerms) && (typeof rawTerms !== 'object' || rawTerms === null)) {
                await showAlert(t('nav_glossary'), t('glossary_import_invalid'));
                return;
            }

            const dict = getActiveDict();
            let added = 0;
            let skipped = 0;

            incomingEntries.forEach(([orig, info]) => {
                const existing = dict[orig];
                if (existing && existing.locked) {
                    skipped++;
                } else {
                    dict[orig] = { hanviet: info.hanviet, locked: !!info.locked };
                    added++;
                }
            });

            await persistGlossaryData();
            renderGlossaryList();
            await showAlert(t('nav_glossary'), t('glossary_imported', { added, skipped }));
        } catch (_) {
            await showAlert(t('nav_glossary'), t('glossary_import_invalid'));
        }
    }

    // -------------------------------------------------------------------------
    // Emoji / Icon Library (Sub-tab inside Glossary)
    // -------------------------------------------------------------------------
    function switchGlossarySubtab(target) {
        const next = target === 'icons' ? 'icons' : 'terms';
        state.glossarySubtab = next;

        const termsBtn = $('subtab-glossary-terms');
        const iconsBtn = $('subtab-glossary-icons');
        const termsPanel = $('glossary-subpanel-terms');
        const iconsPanel = $('glossary-subpanel-icons');

        if (termsBtn) {
            termsBtn.classList.toggle('active', next === 'terms');
            termsBtn.setAttribute('aria-selected', next === 'terms' ? 'true' : 'false');
        }
        if (iconsBtn) {
            iconsBtn.classList.toggle('active', next === 'icons');
            iconsBtn.setAttribute('aria-selected', next === 'icons' ? 'true' : 'false');
        }
        if (termsPanel) termsPanel.hidden = next !== 'terms';
        if (iconsPanel) iconsPanel.hidden = next !== 'icons';

        if (next === 'icons') {
            void loadIconLibraryData();
        }
    }

    function normalizeCustomIconEntryMap(raw) {
        if (IconDescriber && typeof IconDescriber.normalizeCustomIconsMap === 'function') {
            return IconDescriber.normalizeCustomIconsMap(raw);
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
            const key = String(k || '').trim();
            if (!key) continue;
            if (typeof v === 'string' && v.trim()) {
                out[key] = { meaning: v.trim(), skip: false, updatedAt: 0 };
            } else if (v && typeof v === 'object') {
                const skip = Boolean(v.skip);
                const meaning = String(v.meaning || v.text || '').trim();
                if (skip || meaning) {
                    out[key] = { meaning, skip, updatedAt: Number(v.updatedAt) || 0 };
                }
            }
        }
        return out;
    }

    async function loadIconLibraryData() {
        const data = await chrome.storage.local.get(['stv_tts_custom_icons', 'stv_tts_icon_cache']);
        state.customIcons = normalizeCustomIconEntryMap(data.stv_tts_custom_icons);
        state.learnedIcons = (data.stv_tts_icon_cache && typeof data.stv_tts_icon_cache === 'object' && !Array.isArray(data.stv_tts_icon_cache))
            ? { ...data.stv_tts_icon_cache }
            : {};
        renderIconLibraryList();
    }

    async function persistCustomIcons() {
        await chrome.storage.local.set({ stv_tts_custom_icons: state.customIcons });
    }

    async function persistLearnedIcons() {
        await chrome.storage.local.set({ stv_tts_icon_cache: state.learnedIcons });
    }

    function hasKeyVariantInMap(map, key) {
        if (!map || !key) return false;
        if (Object.prototype.hasOwnProperty.call(map, key)) return true;
        const noVs = key.replace(/\uFE0F/g, '');
        if (noVs && Object.prototype.hasOwnProperty.call(map, noVs)) return true;
        if (noVs && Object.prototype.hasOwnProperty.call(map, `${noVs}\uFE0F`)) return true;
        const lower = key.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(map, lower)) return true;
        return false;
    }

    function classifyIconKind(key, def) {
        if (def && (def.category === 'emoji' || def.category === 'kaomoji')) {
            return def.category;
        }
        if (IconDescriber && typeof IconDescriber.classifyIconCategory === 'function') {
            return IconDescriber.classifyIconCategory(key);
        }
        return 'kaomoji';
    }

    function setIconKindFilter(kind) {
        const next = kind === 'emoji' || kind === 'kaomoji' ? kind : 'all';
        state.iconKindFilter = next;
        document.querySelectorAll('[data-icon-kind]').forEach((btn) => {
            const active = btn.getAttribute('data-icon-kind') === next;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    function getMergedIconLibraryEntries() {
        const lang = I18n && I18n.getLocale() === 'en' ? 'en' : 'vi';
        const defaultEntries = (IconDescriber && typeof IconDescriber.getDefaultIconEntries === 'function')
            ? IconDescriber.getDefaultIconEntries(lang)
            : [];
        const defaultMap = new Map();
        for (const item of defaultEntries) {
            defaultMap.set(item.key, item);
        }

        const findDefaultForKey = (k) => {
            return defaultMap.get(k)
                || defaultMap.get(k.replace(/\uFE0F/g, ''))
                || defaultMap.get(`${k.replace(/\uFE0F/g, '')}\uFE0F`)
                || defaultMap.get(k.toLowerCase())
                || null;
        };

        const merged = [];

        const customList = Object.entries(state.customIcons || {}).map(([key, info]) => {
            const def = findDefaultForKey(key);
            return {
                key,
                meaning: info.meaning || '',
                skip: Boolean(info.skip),
                source: 'custom',
                category: classifyIconKind(key, def),
                hasDefault: Boolean(def),
                defaultMeaning: def ? def.meaning : '',
                updatedAt: Number(info.updatedAt) || 0
            };
        });
        customList.sort((a, b) => (b.updatedAt - a.updatedAt) || a.key.localeCompare(b.key));
        merged.push(...customList);

        const learnedList = [];
        for (const [key, info] of Object.entries(state.learnedIcons || {})) {
            if (!key || !info || hasKeyVariantInMap(state.customIcons, key)) continue;
            const meaning = typeof info === 'string'
                ? info.trim()
                : String(info[lang] || info.vi || info.en || '').trim();
            if (!meaning) continue;
            const def = findDefaultForKey(key);
            learnedList.push({
                key,
                meaning,
                skip: false,
                source: 'learned',
                category: classifyIconKind(key, def),
                hasDefault: Boolean(def),
                defaultMeaning: def ? def.meaning : '',
                ts: (typeof info === 'object' && Number(info.ts)) || 0
            });
        }
        learnedList.sort((a, b) => (b.ts - a.ts) || a.key.localeCompare(b.key));
        merged.push(...learnedList);

        for (const def of defaultEntries) {
            if (hasKeyVariantInMap(state.customIcons, def.key) || hasKeyVariantInMap(state.learnedIcons, def.key)) {
                continue;
            }
            merged.push({
                key: def.key,
                meaning: def.meaning,
                skip: false,
                source: 'default',
                category: def.category || classifyIconKind(def.key, def),
                hasDefault: true,
                defaultMeaning: def.meaning
            });
        }

        return merged;
    }

    function buildIconLibraryRow(entry) {
        const row = document.createElement('div');
        row.className = 'glossary-item icon-lib-item' + (entry.skip ? ' skipped' : '');

        const textWrap = document.createElement('div');
        textWrap.className = 'glossary-item-text';

        const head = document.createElement('div');
        head.className = 'icon-lib-head';

        const symSpan = document.createElement('span');
        symSpan.className = 'icon-lib-symbol';
        symSpan.textContent = entry.key;

        const kindKey = entry.category === 'emoji' ? 'emoji' : 'kaomoji';
        const kindBadge = document.createElement('span');
        kindBadge.className = `icon-kind-badge ${kindKey}`;
        kindBadge.textContent = t(`icon_kind_badge_${kindKey}`);

        const badge = document.createElement('span');
        const badgeKind = entry.skip ? 'skipped' : entry.source;
        badge.className = `icon-source-badge ${badgeKind}`;
        badge.textContent = t(`icon_badge_${badgeKind}`);

        head.appendChild(symSpan);
        head.appendChild(kindBadge);
        head.appendChild(badge);

        const descSpan = document.createElement('span');
        descSpan.className = 'glossary-item-viet';
        descSpan.textContent = entry.skip ? t('icon_skipped_desc') : entry.meaning;

        textWrap.appendChild(head);
        textWrap.appendChild(descSpan);

        const skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.className = 'icon-btn-sm' + (entry.skip ? ' muted-active' : '');
        skipBtn.textContent = entry.skip ? '🔇' : '🔊';
        skipBtn.title = entry.skip ? t('icon_btn_unskip_title') : t('icon_btn_skip_title');
        skipBtn.addEventListener('click', async () => {
            if (entry.skip) {
                if (entry.hasDefault && (!entry.meaning || entry.meaning === entry.defaultMeaning)) {
                    delete state.customIcons[entry.key];
                } else if (entry.meaning) {
                    state.customIcons[entry.key] = { meaning: entry.meaning, skip: false, updatedAt: Date.now() };
                } else {
                    delete state.customIcons[entry.key];
                }
            } else {
                state.customIcons[entry.key] = {
                    meaning: entry.meaning || entry.defaultMeaning || '',
                    skip: true,
                    updatedAt: Date.now()
                };
            }
            await persistCustomIcons();
            renderIconLibraryList();
        });

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'icon-btn-sm';
        editBtn.textContent = '✏️';
        editBtn.title = t('icon_btn_edit_title');
        editBtn.addEventListener('click', async () => {
            const nextMeaning = await showPrompt(entry.key, t('icon_lib_meaning_ph'), entry.meaning || entry.defaultMeaning || '');
            if (nextMeaning !== null && nextMeaning.trim()) {
                state.customIcons[entry.key] = {
                    meaning: nextMeaning.trim().slice(0, 80),
                    skip: false,
                    updatedAt: Date.now()
                };
                await persistCustomIcons();
                renderIconLibraryList();
            }
        });

        row.appendChild(textWrap);
        row.appendChild(skipBtn);
        row.appendChild(editBtn);

        if (entry.source === 'custom' || entry.source === 'learned') {
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'icon-btn-sm';
            const isReset = entry.source === 'custom' && entry.hasDefault;
            delBtn.textContent = isReset ? '↺' : '🗑️';
            delBtn.title = isReset ? t('icon_btn_reset_title') : t('icon_btn_delete_title');
            delBtn.addEventListener('click', async () => {
                const msgKey = isReset ? 'icon_lib_reset_msg' : 'icon_lib_delete_msg';
                const ok = await showConfirm(t('icon_lib_delete_title'), t(msgKey, { symbol: entry.key }));
                if (!ok) return;
                if (entry.source === 'custom') {
                    delete state.customIcons[entry.key];
                    await persistCustomIcons();
                } else {
                    delete state.learnedIcons[entry.key];
                    await persistLearnedIcons();
                }
                renderIconLibraryList();
            });
            row.appendChild(delBtn);
        }

        return row;
    }

    function renderIconLibraryList() {
        const listEl = $('icon-lib-list');
        if (!listEl) return;

        const allEntries = getMergedIconLibraryEntries();
        const learnedCount = allEntries.filter((e) => e.source === 'learned').length;
        const learnedBar = $('icon-learned-bar');
        const learnedCountEl = $('icon-learned-count');
        if (learnedBar) learnedBar.hidden = learnedCount === 0;
        if (learnedCountEl) learnedCountEl.textContent = t('icon_lib_learned_summary', { count: learnedCount });

        const q = state.iconSearchQuery.trim().toLowerCase();
        const baseFiltered = allEntries.filter((entry) => {
            if (state.iconFilterMode === 'custom' && entry.source !== 'custom') return false;
            if (state.iconFilterMode === 'skipped' && !entry.skip) return false;
            if (state.iconFilterMode === 'learned' && entry.source !== 'learned') return false;
            if (state.iconFilterMode === 'default' && entry.source !== 'default') return false;
            if (q) {
                return entry.key.toLowerCase().includes(q) || entry.meaning.toLowerCase().includes(q);
            }
            return true;
        });

        const emojiCount = baseFiltered.filter((e) => e.category === 'emoji').length;
        const kaomojiCount = baseFiltered.length - emojiCount;
        const countAllEl = $('icon-kind-count-all');
        const countEmojiEl = $('icon-kind-count-emoji');
        const countKaomojiEl = $('icon-kind-count-kaomoji');
        if (countAllEl) countAllEl.textContent = String(baseFiltered.length);
        if (countEmojiEl) countEmojiEl.textContent = String(emojiCount);
        if (countKaomojiEl) countKaomojiEl.textContent = String(kaomojiCount);

        const filtered = state.iconKindFilter === 'all'
            ? baseFiltered
            : baseFiltered.filter((e) => e.category === state.iconKindFilter);

        const countEl = $('icon-lib-count');
        if (countEl) countEl.textContent = String(filtered.length);

        listEl.textContent = '';
        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'glossary-empty';
            empty.textContent = q
                ? t('icon_lib_no_match', { query: state.iconSearchQuery.trim() })
                : t('icon_lib_empty');
            listEl.appendChild(empty);
            return;
        }

        const frag = document.createDocumentFragment();
        const appendSectionHeader = (kindKey, count) => {
            const hdr = document.createElement('div');
            hdr.className = `icon-section-header ${kindKey}`;
            hdr.textContent = t(`icon_section_${kindKey}`, { count });
            frag.appendChild(hdr);
        };

        if (state.iconKindFilter === 'all') {
            const emojiItems = filtered.filter((e) => e.category === 'emoji');
            const kaomojiItems = filtered.filter((e) => e.category !== 'emoji');
            if (emojiItems.length > 0 && kaomojiItems.length > 0) {
                appendSectionHeader('emoji', emojiItems.length);
                emojiItems.forEach((entry) => frag.appendChild(buildIconLibraryRow(entry)));
                appendSectionHeader('kaomoji', kaomojiItems.length);
                kaomojiItems.forEach((entry) => frag.appendChild(buildIconLibraryRow(entry)));
                listEl.appendChild(frag);
                return;
            }
        }

        filtered.forEach((entry) => {
            frag.appendChild(buildIconLibraryRow(entry));
        });

        listEl.appendChild(frag);
    }

    async function handleAddIconEntry() {
        const symInput = $('add-icon-symbol');
        const meanInput = $('add-icon-meaning');
        const skipCb = $('add-icon-skip');

        const rawSym = symInput.value.trim();
        const key = (IconDescriber && typeof IconDescriber.normalizeCacheKey === 'function')
            ? IconDescriber.normalizeCacheKey(rawSym)
            : rawSym;
        if (!key) {
            symInput.focus();
            return;
        }
        const skip = Boolean(skipCb && skipCb.checked);
        const meaning = meanInput.value.trim().slice(0, 80);
        if (!skip && !meaning) {
            meanInput.focus();
            return;
        }

        state.customIcons[key] = {
            meaning: skip ? '' : meaning,
            skip,
            updatedAt: Date.now()
        };

        symInput.value = '';
        meanInput.value = '';
        if (skipCb) skipCb.checked = false;
        meanInput.disabled = false;

        const addedCat = classifyIconKind(key, null);
        if (state.iconKindFilter !== 'all' && state.iconKindFilter !== addedCat) {
            setIconKindFilter(addedCat);
        }

        await persistCustomIcons();
        renderIconLibraryList();
    }

    function handleExportIconLibrary() {
        const payload = JSON.stringify({
            version: 1,
            exportedAt: new Date().toISOString(),
            customIcons: state.customIcons,
            learnedIcons: state.learnedIcons
        }, null, 2);
        const blob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'stv-emoji-library.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    async function handleImportIconLibraryFile(file) {
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                await showAlert(t('glossary_subtab_icons'), t('icon_lib_import_invalid'));
                return;
            }
            const rawCustom = parsed.customIcons !== undefined
                ? parsed.customIcons
                : (parsed.icons !== undefined ? parsed.icons : parsed);
            const normalized = normalizeCustomIconEntryMap(rawCustom);
            const entries = Object.entries(normalized);
            if (entries.length === 0) {
                await showAlert(t('glossary_subtab_icons'), t('icon_lib_import_invalid'));
                return;
            }
            const now = Date.now();
            entries.forEach(([k, info]) => {
                state.customIcons[k] = {
                    meaning: info.meaning,
                    skip: Boolean(info.skip),
                    updatedAt: info.updatedAt || now
                };
            });
            await persistCustomIcons();
            renderIconLibraryList();
            await showAlert(t('glossary_subtab_icons'), t('icon_lib_imported', { added: entries.length }));
        } catch (_) {
            await showAlert(t('glossary_subtab_icons'), t('icon_lib_import_invalid'));
        }
    }

    // -------------------------------------------------------------------------
    // Cleanup & Move Modals
    // -------------------------------------------------------------------------
    function openCleanupModal() {
        if (!GlossaryUtils || typeof GlossaryUtils.analyzeGlossaryEntries !== 'function') return;
        const dict = getActiveDict();
        const issues = GlossaryUtils.analyzeGlossaryEntries(dict);
        state.cleanIssues = issues;

        const overlay = $('clean-glossary-overlay');
        const summary = $('clean-summary');
        const toolbar = $('clean-toolbar');
        const issueList = $('clean-issue-list');
        const applyBtn = $('btn-clean-apply');
        const selectAll = $('clean-select-all');
        const countEl = $('clean-selected-count');

        issueList.textContent = '';
        if (issues.length === 0) {
            summary.textContent = '0 issues found.';
            toolbar.hidden = true;
            applyBtn.disabled = true;
        } else {
            summary.textContent = `${issues.length} potential issues found:`;
            toolbar.hidden = false;
            selectAll.checked = true;
            applyBtn.disabled = false;

            issues.forEach((issue, idx) => {
                const row = document.createElement('label');
                row.className = 'glossary-item';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;
                cb.dataset.issueIdx = String(idx);
                cb.addEventListener('change', () => {
                    const checkedCount = issueList.querySelectorAll('input[type="checkbox"]:checked').length;
                    countEl.textContent = `${checkedCount}/${issues.length}`;
                    applyBtn.disabled = checkedCount === 0;
                });

                const txt = document.createElement('div');
                txt.className = 'glossary-item-text';
                const o = document.createElement('span');
                o.className = 'glossary-item-orig';
                o.textContent = issue.orig;
                const r = document.createElement('span');
                r.className = 'glossary-item-viet';
                r.textContent = `${issue.viet || issue.hanviet || ''} (${issue.reason || 'junk'})`;
                txt.appendChild(o);
                txt.appendChild(r);

                row.appendChild(cb);
                row.appendChild(txt);
                issueList.appendChild(row);
            });
            countEl.textContent = `${issues.length}/${issues.length}`;
        }
        overlay.hidden = false;
    }

    function openMoveModal() {
        const sel = $('move-target-profile');
        sel.textContent = '';
        Object.keys(state.profiles)
            .filter((name) => name !== state.activeProfile)
            .forEach((name) => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                sel.appendChild(opt);
            });
        $('move-modal-status').textContent = '';
        $('move-glossary-overlay').hidden = false;
    }

    // -------------------------------------------------------------------------
    // Event Wiring & Init
    // -------------------------------------------------------------------------
    function bindEvents() {
        // Header toggles
        $('btn-lang-toggle').addEventListener('click', async () => {
            if (!I18n) return;
            const next = I18n.getLocale() === 'vi' ? 'en' : 'vi';
            await I18n.saveLocale(next);
            refreshLocalizedUI();
        });

        $('btn-theme-toggle').addEventListener('click', async () => {
            const current = document.documentElement.getAttribute('data-theme') || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            applyTheme(next);
            await chrome.storage.local.set({ stv_theme: next });
        });

        $('settings-locale').addEventListener('change', async (e) => {
            if (!I18n) return;
            await I18n.saveLocale(e.target.value);
            refreshLocalizedUI();
        });

        // Onboarding
        $('btn-onboarding-save').addEventListener('click', async () => {
            const key = $('onboarding-api-key').value.trim();
            if (!key) return;
            await chrome.storage.local.set({ apikey: key });
            $('api-key').value = key;
            $('onboarding-card').hidden = true;
            $('status-text').textContent = t('status_ready');
        });

        // Site permission & selector
        $('btn-grant-site').addEventListener('click', ensureSitePermission);
        $('btn-clear-selector').addEventListener('click', async () => {
            if (!state.activeHost) return;
            await chrome.storage.local.remove(`stv_selector_${state.activeHost}`);
            state.savedSelector = null;
            renderSitePermissionUI();
            $('status-text').textContent = t('status_selector_cleared', { host: state.activeHost });
        });

        // Translate tab
        $('main-model').addEventListener('input', () => {
            $('api-model').value = $('main-model').value;
        });
        $('main-model').addEventListener('change', async () => {
            const model = $('main-model').value.trim() || DEFAULT_SETTINGS.model;
            $('api-model').value = model;
            await chrome.storage.local.set({ model });
        });
        $('main-model').addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                openModelDropdown();
            }
        });
        $('btn-fetch-models').addEventListener('click', () => { void handleFetchModelsClick(); });
        $('btn-model-dropdown').addEventListener('click', () => {
            const panel = $('model-dropdown-panel');
            if (panel && typeof panel.showPopover === 'function') return;
            toggleModelDropdown();
        });
        $('model-search-input').addEventListener('input', (e) => {
            state.modelSearchQuery = e.target.value;
            renderModelDropdown();
        });
        $('model-search-input').addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const firstBtn = $('model-dropdown-list')?.querySelector('.model-option-btn');
                if (firstBtn) firstBtn.focus();
            } else if (e.key === 'Enter') {
                const firstBtn = $('model-dropdown-list')?.querySelector('.model-option-btn');
                if (firstBtn) {
                    e.preventDefault();
                    void selectModelFromDropdown(firstBtn.dataset.modelId);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeModelDropdown({ restoreFocus: true });
            }
        });
        $('model-dropdown-list').addEventListener('keydown', (e) => {
            const buttons = Array.from($('model-dropdown-list').querySelectorAll('.model-option-btn'));
            if (buttons.length === 0) return;
            const currentIdx = buttons.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % buttons.length;
                buttons[nextIdx].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (currentIdx <= 0) {
                    $('model-search-input').focus();
                } else {
                    buttons[currentIdx - 1].focus();
                }
            } else if (e.key === 'Home') {
                e.preventDefault();
                buttons[0].focus();
            } else if (e.key === 'End') {
                e.preventDefault();
                buttons[buttons.length - 1].focus();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeModelDropdown({ restoreFocus: true });
            }
        });
        const dropdownPanel = $('model-dropdown-panel');
        if (dropdownPanel) {
            dropdownPanel.addEventListener('beforetoggle', (e) => {
                if (e.newState === 'open') {
                    renderModelDropdown();
                }
            });
            dropdownPanel.addEventListener('toggle', (e) => {
                const isOpen = e.newState === 'open' || (typeof dropdownPanel.matches === 'function' && dropdownPanel.matches(':popover-open'));
                state.modelDropdownOpen = isOpen;
                const triggerBtn = $('btn-model-dropdown');
                if (triggerBtn) triggerBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                if (isOpen) {
                    positionModelDropdownFallback();
                    setTimeout(() => {
                        const searchInput = $('model-search-input');
                        if (searchInput) searchInput.focus();
                        const selectedBtn = $('model-dropdown-list')?.querySelector('.model-option-btn.selected');
                        if (selectedBtn && typeof selectedBtn.scrollIntoView === 'function') {
                            selectedBtn.scrollIntoView({ block: 'nearest' });
                        }
                    }, 0);
                }
            });
            document.addEventListener('click', (e) => {
                if (!state.modelDropdownOpen || typeof dropdownPanel.showPopover === 'function') return;
                const pickerField = document.querySelector('.model-picker-field');
                if (pickerField && !pickerField.contains(e.target)) {
                    closeModelDropdown();
                }
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && state.modelDropdownOpen && typeof dropdownPanel.showPopover !== 'function') {
                    closeModelDropdown({ restoreFocus: true });
                }
            });
        }
        $('btn-translate').addEventListener('click', handleTranslateClick);
        $('btn-pick').addEventListener('click', handlePickClick);

        // TTS tab
        $('tts-engine-select').addEventListener('change', async (e) => {
            const engine = e.target.value;
            const ttsStatusEl = $('tts-status-text');
            if (ttsStatusEl && ttsStatusEl.classList.contains('error')) {
                ttsStatusEl.classList.remove('error');
                ttsStatusEl.textContent = t('tts_status_idle');
            }
            toggleVieNeuCard(engine);
            await chrome.storage.local.set({ ttsEngine: engine });
            if (engine === 'vieneu') {
                await checkVieNeuHealth();
            } else {
                const stored = await chrome.storage.local.get(['ttsWsVoice']);
                populateVoiceQuickSelect(engine, stored.ttsWsVoice || DEFAULT_SETTINGS.ttsWsVoice);
            }
        });
        $('tts-voice-quick').addEventListener('change', async (e) => {
            const engine = $('tts-engine-select')?.value || 'ws_default';
            if (engine === 'vieneu') {
                await chrome.storage.local.set({ ttsVoice: e.target.value.trim() });
            } else {
                const voice = e.target.value.trim() || DEFAULT_SETTINGS.ttsWsVoice;
                $('tts-ws-voice').value = voice;
                await chrome.storage.local.set({ ttsWsVoice: voice });
            }
        });
        $('tts-speed-range').addEventListener('input', (e) => {
            $('tts-speed-label-val').textContent = `${Number(e.target.value).toFixed(1)}x`;
        });
        $('tts-speed-range').addEventListener('change', async (e) => {
            await chrome.storage.local.set({ ttsSpeed: Number(e.target.value) || 1.0 });
        });
        $('btn-tts-play').addEventListener('click', handleTtsPlay);
        $('btn-tts-stop').addEventListener('click', handleTtsStop);
        $('tts-download-minutes').addEventListener('input', (e) => {
            e.target.setCustomValidity('');
            const ttsStatusEl = $('tts-status-text');
            if (ttsStatusEl && ttsStatusEl.classList.contains('error')) {
                ttsStatusEl.classList.remove('error');
                ttsStatusEl.textContent = t('tts_status_idle');
            }
        });
        $('tts-download-minutes').addEventListener('change', async (e) => {
            const mins = Math.min(240, Math.max(1, parseInt(e.target.value, 10) || DEFAULT_SETTINGS.ttsDownloadMinutes));
            e.target.value = mins;
            await chrome.storage.local.set({ ttsDownloadMinutes: mins });
        });
        $('tts-export-translate-concurrency').addEventListener('change', async (e) => {
            const conc = normalizeExportTranslateConcurrency(e.target.value);
            e.target.value = String(conc);
            await chrome.storage.local.set({ ttsExportTranslateConcurrency: conc });
        });
        $('btn-tts-download').addEventListener('click', handleTtsDownload);
        $('tts-download-source').addEventListener('change', async (e) => {
            const source = e.target.value === 'colab_gpu' ? 'colab_gpu' : 'current';
            toggleColabPanel(source);
            await chrome.storage.local.set({ ttsDownloadSource: source });
            if (source === 'colab_gpu' && $('tts-colab-url').value.trim()) {
                await checkColabHealth({ requestPerm: false, silent: true });
            }
        });
        $('btn-tts-colab-open').addEventListener('click', openColabNotebook);
        $('btn-tts-colab-copy').addEventListener('click', copyColabOneClickScript);
        $('btn-tts-colab-paste').addEventListener('click', handleColabPasteClick);
        $('tts-colab-url').addEventListener('change', async (e) => {
            const clean = e.target.value.trim().replace(/\/+$/, '');
            e.target.value = clean;
            state.colabOnline = false;
            await chrome.storage.local.set({ ttsColabUrl: clean });
            if (clean) {
                await checkColabHealth({ requestPerm: true, silent: false });
            } else {
                updateColabStatusUI();
                setColabHint(t('tts_colab_step_hint'));
            }
        });
        $('tts-colab-url').addEventListener('paste', () => {
            setTimeout(() => {
                const clean = ($('tts-colab-url')?.value || '').trim().replace(/\/+$/, '');
                if (clean && UrlValidator?.isValidUrl(clean, ['http:', 'https:'])) {
                    $('tts-colab-url').value = clean;
                    state.colabOnline = false;
                    void chrome.storage.local.set({ ttsColabUrl: clean });
                    void checkColabHealth({ requestPerm: true, silent: false });
                }
            }, 0);
        });
        $('tts-colab-voice').addEventListener('change', async (e) => {
            await chrome.storage.local.set({ ttsColabVoice: e.target.value.trim() });
        });
        $('tts-colab-gpu').addEventListener('change', async (e) => {
            const tier = ['T4', 'L4', 'A100', 'auto'].includes(e.target.value) ? e.target.value : 'T4';
            await chrome.storage.local.set({ ttsColabGpu: tier });
            updateColabStatusUI();
        });
        $('btn-tts-server-toggle').addEventListener('click', toggleVieNeuServer);
        $('btn-vieneu-install-guide').addEventListener('click', showVieNeuGuide);

        // Glossary tab
        $('glossary-profile-select').addEventListener('change', async (e) => {
            state.activeProfile = e.target.value;
            state.selectedOrigs.clear();
            await persistGlossaryData();
            renderGlossaryList();
        });
        $('btn-new-profile').addEventListener('click', async () => {
            const name = await showPrompt(t('modal_new_profile_title'), '', '', t('modal_new_profile_ph'));
            if (!name || !name.trim()) return;
            const clean = name.trim();
            if (state.profiles[clean]) {
                await showAlert(t('modal_new_profile_title'), t('modal_profile_exists'));
                return;
            }
            state.profiles[clean] = {};
            state.activeProfile = clean;
            state.selectedOrigs.clear();
            await persistGlossaryData();
            renderProfileSelect();
            renderGlossaryList();
        });
        $('btn-delete-profile').addEventListener('click', async () => {
            if (state.activeProfile === 'Default') {
                await showAlert(t('modal_delete_profile_title'), t('modal_delete_default_err'));
                return;
            }
            const ok = await showConfirm(
                t('modal_delete_profile_title'),
                t('modal_delete_profile_msg', { name: state.activeProfile })
            );
            if (!ok) return;
            const deletedProfile = state.activeProfile;
            delete state.profiles[deletedProfile];
            state.activeProfile = 'Default';
            state.selectedOrigs.clear();
            await chrome.storage.local.remove(`stv_glossary_profile_${deletedProfile}`);
            await persistGlossaryData();
            renderProfileSelect();
            renderGlossaryList();
        });
        $('btn-add-term').addEventListener('click', handleAddTerm);
        $('glossary-search-input').addEventListener('input', (e) => {
            const val = e.target.value;
            $('btn-clear-search').hidden = !val;
            clearTimeout(state.searchTimer);
            state.searchTimer = setTimeout(() => {
                state.searchQuery = val;
                renderGlossaryList();
            }, 150);
        });
        $('btn-clear-search').addEventListener('click', () => {
            $('glossary-search-input').value = '';
            $('btn-clear-search').hidden = true;
            state.searchQuery = '';
            renderGlossaryList();
        });
        document.querySelectorAll('.pill-btn[data-filter]').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.pill-btn[data-filter]').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                state.filterMode = btn.getAttribute('data-filter') || 'all';
                renderGlossaryList();
            });
        });
        $('select-all-terms').addEventListener('change', (e) => {
            const filtered = getFilteredTerms();
            if (e.target.checked) {
                filtered.forEach((item) => state.selectedOrigs.add(item.orig));
            } else {
                filtered.forEach((item) => state.selectedOrigs.delete(item.orig));
            }
            renderGlossaryList();
        });
        $('btn-delete-selected').addEventListener('click', async () => {
            const count = state.selectedOrigs.size;
            if (!count) return;
            const ok = await showConfirm(t('modal_delete_terms_title'), t('modal_delete_terms_msg', { count }));
            if (!ok) return;
            const dict = getActiveDict();
            state.selectedOrigs.forEach((orig) => { delete dict[orig]; });
            state.selectedOrigs.clear();
            await persistGlossaryData();
            renderGlossaryList();
        });
        $('btn-export-glossary').addEventListener('click', handleExportGlossary);
        $('btn-import-glossary').addEventListener('click', () => $('glossary-import-file').click());
        $('glossary-import-file').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            await handleImportGlossaryFile(file);
            e.target.value = '';
        });

        // Glossary / Emoji sub-tabs
        $('subtab-glossary-terms').addEventListener('click', () => switchGlossarySubtab('terms'));
        $('subtab-glossary-icons').addEventListener('click', () => switchGlossarySubtab('icons'));
        $('add-icon-skip').addEventListener('change', (e) => {
            $('add-icon-meaning').disabled = Boolean(e.target.checked);
        });
        $('btn-add-icon').addEventListener('click', handleAddIconEntry);
        $('add-icon-symbol').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); void handleAddIconEntry(); }
        });
        $('add-icon-meaning').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); void handleAddIconEntry(); }
        });
        $('icon-search-input').addEventListener('input', (e) => {
            const val = e.target.value;
            $('btn-clear-icon-search').hidden = !val;
            clearTimeout(state.iconSearchTimer);
            state.iconSearchTimer = setTimeout(() => {
                state.iconSearchQuery = val;
                renderIconLibraryList();
            }, 150);
        });
        $('btn-clear-icon-search').addEventListener('click', () => {
            $('icon-search-input').value = '';
            $('btn-clear-icon-search').hidden = true;
            state.iconSearchQuery = '';
            renderIconLibraryList();
        });
        document.querySelectorAll('.pill-btn[data-icon-filter]').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.pill-btn[data-icon-filter]').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                state.iconFilterMode = btn.getAttribute('data-icon-filter') || 'all';
                renderIconLibraryList();
            });
        });
        document.querySelectorAll('[data-icon-kind]').forEach((btn) => {
            btn.addEventListener('click', () => {
                setIconKindFilter(btn.getAttribute('data-icon-kind'));
                renderIconLibraryList();
            });
        });
        $('btn-clear-learned-icons').addEventListener('click', async () => {
            const count = Object.keys(state.learnedIcons || {}).length;
            if (!count) return;
            const ok = await showConfirm(
                t('icon_lib_clear_learned'),
                t('icon_lib_clear_learned_confirm', { count })
            );
            if (!ok) return;
            state.learnedIcons = {};
            await persistLearnedIcons();
            renderIconLibraryList();
        });
        $('btn-export-icons').addEventListener('click', handleExportIconLibrary);
        $('btn-import-icons').addEventListener('click', () => $('icon-import-file').click());
        $('icon-import-file').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            await handleImportIconLibraryFile(file);
            e.target.value = '';
        });
        $('btn-open-icon-lib').addEventListener('click', () => {
            switchMainTab('glossary');
            switchGlossarySubtab('icons');
        });

        // Cleanup modal
        $('btn-scan-cleanup').addEventListener('click', openCleanupModal);
        $('btn-clean-cancel').addEventListener('click', () => { $('clean-glossary-overlay').hidden = true; });
        $('clean-select-all').addEventListener('change', (e) => {
            const boxes = $('clean-issue-list').querySelectorAll('input[type="checkbox"]');
            boxes.forEach((b) => { b.checked = e.target.checked; });
            const checked = e.target.checked ? boxes.length : 0;
            $('clean-selected-count').textContent = `${checked}/${boxes.length}`;
            $('btn-clean-apply').disabled = checked === 0;
        });
        $('btn-clean-apply').addEventListener('click', async () => {
            const checked = $('clean-issue-list').querySelectorAll('input[type="checkbox"]:checked');
            const dict = getActiveDict();
            checked.forEach((cb) => {
                const idx = Number(cb.dataset.issueIdx);
                if (state.cleanIssues[idx]) {
                    delete dict[state.cleanIssues[idx].orig];
                    state.selectedOrigs.delete(state.cleanIssues[idx].orig);
                }
            });
            await persistGlossaryData();
            $('clean-glossary-overlay').hidden = true;
            renderGlossaryList();
        });

        // Move modal
        $('btn-move-used').addEventListener('click', openMoveModal);
        $('btn-move-cancel').addEventListener('click', () => { $('move-glossary-overlay').hidden = true; });
        $('btn-move-confirm').addEventListener('click', async () => {
            const target = $('move-target-profile').value;
            if (!target || !state.profiles[target]) return;
            const selected = state.selectedOrigs;
            if (selected.size === 0) {
                $('move-modal-status').textContent = 'Select terms first.';
                return;
            }
            const sourceDict = getActiveDict();
            const targetDict = state.profiles[target];
            selected.forEach((orig) => {
                if (sourceDict[orig]) {
                    targetDict[orig] = sourceDict[orig];
                    delete sourceDict[orig];
                }
            });

            state.selectedOrigs.clear();
            await persistGlossaryData([target]);
            $('move-glossary-overlay').hidden = true;
            renderGlossaryList();
        });

        // Settings tab
        $('btn-toggle-apikey').addEventListener('click', () => {
            const input = $('api-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });
        $('api-shortcut').addEventListener('keydown', (e) => {
            e.preventDefault();
            const parts = [];
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
            if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
                parts.push(key);
                $('api-shortcut').value = parts.join('+');
            }
        });
        $('btn-save').addEventListener('click', () => { void saveAllSettings({ requestHostPermission: true }); });
        $('api-endpoint').addEventListener('input', () => { void refreshApiEndpointPermission(); });
        $('api-endpoint').addEventListener('change', () => { void refreshApiEndpointPermission(); });
        $('btn-grant-api-host').addEventListener('click', () => {
            const endpoint = $('api-endpoint')?.value.trim() || DEFAULT_SETTINGS.endpoint;
            const info = parseApiEndpointOrigin(endpoint);
            if (!info || !chrome.permissions || typeof chrome.permissions.request !== 'function') return;
            state.apiEndpointHost = info.host;
            state.apiEndpointOriginPattern = info.originPattern;
            chrome.permissions.request({ origins: [info.originPattern] })
                .then(async (granted) => {
                    state.hasApiEndpointPerm = Boolean(granted);
                    renderApiEndpointPermissionUI();
                    try {
                        await chrome.runtime.sendMessage({ action: 'sync_api_dnr_rules', endpoint });
                    } catch (_) {}
                })
                .catch(() => {
                    state.hasApiEndpointPerm = false;
                    renderApiEndpointPermissionUI();
                });
        });
        ['tts-ws-fallback', 'tts-autoplay', 'tts-autonext', 'tts-icon-mode', 'tts-icon-style', 'settings-debug-log'].forEach((id) => {
            const ctrl = $(id);
            if (ctrl) ctrl.addEventListener('change', () => { void saveAllSettings(); });
        });
    }

    async function init() {
        initTabs();
        bindEvents();
        if (I18n) {
            await I18n.loadSavedLocale();
        }
        await Promise.all([
            loadSettingsIntoUI(),
            refreshActiveTabInfo(),
            loadGlossaryData(),
            loadIconLibraryData()
        ]);
        refreshLocalizedUI();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
