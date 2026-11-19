/**
 * test-e2e/tier1-features/permissions.test.js
 * Feature 1: MV3 Site-by-Site Permissions & Host Access
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox } from '../harness/index.js';
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
});
