/**
 * Quick Novel Translator (STV) - Interactive VieNeu-TTS Setup & Diagnostics Page
 * Chrome Web Store compliant (MV3 strict CSP, no inline handlers/scripts).
 */
(function () {
    'use strict';

    // Direct download URL for the optional Windows Companion package on GitHub Releases.
    const COMPANION_DOWNLOAD_URL = 'https://github.com/trankhiembaolong/quick-novel-translator/releases/download/v1.0/STV-VieNeu-Companion-Windows-v1.0.zip';
    const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';

    const I18n = window.STV_I18n;
    const UrlValidator = window.STV_UrlValidator;
    const $ = (id) => document.getElementById(id);
    const t = (key, params) => (I18n ? I18n.t(key, params) : key);

    const state = {
        selectedHw: 'win-cpu',
        serverOnline: false,
        voiceCount: 0,
        lastDiagnosticsStatus: null,
        lastHostDiag: { key: 'setup_host_detail_idle', params: null, tone: 'neutral', badgeKey: 'setup_diag_host_not_installed', badgeClass: '' }
    };

    const copyTimers = new WeakMap();
    let lastCopyAnnouncement = '';

    function sendBgMessage(payload) {
        return new Promise((resolve) => {
            if (!chrome?.runtime?.sendMessage) {
                resolve({ ok: false, error: 'Extension runtime unavailable' });
                return;
            }
            chrome.runtime.sendMessage(payload, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message || 'Runtime error' });
                    return;
                }
                resolve(response || { ok: false, error: 'Empty response' });
            });
        });
    }

    function applyTheme(theme) {
        const next = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        const btn = $('btn-setup-theme');
        if (btn) btn.textContent = next === 'dark' ? '🌙' : '☀️';
    }

    function applyLocaleToPage() {
        const locale = I18n ? I18n.getLocale() : 'vi';
        document.documentElement.lang = locale;
        if (I18n) {
            I18n.applyToDOM(document);
        }
        document.title = t('setup_page_title');
        const langBtn = $('btn-setup-lang');
        if (langBtn) langBtn.textContent = locale.toUpperCase();
        renderCachedDiagnostics();
    }

    function renderCachedDiagnostics() {
        const serverText = $('diag-server-text');
        const serverBadge = $('diag-server-badge');
        if (serverText && serverBadge) {
            serverBadge.classList.toggle('online', state.serverOnline);
            if (state.serverOnline) {
                serverText.textContent = state.voiceCount > 0
                    ? t('setup_diag_server_online', { voices: state.voiceCount })
                    : t('setup_diag_server_online_default');
            } else {
                serverText.textContent = t('setup_diag_server_offline');
            }
        }

        const hostBadge = $('diag-host-badge');
        const hostText = $('diag-host-text');
        const hostDetail = $('native-host-diag-detail');
        if (hostBadge && hostText && state.lastHostDiag.badgeKey) {
            hostBadge.className = `badge${state.lastHostDiag.badgeClass ? ' ' + state.lastHostDiag.badgeClass : ''}`;
            hostText.textContent = t(state.lastHostDiag.badgeKey, state.lastHostDiag.badgeParams || undefined);
        }
        if (hostDetail && state.lastHostDiag.key) {
            hostDetail.className = `muted host-detail-text${state.lastHostDiag.tone === 'success' ? ' is-success' : state.lastHostDiag.tone === 'error' ? ' is-error' : ''}`;
            hostDetail.textContent = t(state.lastHostDiag.key, state.lastHostDiag.params || undefined);
        }
    }

    function setLiveFeedback(text, tone = 'neutral') {
        const el = $('diag-live-status');
        if (!el) return;
        el.className = 'diag-feedback';
        if (tone === 'success') el.classList.add('is-success');
        if (tone === 'error') el.classList.add('is-error');
        el.textContent = text || '';
    }

    function isLikelyWindows() {
        const plat = (navigator.userAgentData && navigator.userAgentData.platform)
            || navigator.platform
            || navigator.userAgent
            || '';
        if (!plat) return true;
        return /win/i.test(plat);
    }

    function parsePortFromUrl(url) {
        try {
            const parsed = new URL(url || DEFAULT_SERVER_URL);
            if (parsed.port) return Number(parsed.port);
            return parsed.protocol === 'https:' ? 443 : 8000;
        } catch (_) {
            return 8000;
        }
    }

    function getRecommendedBackendForTab() {
        if (state.selectedHw === 'win-nvidia') return 'pytorch';
        if (state.selectedHw === 'win-amd') return 'amd_gpu';
        if (state.selectedHw === 'win-cpu') return 'cpu_fp32';
        return 'auto';
    }

    // -------------------------------------------------------------------------
    // Accessible Copy Buttons (Invoker Commands + Async Clipboard + Fallback)
    // -------------------------------------------------------------------------
    function legacyCopy(text) {
        const field = Object.assign(document.createElement('textarea'), { value: text });
        field.setAttribute('readonly', '');
        field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
        document.body.append(field);
        field.select();
        try {
            return document.execCommand('copy');
        } finally {
            field.remove();
        }
    }

    function reportCopy(button, ok) {
        const wrapper = button.closest('.copy');
        const tip = wrapper ? wrapper.querySelector('.tip') : null;
        clearTimeout(copyTimers.get(button));
        button.removeAttribute('data-copied');
        button.removeAttribute('data-failed');

        let message = ok ? t('setup_copy_btn_tip_ok') : t('setup_copy_btn_tip_fail');
        if (message === lastCopyAnnouncement) {
            message += '\u00A0';
        }
        lastCopyAnnouncement = message;

        if (tip) tip.textContent = '';
        void button.offsetWidth;
        button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
        if (tip) {
            requestAnimationFrame(() => {
                tip.textContent = message;
            });
        }
        copyTimers.set(button, setTimeout(() => {
            button.removeAttribute('data-copied');
            button.removeAttribute('data-failed');
            if (tip) tip.textContent = '';
        }, 2000));
    }

    async function copyTargetText(button, target) {
        if (!button || !target) return;
        const text = target.matches('input, textarea')
            ? target.value
            : (target.innerText || target.textContent || '').trim();
        if (!text) return;
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(text);
                reportCopy(button, true);
                return;
            }
            if (!legacyCopy(text)) throw new Error('Copy failed');
            reportCopy(button, true);
        } catch (_) {
            try {
                if (legacyCopy(text)) {
                    reportCopy(button, true);
                    return;
                }
            } catch (_) {
                // Fall through to report failure
            }
            reportCopy(button, false);
        }
    }

    function initCopyButtons() {
        document.addEventListener('command', (event) => {
            if (event.command && event.command.startsWith('--copy')) {
                void copyTargetText(event.source, event.target);
            }
        }, true);

        if (!('CommandEvent' in window)) {
            document.addEventListener('click', (event) => {
                const button = event.target.closest('button[command^="--copy"]');
                if (!button) return;
                const targetId = button.getAttribute('commandfor');
                const target = targetId ? document.getElementById(targetId) : null;
                if (target) void copyTargetText(button, target);
            });
        }
    }

    // -------------------------------------------------------------------------
    // Accessible Hardware / Platform Tabs (selection follows focus + beforematch)
    // -------------------------------------------------------------------------
    function selectHwTab(selectedTab, { focus = false } = {}) {
        const tablist = document.querySelector('.hw-tablist');
        if (!tablist || !selectedTab) return;
        const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
        const hw = selectedTab.dataset.hw;
        state.selectedHw = hw || 'win-cpu';

        for (const tab of tabs) {
            const isActive = tab === selectedTab;
            tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
            tab.toggleAttribute('focusgroupstart', isActive);
            tab.tabIndex = isActive ? 0 : -1;
        }

        const panels = document.querySelectorAll('.hw-panels-grid > [role="tabpanel"]');
        panels.forEach((panel) => {
            const isMatch = panel.dataset.hw === hw;
            if (isMatch) {
                panel.removeAttribute('hidden');
            } else {
                panel.setAttribute('hidden', 'until-found');
            }
        });

        if (typeof selectedTab.scrollIntoView === 'function') {
            selectedTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        if (focus) {
            selectedTab.focus();
        }
    }

    function initHardwareTabs() {
        const tablist = document.querySelector('.hw-tablist');
        if (!tablist) return;
        const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));

        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                selectHwTab(tab);
            });
            tab.addEventListener('focus', () => {
                if (tab.getAttribute('aria-selected') !== 'true') {
                    selectHwTab(tab);
                }
            });
        });

        if (!Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
            tablist.addEventListener('keydown', (event) => {
                const currentIndex = tabs.indexOf(document.activeElement);
                if (currentIndex === -1) return;
                let nextIndex = -1;
                if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
                else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                else if (event.key === 'Home') nextIndex = 0;
                else if (event.key === 'End') nextIndex = tabs.length - 1;
                if (nextIndex !== -1) {
                    event.preventDefault();
                    selectHwTab(tabs[nextIndex], { focus: true });
                }
            });
        }

        const panels = document.querySelectorAll('.hw-panels-grid > [role="tabpanel"]');
        panels.forEach((panel) => {
            panel.addEventListener('beforematch', () => {
                const tabId = panel.getAttribute('aria-labelledby');
                const tab = tabId ? document.getElementById(tabId) : null;
                if (tab) selectHwTab(tab);
            });
        });
    }

    // -------------------------------------------------------------------------
    // Live Diagnostics & Quick Activation
    // -------------------------------------------------------------------------
    async function checkServerConnection({ announce = true } = {}) {
        const urlInput = $('setup-server-url');
        const serverUrl = ((urlInput && urlInput.value.trim()) || DEFAULT_SERVER_URL).replace(/\/+$/, '');
        const serverBadge = $('diag-server-badge');
        const serverText = $('diag-server-text');
        const activateBtn = $('btn-activate-vieneu');

        if (!UrlValidator || !UrlValidator.isValidUrl(serverUrl, ['http:', 'https:'])) {
            state.serverOnline = false;
            state.voiceCount = 0;
            if (activateBtn) activateBtn.hidden = true;
            renderCachedDiagnostics();
            if (announce) setLiveFeedback(t('setup_msg_invalid_url'), 'error');
            return false;
        }

        if (chrome?.storage?.local) {
            await chrome.storage.local.set({ ttsEndpoint: serverUrl });
        }

        if (serverText) serverText.textContent = t('setup_diag_checking');
        if (serverBadge) serverBadge.classList.remove('online');

        const health = await sendBgMessage({
            action: 'vieneu_check_health',
            serverUrl
        });

        if (!health || !health.ok) {
            state.serverOnline = false;
            state.voiceCount = 0;
            if (activateBtn) activateBtn.hidden = true;
            renderCachedDiagnostics();
            if (announce) setLiveFeedback(t('setup_msg_server_fail', { url: serverUrl }), 'error');
            return false;
        }

        const stored = chrome?.storage?.local
            ? await chrome.storage.local.get(['ttsApiKey'])
            : {};
        const voicesRes = await sendBgMessage({
            action: 'vieneu_get_voices',
            serverUrl,
            apiKey: stored.ttsApiKey || ''
        });

        const voiceCount = voicesRes && voicesRes.ok && Array.isArray(voicesRes.voices)
            ? voicesRes.voices.length
            : 0;

        state.serverOnline = true;
        state.voiceCount = voiceCount;
        if (activateBtn) activateBtn.hidden = false;
        renderCachedDiagnostics();

        if (announce) {
            const msg = voiceCount > 0
                ? t('setup_msg_server_ok', { url: serverUrl, voices: voiceCount })
                : t('setup_msg_server_ok_default', { url: serverUrl });
            setLiveFeedback(msg, 'success');
        }
        return true;
    }

    async function activateVieNeuEngine() {
        const urlInput = $('setup-server-url');
        const serverUrl = ((urlInput && urlInput.value.trim()) || DEFAULT_SERVER_URL).replace(/\/+$/, '');
        if (!UrlValidator || !UrlValidator.isValidUrl(serverUrl, ['http:', 'https:'])) {
            setLiveFeedback(t('setup_msg_invalid_url'), 'error');
            return;
        }
        const backend = getRecommendedBackendForTab();
        if (chrome?.storage?.local) {
            await chrome.storage.local.set({
                ttsEngine: 'vieneu',
                ttsEndpoint: serverUrl,
                ttsBackend: backend
            });
        }
        setLiveFeedback(t('setup_msg_activated', { backend }), 'success');
    }

    async function checkNativeHost({ requestPermission = false } = {}) {
        // Call chrome.permissions.request() before any other await to preserve the user gesture.
        let hasPerm = false;
        try {
            if (requestPermission && chrome?.permissions?.request) {
                hasPerm = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
            } else if (chrome?.permissions?.contains) {
                hasPerm = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
            }
        } catch (_) {
            hasPerm = false;
        }

        if (!isLikelyWindows()) {
            state.lastHostDiag = {
                key: 'setup_diag_host_non_windows',
                params: null,
                tone: 'neutral',
                badgeKey: 'setup_diag_host_non_windows',
                badgeClass: ''
            };
            renderCachedDiagnostics();
            return;
        }

        if (!hasPerm) {
            state.lastHostDiag = requestPermission
                ? {
                    key: 'setup_host_detail_denied',
                    params: null,
                    tone: 'error',
                    badgeKey: 'setup_diag_host_perm_needed',
                    badgeClass: 'warn'
                }
                : {
                    key: 'setup_host_detail_idle',
                    params: null,
                    tone: 'neutral',
                    badgeKey: 'setup_diag_host_not_installed',
                    badgeClass: ''
                };
            renderCachedDiagnostics();
            return;
        }

        const urlInput = $('setup-server-url');
        const port = parsePortFromUrl(urlInput ? urlInput.value.trim() : DEFAULT_SERVER_URL);
        const res = await sendBgMessage({
            action: 'vieneu_native_control',
            command: 'status',
            port
        });

        if (!res || !res.ok) {
            state.lastHostDiag = {
                key: 'setup_host_detail_missing',
                params: { error: (res && res.error) || 'not found' },
                tone: 'error',
                badgeKey: 'setup_diag_host_not_installed',
                badgeClass: 'warn'
            };
            renderCachedDiagnostics();
            return;
        }

        const dir = res.vieneuDir || '%USERPROFILE%\\vieneu-tts';
        if (res.pythonFound === false) {
            state.lastHostDiag = {
                key: 'setup_host_detail_no_venv',
                params: { dir },
                tone: 'error',
                badgeKey: 'setup_diag_host_missing_venv',
                badgeParams: { dir },
                badgeClass: 'warn'
            };
        } else if (res.running) {
            state.lastHostDiag = {
                key: 'setup_host_detail_ok_running',
                params: { pid: res.pid || 'OK', dir },
                tone: 'success',
                badgeKey: 'setup_diag_host_ready',
                badgeClass: 'online'
            };
        } else {
            state.lastHostDiag = {
                key: 'setup_host_detail_ok_stopped',
                params: { dir },
                tone: 'success',
                badgeKey: 'setup_diag_host_ready_stopped',
                badgeClass: 'online'
            };
        }
        renderCachedDiagnostics();
    }

    function populateExtensionIdAndCompanion() {
        const extId = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)
            ? chrome.runtime.id
            : 'your-extension-id';

        const extIdEl = $('setup-ext-id');
        if (extIdEl) extIdEl.textContent = extId;

        const setupAllEl = $('cmd-setup-all');
        if (setupAllEl) setupAllEl.textContent = `.\\setup_vieneu.bat ${extId}`;

        const installHostEl = $('cmd-install-host');
        if (installHostEl) installHostEl.textContent = `.\\install_host.bat ${extId}`;

        const dlRow = $('companion-download-row');
        const dlBtn = $('btn-download-companion');
        const localNote = $('companion-local-note');
        if (COMPANION_DOWNLOAD_URL && UrlValidator?.isValidUrl(COMPANION_DOWNLOAD_URL, ['https:', 'http:'])) {
            if (dlBtn) dlBtn.href = COMPANION_DOWNLOAD_URL;
            if (dlRow) dlRow.hidden = false;
            if (localNote) localNote.hidden = true;
        } else {
            if (dlRow) dlRow.hidden = true;
            if (localNote) localNote.hidden = false;
        }
    }

    function selectInitialHardwareTab(savedBackend) {
        if (!isLikelyWindows()) {
            selectHwTab($('tab-unix'));
            return;
        }
        if (savedBackend === 'pytorch') {
            selectHwTab($('tab-win-nvidia'));
        } else if (savedBackend === 'amd_gpu') {
            selectHwTab($('tab-win-amd'));
        } else {
            selectHwTab($('tab-win-cpu'));
        }
    }

    function bindEvents() {
        const langBtn = $('btn-setup-lang');
        if (langBtn) {
            langBtn.addEventListener('click', async () => {
                if (!I18n) return;
                const next = I18n.getLocale() === 'vi' ? 'en' : 'vi';
                await I18n.saveLocale(next);
                applyLocaleToPage();
            });
        }

        const themeBtn = $('btn-setup-theme');
        if (themeBtn) {
            themeBtn.addEventListener('click', async () => {
                const current = document.documentElement.getAttribute('data-theme') || 'dark';
                const next = current === 'dark' ? 'light' : 'dark';
                applyTheme(next);
                if (chrome?.storage?.local) {
                    await chrome.storage.local.set({ stv_theme: next });
                }
            });
        }

        const checkBtn = $('btn-check-connection');
        if (checkBtn) {
            checkBtn.addEventListener('click', () => {
                void checkServerConnection({ announce: true });
            });
        }

        const activateBtn = $('btn-activate-vieneu');
        if (activateBtn) {
            activateBtn.addEventListener('click', () => {
                void activateVieNeuEngine();
            });
        }

        const testHostBtn = $('btn-test-native-host');
        if (testHostBtn) {
            testHostBtn.addEventListener('click', () => {
                void checkNativeHost({ requestPermission: true });
            });
        }
    }

    async function init() {
        initCopyButtons();
        initHardwareTabs();
        bindEvents();
        populateExtensionIdAndCompanion();

        if (I18n) {
            await I18n.loadSavedLocale();
        }

        let stored = {};
        if (chrome?.storage?.local) {
            stored = await chrome.storage.local.get(['stv_theme', 'ttsEndpoint', 'ttsBackend']);
        }

        applyTheme(stored.stv_theme || 'dark');
        const urlInput = $('setup-server-url');
        if (urlInput) {
            urlInput.value = stored.ttsEndpoint || DEFAULT_SERVER_URL;
        }

        selectInitialHardwareTab(stored.ttsBackend || 'auto');
        applyLocaleToPage();

        await Promise.all([
            checkServerConnection({ announce: false }),
            checkNativeHost({ requestPermission: false })
        ]);
    }

    document.addEventListener('DOMContentLoaded', () => {
        void init();
    });
})();
