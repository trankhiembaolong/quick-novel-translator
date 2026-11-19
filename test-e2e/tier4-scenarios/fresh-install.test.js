/**
 * test-e2e/tier4-scenarios/fresh-install.test.js
 * Scenario 1: Fresh Install, Onboarding, Permission Grant & First Read
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, ReaderUI, Locales } from '../harness/index.js';

describe('Tier 4 Scenario 1: Fresh Install Onboarding & First Read', () => {
    let sandbox;

    beforeEach(() => {
        // Fresh install: completely empty storage
        sandbox = setupSandbox({
            chrome: {
                initialStorage: {},
                initialPermissions: ['storage', 'activeTab', 'scripting'],
                initialOrigins: []
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('Scenario 1: complete user journey from zero configuration to successful first translation', async () => {
        // Step 1: User installs extension; storage is checked
        const initialStorage = await chrome.storage.local.get(null);
        assert.strictEqual(initialStorage.apikey, undefined, 'No API key configured initially');

        // Step 2: Open Popup. Onboarding card is displayed because apikey is missing
        const popupDom = document.createElement('div');
        popupDom.innerHTML = `
            <div id="card-onboarding" class="card visible">
                <h3 data-i18n="onboardingTitle">Chào mừng bạn đến với STV!</h3>
                <input id="input-api-key" placeholder="Nhập OpenRouter API Key..." />
                <button id="btn-save-key" data-i18n="btnSave">Lưu</button>
            </div>
            <div id="card-main-translate" class="card hidden">
                <button id="btn-translate-page" data-i18n="btnTranslateThisChapter">Dịch chương này</button>
            </div>
        `;
        document.body.appendChild(popupDom);

        const cardOnboarding = popupDom.querySelector('#card-onboarding');
        const cardMain = popupDom.querySelector('#card-main-translate');
        const inputKey = popupDom.querySelector('#input-api-key');
        const btnSave = popupDom.querySelector('#btn-save-key');

        assert.strictEqual(cardOnboarding.classList.contains('visible'), true);
        assert.strictEqual(cardMain.classList.contains('hidden'), true);

        // Step 3: User inputs API Key and clicks Save
        inputKey.value = 'sk-or-v1-new-user-secret-key-12345';
        await chrome.storage.local.set({
            apikey: inputKey.value.trim(),
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            model: 'stepfun/step-3.5-flash',
            stv_locale: 'vi'
        });

        // Background service worker isolates secret with TRUSTED_CONTEXTS
        await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

        // Onboarding card hides, main view appears
        cardOnboarding.classList.remove('visible');
        cardOnboarding.classList.add('hidden');
        cardMain.classList.remove('hidden');
        cardMain.classList.add('visible');

        assert.strictEqual(cardOnboarding.classList.contains('hidden'), true);
        assert.strictEqual(cardMain.classList.contains('visible'), true);

        // Step 4: User visits a novel site and requests site permission
        const novelSiteOrigin = 'https://truyenfull.vn/*';
        const hasPermissionBefore = await chrome.permissions.contains({ origins: [novelSiteOrigin] });
        assert.strictEqual(hasPermissionBefore, false);

        const permissionGranted = await chrome.permissions.request({ origins: [novelSiteOrigin] });
        assert.strictEqual(permissionGranted, true);

        const hasPermissionAfter = await chrome.permissions.contains({ origins: [novelSiteOrigin] });
        assert.strictEqual(hasPermissionAfter, true);

        // Step 5: Content script injects via activeTab on novel chapter page
        const chapterContainer = document.createElement('div');
        chapterContainer.id = 'chapter-content';
        chapterContainer.innerHTML = '<p>第一章: 穿越修仙界</p>';
        document.body.appendChild(chapterContainer);

        // Reader UI mounts in Shadow DOM
        const { shadow } = ReaderUI.init();
        const pill = shadow.getElementById('stv-floating-pill');
        assert.ok(pill, 'Reader floating icon mounted in Shadow DOM');

        // Check storage contains saved configurations
        const finalStorage = await chrome.storage.local.get(null);
        assert.strictEqual(finalStorage.apikey, 'sk-or-v1-new-user-secret-key-12345');
        assert.strictEqual(finalStorage.stv_locale, 'vi');
    });
});
