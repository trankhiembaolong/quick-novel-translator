/**
 * test-e2e/tier1-features/locales.test.js
 * Feature 6: Bilingual Localization (vi/en) & Dynamic Switching
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, Locales } from '../harness/index.js';

describe('Feature 6: Bilingual Localization (vi/en) & Dynamic Switching', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox();
        Locales.currentLocale = 'vi';
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T1.31: bilingual dictionary contains 100% key parity between vi and en', () => {
        const viKeys = Object.keys(Locales.dictionaries.vi).sort();
        const enKeys = Object.keys(Locales.dictionaries.en).sort();

        assert.deepStrictEqual(viKeys, enKeys, 'All translation keys in Vietnamese must exist in English and vice-versa');
        assert.ok(viKeys.length >= 15, 'Dictionary must cover at least 15 core UI keys');
    });

    it('T1.32: i18n.t resolves accurate localized strings according to active locale', async () => {
        // Vietnamese (default)
        assert.strictEqual(Locales.getLocale(), 'vi');
        assert.strictEqual(Locales.t('tabTranslate'), 'Dịch');
        assert.strictEqual(Locales.t('btnSave'), 'Lưu');
        assert.strictEqual(Locales.t('menuOriginal'), 'Xem bản gốc');

        // Switch to English
        await Locales.setLocale('en');
        assert.strictEqual(Locales.getLocale(), 'en');
        assert.strictEqual(Locales.t('tabTranslate'), 'Translate');
        assert.strictEqual(Locales.t('btnSave'), 'Save');
        assert.strictEqual(Locales.t('menuOriginal'), 'Show original');
    });

    it('T1.33: i18n.t interpolates template parameters accurately without leaking brackets', () => {
        const viInterpolated = Locales.t('foundLines', { count: 42 });
        assert.strictEqual(viInterpolated, 'Tìm thấy 42 dòng');

        Locales.currentLocale = 'en';
        const enInterpolated = Locales.t('foundLines', { count: 42 });
        assert.strictEqual(enInterpolated, 'Found 42 lines');

        const multiParams = Locales.t('progress_status', { current: 3, total: 10 });
        assert.strictEqual(multiParams, 'Line 3 / 10');
    });

    it('T1.34: i18n.applyToDOM traverses and updates data-i18n and data-i18n-attr elements', () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <h2 data-i18n="app_name">Chưa dịch</h2>
            <button data-i18n="btnSave">Chưa dịch</button>
            <input data-i18n-attr="placeholder:onboardingTitle" />
        `;
        document.body.appendChild(container);

        Locales.currentLocale = 'vi';
        Locales.applyToDOM(container);

        assert.strictEqual(container.querySelector('h2').textContent, 'Dịch Tiểu Thuyết STV');
        assert.strictEqual(container.querySelector('button').textContent, 'Lưu');
        assert.strictEqual(container.querySelector('input').getAttribute('placeholder'), 'Chào mừng bạn đến với STV!');

        // Live switch to English
        Locales.currentLocale = 'en';
        Locales.applyToDOM(container);

        assert.strictEqual(container.querySelector('h2').textContent, 'Quick Novel Translator');
        assert.strictEqual(container.querySelector('button').textContent, 'Save');
        assert.strictEqual(container.querySelector('input').getAttribute('placeholder'), 'Welcome to STV!');
    });

    it('T1.35: falls back gracefully to default locale when key is missing in target dictionary', () => {
        // Temporarily delete a key in English dictionary
        const backupEnToast = Locales.dictionaries.en.toastFallbackWebSpeech;
        delete Locales.dictionaries.en.toastFallbackWebSpeech;

        Locales.currentLocale = 'en';
        const fallbackValue = Locales.t('toastFallbackWebSpeech');

        assert.strictEqual(fallbackValue, 'Chuyển sang giọng đọc Web Speech API', 'Must fallback to Vietnamese string');

        // Non-existent key in both
        const unknownKey = Locales.t('non_existent_key_xyz');
        assert.strictEqual(unknownKey, 'non_existent_key_xyz', 'Must return key name if undefined in both');

        // Restore
        Locales.dictionaries.en.toastFallbackWebSpeech = backupEnToast;
    });

    it('T1.36: persists selected locale to chrome.storage.local', async () => {
        await Locales.setLocale('en');

        const stored = await chrome.storage.local.get(['stv_locale']);
        assert.strictEqual(stored.stv_locale, 'en', 'Locale must be saved in storage');
    });
});
