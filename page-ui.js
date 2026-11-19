// page-ui.js - Shadow DOM Toast Notifications & Compact Floating Reader Menu Icon
(function (global) {
    'use strict';

    if (global.STV_PageUI && global.STV_showToast && global.STV_ensureFloatingReaderIcon) {
        return;
    }

    function t(key, params) {
        const i18n = global.STV_I18n || globalThis.STV_I18n;
        if (i18n && typeof i18n.t === 'function') {
            return i18n.t(key, params);
        }
        return key;
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // =====================================================
    // 1. Non-blocking Shadow DOM Toast System
    // =====================================================
    const toastQueue = [];
    let toastShadow = null;
    let toastContainer = null;

    function ensureToastRoot() {
        let readerEl = document.getElementById('stv-reader-root');
        if (readerEl && readerEl.shadowRoot) {
            let container = readerEl.shadowRoot.getElementById('stv-toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'stv-toast-container';
                container.className = 'stv-toast-stack stv-toast-container';
                readerEl.shadowRoot.appendChild(container);
            }
            return container;
        }

        if (toastShadow && toastContainer && document.contains(toastShadow.host)) {
            return toastContainer;
        }
        let host = document.getElementById('stv-toast-root');
        if (!host) {
            host = document.createElement('div');
            host.id = 'stv-toast-root';
            host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:none;';
            (document.body || document.documentElement).appendChild(host);
        }
        toastShadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
        toastShadow.innerHTML = '';

        const style = document.createElement('style');
        style.textContent = `
            :host { all: initial; }
            .stv-toast-stack {
                display: flex;
                flex-direction: column;
                gap: 8px;
                align-items: flex-end;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .stv-toast {
                pointer-events: auto;
                max-width: 340px;
                padding: 10px 14px;
                border-radius: 10px;
                font-size: 13px;
                font-weight: 500;
                line-height: 1.45;
                color: #f8fafc;
                background: #1e293b;
                border: 1px solid rgba(255,255,255,0.12);
                box-shadow: 0 8px 24px rgba(0,0,0,0.28);
                opacity: 0;
                transform: translateY(-6px);
                transition: opacity 0.2s ease, transform 0.2s ease;
                word-break: break-word;
            }
            .stv-toast.visible { opacity: 1; transform: translateY(0); }
            .stv-toast.success, .stv-toast-success { background: #065f46; border-color: #10b981; }
            .stv-toast.warning, .stv-toast-warning { background: #92400e; border-color: #f59e0b; }
            .stv-toast.error, .stv-toast-error { background: #991b1b; border-color: #ef4444; }
            .stv-toast.info, .stv-toast-info { background: #3182ce; border-color: #2b6cb0; }
        `;
        toastContainer = document.createElement('div');
        toastContainer.id = 'stv-toast-container';
        toastContainer.className = 'stv-toast-stack stv-toast-container';
        toastShadow.append(style, toastContainer);
        return toastContainer;
    }

    function showToast(message, type = 'info', durationMs = 3500) {
        if (!message) return null;
        if (typeof document === 'undefined') return null;

        const container = ensureToastRoot();
        const item = document.createElement('div');
        item.className = `stv-toast ${type} stv-toast-${type}`;
        item.setAttribute('role', 'status');
        item.setAttribute('aria-live', 'polite');
        item.textContent = String(message);

        // Keep at most 4 stacked toasts
        while (toastQueue.length >= 4) {
            const oldest = toastQueue.shift();
            if (oldest && oldest.parentNode) oldest.remove();
        }

        container.appendChild(item);
        toastQueue.push(item);

        requestAnimationFrame(() => item.classList.add('visible'));

        if (durationMs > 0) {
            const fadeDelay = durationMs <= 100 ? 10 : 220;
            setTimeout(() => {
                item.classList.remove('visible');
                setTimeout(() => {
                    if (item.parentNode) item.remove();
                    const idx = toastQueue.indexOf(item);
                    if (idx !== -1) toastQueue.splice(idx, 1);
                }, fadeDelay);
            }, durationMs);
        }
        return item;
    }

    // =====================================================
    // 2. Compact Floating Reader Menu Icon (Shadow DOM)
    // =====================================================
    let readerHost = null;
    let readerShadow = null;
    let menuOpen = false;
    let showingOriginal = false;

    function buildReaderMenuHTML() {
        return `
            <div class="stv-menu stv-popover-menu" id="stv-popover-menu" role="menu" aria-hidden="true">
                <div class="stv-menu-header">
                    <span class="stv-menu-title" data-role="title">${t('reader_menu_title')}</span>
                    <button class="stv-menu-close" data-action="close" aria-label="Close">✕</button>
                </div>
                <button class="stv-menu-item" data-action="toggle-orig" id="btn-toggle-orig" data-i18n="menuOriginal" role="menuitem">${showingOriginal ? (t('menuTranslated') || t('reader_toggle_trans')) : (t('menuOriginal') || t('reader_toggle_orig'))}</button>
                <div class="stv-menu-row font-controls">
                    <span data-i18n="menuFontSize" style="display:none;"></span>
                    <button class="stv-menu-chip" data-action="font-dec" id="btn-font-dec" title="${t('reader_font_dec')}">A-</button>
                    <button class="stv-menu-chip" data-action="font-inc" id="btn-font-inc" title="${t('reader_font_inc')}">A+</button>
                </div>
                <button class="stv-menu-item" data-action="retranslate" id="btn-retranslate" role="menuitem">${t('reader_retranslate')}</button>
                <button class="stv-menu-item" data-action="tts" id="btn-mini-tts" data-i18n="tabListen" role="menuitem">${t('tabListen') || t('reader_tts_listen')}</button>
                <button class="stv-menu-item" data-action="next-chap" id="btn-next-chap" data-i18n="menuNextChapter" role="menuitem">${t('menuNextChapter') || t('reader_next_chap')}</button>
            </div>
            <button class="stv-fab stv-floating-pill" id="stv-floating-pill" type="button" aria-label="${t('reader_menu_title')}" aria-expanded="false" title="${t('reader_menu_title')}">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                </svg>
            </button>
            <div class="stv-toast-container" id="stv-toast-container"></div>
        `;
    }

    function setMenuOpen(open) {
        menuOpen = Boolean(open);
        if (!readerShadow) return;
        const menu = readerShadow.getElementById('stv-popover-menu') || readerShadow.getElementById('stv-reader-menu');
        const fab = readerShadow.getElementById('stv-floating-pill') || readerShadow.getElementById('stv-reader-fab');
        if (menu) {
            menu.classList.toggle('open', menuOpen);
            menu.setAttribute('aria-hidden', menuOpen ? 'false' : 'true');
        }
        if (fab) {
            fab.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
        }
    }

    function refreshReaderMenuLabels() {
        if (!readerShadow) return;
        const setTxt = (sel, val) => {
            const el = readerShadow.querySelector(sel);
            if (el) el.textContent = val;
        };
        setTxt('[data-role="title"]', t('reader_menu_title'));
        const toggleBtn = readerShadow.getElementById('btn-toggle-orig') || readerShadow.querySelector('[data-action="toggle-orig"]');
        if (toggleBtn) {
            const label = showingOriginal ? (t('menuTranslated') || t('reader_toggle_trans')) : (t('menuOriginal') || t('reader_toggle_orig'));
            toggleBtn.textContent = label;
        }
        setTxt('#btn-retranslate', t('reader_retranslate'));
        setTxt('#btn-mini-tts', t('tabListen') || t('reader_tts_listen'));
        setTxt('#btn-next-chap', t('menuNextChapter') || t('reader_next_chap'));
    }

    function ensureFloatingReaderIcon() {
        if (typeof document === 'undefined') return null;
        if (readerHost && document.contains(readerHost) && readerShadow) {
            refreshReaderMenuLabels();
            return readerHost;
        }

        readerHost = document.getElementById('stv-reader-root');
        if (!readerHost) {
            readerHost = document.createElement('div');
            readerHost.id = 'stv-reader-root';
            readerHost.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483635;';
            (document.body || document.documentElement).appendChild(readerHost);
        }
        readerShadow = readerHost.shadowRoot || readerHost.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            :host { all: initial; }
            .stv-fab-wrap {
                position: relative;
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .stv-fab {
                width: 38px;
                height: 38px;
                border-radius: 50%;
                border: 1px solid rgba(255,255,255,0.18);
                background: #4f46e5;
                color: #ffffff;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                box-shadow: 0 4px 14px rgba(15, 23, 42, 0.35);
                transition: transform 0.15s ease, background 0.15s ease;
                padding: 0;
            }
            .stv-fab:hover {
                background: #4338ca;
                transform: scale(1.06);
            }
            .stv-menu {
                display: none;
                flex-direction: column;
                gap: 4px;
                width: 196px;
                margin-bottom: 10px;
                padding: 8px;
                border-radius: 12px;
                background: #0f172a;
                color: #f8fafc;
                border: 1px solid rgba(255,255,255,0.12);
                box-shadow: 0 12px 32px rgba(0,0,0,0.4);
            }
            .stv-menu.open {
                display: flex;
            }
            .stv-menu-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 2px 4px 6px;
                border-bottom: 1px solid rgba(255,255,255,0.1);
                margin-bottom: 2px;
            }
            .stv-menu-title {
                font-size: 11px;
                font-weight: 700;
                color: #93c5fd;
                letter-spacing: 0.3px;
                text-transform: uppercase;
            }
            .stv-menu-close {
                background: none;
                border: none;
                color: #94a3b8;
                cursor: pointer;
                font-size: 13px;
                padding: 2px 4px;
            }
            .stv-menu-close:hover { color: #fff; }
            .stv-menu-item {
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
                padding: 7px 9px;
                border: none;
                border-radius: 7px;
                background: transparent;
                color: #e2e8f0;
                font-size: 12.5px;
                font-weight: 500;
                cursor: pointer;
                text-align: left;
                transition: background 0.12s;
            }
            .stv-menu-item:hover {
                background: rgba(255,255,255,0.1);
            }
            .stv-ico {
                width: 16px;
                text-align: center;
                flex-shrink: 0;
            }
            .stv-menu-row {
                display: flex;
                gap: 6px;
                padding: 2px 0;
            }
            .stv-menu-chip {
                flex: 1;
                padding: 6px 8px;
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 7px;
                background: #1e293b;
                color: #f8fafc;
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
            }
            .stv-menu-chip:hover {
                background: #334155;
            }
            .stv-toast-stack {
                position: fixed;
                top: 16px;
                right: 16px;
                z-index: 2147483647;
                pointer-events: none;
                display: flex;
                flex-direction: column;
                gap: 8px;
                align-items: flex-end;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .stv-toast {
                pointer-events: auto;
                max-width: 340px;
                padding: 10px 14px;
                border-radius: 10px;
                font-size: 13px;
                font-weight: 500;
                line-height: 1.45;
                color: #f8fafc;
                background: #1e293b;
                border: 1px solid rgba(255,255,255,0.12);
                box-shadow: 0 8px 24px rgba(0,0,0,0.28);
                opacity: 0;
                transform: translateY(-6px);
                transition: opacity 0.2s ease, transform 0.2s ease;
                word-break: break-word;
            }
            .stv-toast.visible { opacity: 1; transform: translateY(0); }
            .stv-toast.success, .stv-toast-success { background: #065f46; border-color: #10b981; }
            .stv-toast.warning, .stv-toast-warning { background: #92400e; border-color: #f59e0b; }
            .stv-toast.error, .stv-toast-error { background: #991b1b; border-color: #ef4444; }
            .stv-toast.info, .stv-toast-info { background: #3182ce; border-color: #2b6cb0; }
        `;

        readerShadow.innerHTML = `<style>${style.textContent}</style>${buildReaderMenuHTML()}`;

        const fab = readerShadow.getElementById('stv-floating-pill') || readerShadow.getElementById('stv-reader-fab');
        if (fab) {
            fab.addEventListener('click', (e) => {
                e.stopPropagation();
                setMenuOpen(!menuOpen);
            });
        }

        const menu = readerShadow.getElementById('stv-popover-menu') || readerShadow.getElementById('stv-reader-menu');
        if (menu) {
            menu.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-action], button[id]');
                if (!btn) return;
                const action = btn.dataset.action || btn.id;
                if (action === 'close') {
                    setMenuOpen(false);
                } else if (action === 'toggle-orig' || action === 'btn-toggle-orig') {
                    toggleOriginal();
                } else if (action === 'font-dec' || action === 'btn-font-dec') {
                    syncFontSizeFromBox();
                    setFontSize(currentFontSize - 2);
                } else if (action === 'font-inc' || action === 'btn-font-inc') {
                    syncFontSizeFromBox();
                    setFontSize(currentFontSize + 2);
                } else if (action === 'retranslate' || action === 'btn-retranslate') {
                    setMenuOpen(false);
                    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                        chrome.runtime.sendMessage({ action: 'shortcut_triggered' }, () => {
                            void chrome.runtime.lastError;
                        });
                    }
                } else if (action === 'tts' || action === 'btn-mini-tts') {
                    setMenuOpen(false);
                    if (typeof global.STV_startTTS === 'function') {
                        global.STV_startTTS();
                    } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                        chrome.runtime.sendMessage({ action: 'vieneu_auto_play' }, () => {
                            void chrome.runtime.lastError;
                        });
                    }
                } else if (action === 'next-chap' || action === 'btn-next-chap') {
                    setMenuOpen(false);
                    if (typeof global.STV_findNextChapterUrl === 'function') {
                        const nextUrl = global.STV_findNextChapterUrl(document, global.location.href);
                        if (nextUrl) {
                            global.location.href = nextUrl;
                        } else {
                            showToast(t('reader_next_chap') + ': N/A', 'warning');
                        }
                    }
                }
            });
        }

        document.addEventListener('click', (e) => {
            if (menuOpen && readerHost && !readerHost.contains(e.target)) {
                setMenuOpen(false);
            }
        });

        return readerHost;
    }

    function toggleOriginal(forceOriginal) {
        showingOriginal = forceOriginal !== undefined ? Boolean(forceOriginal) : !showingOriginal;
        if (typeof global.STV_toggleOriginalMode === 'function') {
            global.STV_toggleOriginalMode(showingOriginal);
        } else {
            const lines = document.querySelectorAll('.stv-line');
            for (const line of lines) {
                const orig = line.getAttribute('data-orig');
                const trans = line.getAttribute('data-trans') || line.textContent;
                if (showingOriginal) {
                    if (!line.hasAttribute('data-trans')) line.setAttribute('data-trans', line.textContent);
                    line.textContent = orig || '';
                } else {
                    line.textContent = trans || '';
                }
            }
        }
        refreshReaderMenuLabels();
    }

    let currentFontSize = 22;
    function syncFontSizeFromBox() {
        const box = global.STV_activeContentBox;
        if (!box || typeof global.getComputedStyle !== 'function') return;
        const computed = parseFloat(global.getComputedStyle(box).fontSize);
        if (Number.isFinite(computed) && computed > 0) {
            currentFontSize = Math.max(14, Math.min(36, Math.round(computed)));
        }
    }

    function setFontSize(sizePx) {
        const prev = currentFontSize;
        const numeric = typeof sizePx === 'number' ? sizePx : parseInt(sizePx, 10);
        if (Number.isFinite(numeric)) currentFontSize = Math.max(14, Math.min(36, numeric));
        if (typeof global.STV_setFontSize === 'function') {
            global.STV_setFontSize(currentFontSize);
        } else if (typeof global.STV_adjustFontSize === 'function') {
            global.STV_adjustFontSize(currentFontSize - prev);
        }
        const lines = document.querySelectorAll('.stv-line');
        for (const line of lines) {
            line.style.fontSize = `${currentFontSize}px`;
        }
    }

    const UIModal = {
        alert: ({ title = 'Thông báo', message = '' } = {}) => {
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.className = 'stv-modal-overlay';
                overlay.setAttribute('role', 'dialog');
                overlay.setAttribute('aria-modal', 'true');
                overlay.setAttribute('aria-label', title);

                overlay.innerHTML = `
                    <div class="stv-modal-content">
                        <h3 class="stv-modal-title">${escapeHtml(title)}</h3>
                        <p class="stv-modal-body">${escapeHtml(message)}</p>
                        <button class="stv-modal-btn-confirm" id="modal-btn-ok">OK</button>
                    </div>
                `;
                (document.body || document.documentElement).appendChild(overlay);

                const btnOk = overlay.querySelector('#modal-btn-ok');
                if (btnOk) {
                    btnOk.addEventListener('click', () => {
                        overlay.remove();
                        resolve(true);
                    });
                }

                overlay.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        overlay.remove();
                        resolve(true);
                    }
                });
            });
        },

        confirm: ({ title = 'Xác nhận', message = '' } = {}) => {
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.className = 'stv-modal-overlay';
                overlay.setAttribute('role', 'dialog');
                overlay.setAttribute('aria-modal', 'true');
                overlay.setAttribute('aria-label', title);

                overlay.innerHTML = `
                    <div class="stv-modal-content">
                        <h3 class="stv-modal-title">${escapeHtml(title)}</h3>
                        <p class="stv-modal-body">${escapeHtml(message)}</p>
                        <button class="stv-modal-btn-cancel" id="modal-btn-cancel">Hủy</button>
                        <button class="stv-modal-btn-confirm" id="modal-btn-confirm">Xác nhận</button>
                    </div>
                `;
                (document.body || document.documentElement).appendChild(overlay);

                const btnConfirm = overlay.querySelector('#modal-btn-confirm');
                const btnCancel = overlay.querySelector('#modal-btn-cancel');

                if (btnConfirm) {
                    btnConfirm.addEventListener('click', () => {
                        overlay.remove();
                        resolve(true);
                    });
                }
                if (btnCancel) {
                    btnCancel.addEventListener('click', () => {
                        overlay.remove();
                        resolve(false);
                    });
                }

                overlay.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        overlay.remove();
                        resolve(false);
                    }
                });
            });
        }
    };

    const STV_Reader = {
        init(options = {}) {
            const root = ensureFloatingReaderIcon();
            return { root, shadow: root ? root.shadowRoot : null };
        },
        showToast,
        toggleOriginal,
        setFontSize,
        updateTTSProgress(current, total, isPlaying) {
            if (!readerShadow) return;
            const btn = readerShadow.getElementById('btn-mini-tts') || readerShadow.querySelector('[data-action="tts"]');
            if (btn) {
                btn.textContent = isPlaying ? `Đang nghe (${current}/${total})` : t('reader_tts_listen');
            }
        },
        setLocale(locale) {
            if (global.STV_I18n && typeof global.STV_I18n.setLocale === 'function') {
                global.STV_I18n.setLocale(locale);
                if (readerShadow) {
                    global.STV_I18n.applyToDOM(readerShadow);
                }
            }
            refreshReaderMenuLabels();
        }
    };

    global.STV_showToast = showToast;
    global.STV_ensureFloatingReaderIcon = ensureFloatingReaderIcon;
    global.STV_refreshReaderMenuLabels = refreshReaderMenuLabels;
    global.STV_Reader = STV_Reader;
    global.STV_UIModal = UIModal;
    global.UIModal = UIModal;
    global.STV_PageUI = {
        showToast,
        ensureFloatingReaderIcon,
        refreshReaderMenuLabels,
        setMenuOpen,
        isMenuOpen: () => menuOpen,
        Reader: STV_Reader,
        UIModal,
        init: STV_Reader.init,
        toggleOriginal,
        setFontSize,
        setLocale: STV_Reader.setLocale
    };
})(typeof window !== 'undefined' ? window : globalThis);
