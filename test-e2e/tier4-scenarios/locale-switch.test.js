/**
 * test-e2e/tier4-scenarios/locale-switch.test.js
 * Scenario 6: Interactive Language Switching Across Extension Surfaces
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, Locales, ReaderUI } from '../harness/index.js';

describe('Tier 4 Scenario 6: Live Bilingual Switching Across Surfaces', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox();
        Locales.currentLocale = 'vi';
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('Scenario 6: live switching between Vietnamese and English updates Popup, Reader Menu, and Toasts without reload', async () => {
        // Step 1: Initial state in Vietnamese
        assert.strictEqual(Locales.getLocale(), 'vi');

        // Setup Popup DOM elements with data-i18n attributes
        const popupRoot = document.createElement('div');
        popupRoot.id = 'popup-container';
        popupRoot.innerHTML = `
            <div class="nav-tabs">
                <button class="tab-btn" data-i18n="tabTranslate">Dịch</button>
                <button class="tab-btn" data-i18n="tabListen">Nghe</button>
                <button class="tab-btn" data-i18n="tabSettings">Cài đặt</button>
                <button class="tab-btn" data-i18n="tabGlossary">Từ điển</button>
            </div>
            <div class="main-action">
                <button id="btn-main-action" data-i18n="btnTranslateThisChapter">Dịch chương này</button>
            </div>
        `;
        document.body.appendChild(popupRoot);

        // Setup Injected Reader UI in Shadow DOM
        const { shadow } = ReaderUI.init();
        const btnToggleOrig = shadow.getElementById('btn-toggle-orig');
        const btnNextChap = shadow.getElementById('btn-next-chap');

        // Verify initial Vietnamese strings
        assert.strictEqual(popupRoot.querySelector('#btn-main-action').textContent, 'Dịch chương này');
        assert.strictEqual(btnToggleOrig.textContent, 'Xem bản gốc');
        assert.strictEqual(btnNextChap.textContent, 'Chương sau');

        // Step 2: In Popup Settings view, user changes language dropdown to English ('en')
        await Locales.setLocale('en');
        assert.strictEqual(Locales.getLocale(), 'en');

        // Step 3: Storage persists new locale
        const stored = await chrome.storage.local.get(['stv_locale']);
        assert.strictEqual(stored.stv_locale, 'en');

        // Step 4: Live update Popup DOM via applyToDOM (no page reload)
        Locales.applyToDOM(popupRoot);

        const tabButtons = popupRoot.querySelectorAll('.tab-btn');
        assert.strictEqual(tabButtons[0].textContent, 'Translate');
        assert.strictEqual(tabButtons[1].textContent, 'Listen');
        assert.strictEqual(tabButtons[2].textContent, 'Settings');
        assert.strictEqual(tabButtons[3].textContent, 'Glossary');
        assert.strictEqual(popupRoot.querySelector('#btn-main-action').textContent, 'Translate this chapter');

        // Step 5: Live update Injected Reader Menu in Shadow DOM
        Locales.applyToDOM(shadow);
        assert.strictEqual(btnToggleOrig.textContent, 'Show original');
        assert.strictEqual(btnNextChap.textContent, 'Next chapter');

        // Step 6: Toast notifications emitted subsequently use English
        const toast = ReaderUI.showToast(Locales.t('toastOutOfCredit'), 'error', 0);
        assert.strictEqual(toast.textContent, 'API credit exhausted');
        assert.strictEqual(shadow.contains(toast), true);

        // Step 7: Live switch back to Vietnamese verifies full bi-directional symmetry
        await Locales.setLocale('vi');
        Locales.applyToDOM(popupRoot);
        Locales.applyToDOM(shadow);

        assert.strictEqual(tabButtons[0].textContent, 'Dịch');
        assert.strictEqual(popupRoot.querySelector('#btn-main-action').textContent, 'Dịch chương này');
        assert.strictEqual(btnToggleOrig.textContent, 'Xem bản gốc');
        assert.strictEqual(btnNextChap.textContent, 'Chương sau');
    });
});
