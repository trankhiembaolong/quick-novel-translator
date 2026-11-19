/**
 * test-e2e/tier3-pairwise/locale-menu.test.js
 * Tier 3 Pairwise Combinatorics: Dynamic Locale Switch & Injected Reader Menu (3 tests)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, Locales, ReaderUI } from '../harness/index.js';

describe('Tier 3: Dynamic Locale + Reader Menu Interaction', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox();
        Locales.currentLocale = 'vi';
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T3.9: switching locale dynamically updates open Shadow DOM reader menu without closing popover', async () => {
        const { shadow } = ReaderUI.init();
        const pill = shadow.getElementById('stv-floating-pill');
        const menu = shadow.getElementById('stv-popover-menu');
        const btnToggleOrig = shadow.getElementById('btn-toggle-orig');

        // User clicks floating icon to open menu
        pill.click();
        assert.strictEqual(menu.classList.contains('open'), true, 'Menu is open');
        assert.strictEqual(btnToggleOrig.textContent, 'Xem bản gốc');

        // User changes locale to English
        await Locales.setLocale('en');
        Locales.applyToDOM(shadow);

        assert.strictEqual(menu.classList.contains('open'), true, 'Menu must remain open without disruption');
        assert.strictEqual(btnToggleOrig.textContent, 'Show original', 'Button label must update to English');
    });

    it('T3.10: toasts emitted inside Shadow DOM use dictionary of active locale', async () => {
        ReaderUI.init();

        // Vietnamese toast
        Locales.currentLocale = 'vi';
        const toastVi = ReaderUI.showToast(Locales.t('toastFallbackWebSpeech'), 'info', 0);
        assert.strictEqual(toastVi.textContent, 'Chuyển sang giọng đọc Web Speech API');

        // English toast
        await Locales.setLocale('en');
        const toastEn = ReaderUI.showToast(Locales.t('toastFallbackWebSpeech'), 'info', 0);
        assert.strictEqual(toastEn.textContent, 'Switched to Web Speech API');
    });

    it('T3.11: original/translated text display state is preserved when switching locale', async () => {
        const { shadow } = ReaderUI.init();

        const line = document.createElement('span');
        line.className = 'stv-line';
        line.setAttribute('data-orig', '仙路尽头谁为峰');
        line.textContent = 'Đầu đường tiên lộ ai làm đỉnh';
        document.body.appendChild(line);

        const btnToggleOrig = shadow.getElementById('btn-toggle-orig');

        // Switch to Original view
        btnToggleOrig.click();
        assert.strictEqual(line.textContent, '仙路尽头谁为峰');

        // Switch locale to English
        await Locales.setLocale('en');
        Locales.applyToDOM(shadow);

        // Display text on novel line must remain Original
        assert.strictEqual(line.textContent, '仙路尽头谁为峰', 'Original text must be preserved after locale switch');
    });
});
