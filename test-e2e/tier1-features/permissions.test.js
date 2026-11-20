/**
 * test-e2e/tier1-features/permissions.test.js
 * Feature 1: MV3 Site-by-Site Permissions & Host Access
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, TranslationBroker } from '../harness/index.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Feature 1: MV3 Site-by-Site Permissions & Host Access', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox({
            chrome: {
                initialPermissions: ['storage', 'activeTab', 'scripting'],
                initialOrigins: ['https://truyenfull.vn/*']
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T1.1: manifest.json defines Manifest V3 with activeTab and scripting permissions', () => {
        const manifestPath = path.resolve(process.cwd(), 'manifest.json');
        assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        assert.strictEqual(manifest.manifest_version, 3, 'Must be Manifest V3');
        assert.ok(manifest.permissions.includes('activeTab'), 'Permissions must include activeTab');
        assert.ok(manifest.permissions.includes('scripting'), 'Permissions must include scripting');
        assert.ok(manifest.permissions.includes('storage'), 'Permissions must include storage');
        assert.ok(
            manifest.permissions.includes('declarativeNetRequestWithHostAccess'),
            'Permissions must include declarativeNetRequestWithHostAccess'
        );
    });

    it('T1.2: chrome.permissions.contains checks origin permission status accurately', async () => {
        const hasGranted = await chrome.permissions.contains({
            origins: ['https://truyenfull.vn/*']
        });
        assert.strictEqual(hasGranted, true, 'Granted origin must return true');

        const hasUngranted = await chrome.permissions.contains({
            origins: ['https://tangthuvien.vn/*']
        });
        assert.strictEqual(hasUngranted, false, 'Ungranted origin must return false');
    });

    it('T1.3: requesting per-site host permission grants access and updates storage', async () => {
        const targetOrigin = 'https://tangthuvien.vn/*';
        const initialStatus = await chrome.permissions.contains({ origins: [targetOrigin] });
        assert.strictEqual(initialStatus, false, 'Should initially not have permission');

        const granted = await chrome.permissions.request({ origins: [targetOrigin] });
        assert.strictEqual(granted, true, 'User granting request must resolve true');

        const newStatus = await chrome.permissions.contains({ origins: [targetOrigin] });
        assert.strictEqual(newStatus, true, 'Origin must be marked contains after granting');

        const all = await chrome.permissions.getAll();
        assert.ok(all.origins.includes(targetOrigin), 'getAll() must reflect new origin');
    });

    it('T1.4: revoking per-site host permission removes origin from active permissions', async () => {
        const originToRemove = 'https://truyenfull.vn/*';
        const beforeStatus = await chrome.permissions.contains({ origins: [originToRemove] });
        assert.strictEqual(beforeStatus, true, 'Should initially have permission');

        const removed = await chrome.permissions.remove({ origins: [originToRemove] });
        assert.strictEqual(removed, true, 'Permission removal must succeed');

        const afterStatus = await chrome.permissions.contains({ origins: [originToRemove] });
        assert.strictEqual(afterStatus, false, 'Origin must no longer be present in active permissions');
    });

    it('T1.5: activeTab invocation programmatically injects content scripts on user action', async () => {
        let scriptExecutionCalled = false;
        let executedFiles = [];

        sandbox.chrome.scripting.executeScript = async ({ target, files }) => {
            scriptExecutionCalled = true;
            executedFiles = files;
            return [{ result: 'injected_ok' }];
        };

        const currentTab = await chrome.tabs.query({ active: true });
        assert.ok(currentTab.length > 0, 'Active tab must exist');

        const tabId = currentTab[0].id;
        const res = await chrome.scripting.executeScript({
            target: { tabId },
            files: ['extractor.js', 'translator.js']
        });

        assert.strictEqual(scriptExecutionCalled, true, 'executeScript must be invoked');
        assert.deepStrictEqual(executedFiles, ['extractor.js', 'translator.js']);
        assert.strictEqual(res[0].result, 'injected_ok');
    });

    it('T1.6: dynamic URL generation via chrome.runtime.getURL avoids extension fingerprinting', () => {
        const resourceUrl = chrome.runtime.getURL('tts-worklet.js');
        assert.ok(resourceUrl.startsWith('chrome-extension://'), 'Must resolve to chrome-extension scheme');
        assert.ok(resourceUrl.includes('tts-worklet.js'), 'Must contain resource file name');
        assert.strictEqual(resourceUrl.includes('//tts-worklet.js'), false, 'Must not have duplicate slashes');
    });

    it('T1.7: getApiEndpointOriginInfo extracts originPattern without port and anchored urlFilter', () => {
        const vilaoInfo = TranslationBroker.getApiEndpointOriginInfo('https://api.vilao.ai/v1/chat/completions');
        assert.deepStrictEqual(vilaoInfo, {
            origin: 'https://api.vilao.ai',
            host: 'api.vilao.ai',
            hostname: 'api.vilao.ai',
            originPattern: 'https://api.vilao.ai/*',
            urlFilter: '|https://api.vilao.ai/'
        });

        const localInfo = TranslationBroker.getApiEndpointOriginInfo('http://127.0.0.1:11434/v1/chat/completions');
        assert.deepStrictEqual(localInfo, {
            origin: 'http://127.0.0.1:11434',
            host: '127.0.0.1:11434',
            hostname: '127.0.0.1',
            originPattern: 'http://127.0.0.1/*',
            urlFilter: '|http://127.0.0.1:11434/'
        });

        assert.strictEqual(TranslationBroker.getApiEndpointOriginInfo('ws://localhost:8080'), null);
        assert.strictEqual(TranslationBroker.getApiEndpointOriginInfo('not-a-url'), null);
    });

    it('T1.8: syncApiOriginStripRule manages Origin-stripping DNR rule based on API host permission', async () => {
        const endpoint = 'https://api.vilao.ai/v1/chat/completions';

        // 1. Ungranted: rule must NOT be active
        const resUngranted = await TranslationBroker.syncApiOriginStripRule(endpoint, { force: true });
        assert.strictEqual(resUngranted.ok, true);
        assert.strictEqual(resUngranted.active, false);
        assert.strictEqual(resUngranted.hasPermission, false);
        assert.deepStrictEqual(await chrome.declarativeNetRequest.getDynamicRules(), []);

        // 2. Grant host permission -> rule 1001 installed with valid Chromium resourceTypes
        await chrome.permissions.request({ origins: ['https://api.vilao.ai/*'] });
        const resGranted = await TranslationBroker.syncApiOriginStripRule(endpoint, { force: true });
        assert.strictEqual(resGranted.ok, true);
        assert.strictEqual(resGranted.active, true);
        assert.strictEqual(resGranted.hasPermission, true);

        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        assert.strictEqual(rules.length, 1);
        assert.deepStrictEqual(rules[0], {
            id: TranslationBroker.API_ORIGIN_STRIP_RULE_ID,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                requestHeaders: [{ header: 'origin', operation: 'remove' }]
            },
            condition: {
                urlFilter: '|https://api.vilao.ai/',
                resourceTypes: ['xmlhttprequest', 'other'],
                initiatorDomains: [chrome.runtime.id]
            }
        });

        // 3. Custom port endpoint matches host pattern without port and keeps port in urlFilter
        await chrome.permissions.request({ origins: ['http://127.0.0.1/*'] });
        const resPort = await TranslationBroker.syncApiOriginStripRule('http://127.0.0.1:11434/v1/chat/completions', { force: true });
        assert.strictEqual(resPort.ok, true);
        assert.strictEqual(resPort.active, true);
        const portRules = await chrome.declarativeNetRequest.getDynamicRules();
        assert.strictEqual(portRules.length, 1);
        assert.strictEqual(portRules[0].condition.urlFilter, '|http://127.0.0.1:11434/');

        // 4. Revoking permission triggers permissions.onRemoved -> dynamic rule removed
        await chrome.storage.local.set({ endpoint });
        await chrome.permissions.request({ origins: ['https://api.vilao.ai/*'] });
        await TranslationBroker.syncApiOriginStripRule(endpoint, { force: true });
        assert.strictEqual((await chrome.declarativeNetRequest.getDynamicRules()).length, 1);

        await chrome.permissions.remove({ origins: ['https://api.vilao.ai/*'] });
        await new Promise((r) => setTimeout(r, 10));
        assert.deepStrictEqual(await chrome.declarativeNetRequest.getDynamicRules(), []);
    });
});
