/**
 * test-e2e/tier4-scenarios/glossary-profile.test.js
 * Scenario 5: Term Glossary Management, Search, JSON Export & Merge Import
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox, UIModal } from '../harness/index.js';
import '../../glossary-utils.js';

describe('Tier 4 Scenario 5: Glossary Management & JSON I/O Workflow', () => {
    let sandbox;
    const GlossaryUtils = globalThis.STV_GlossaryUtils;

    beforeEach(() => {
        sandbox = setupSandbox({
            chrome: {
                initialStorage: {
                    stv_active_glossary_profile: 'GiaThe',
                    stv_glossary_profile_GiaThe: {}
                }
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('Scenario 5: complete glossary lifecycle: add terms -> lock -> debounced search -> export JSON -> merge import', async () => {
        // Step 1: User adds new terms in popup glossary view
        const terms = {
            '叶凡': { hanviet: 'Diệp Phàm', locked: true, count: 10 },
            '庞博': { hanviet: 'Bàng Bác', locked: false, count: 4 },
            '姬紫月': { hanviet: 'Cơ Tử Nguyệt', locked: true, count: 7 }
        };

        await chrome.storage.local.set({ stv_glossary_profile_GiaThe: terms });

        const savedData = await chrome.storage.local.get(['stv_glossary_profile_GiaThe']);
        assert.strictEqual(Object.keys(savedData.stv_glossary_profile_GiaThe).length, 3);
        assert.strictEqual(savedData.stv_glossary_profile_GiaThe['叶凡'].locked, true);

        // Step 2: User searches in search bar with 150ms debounce
        const searchTerms = Object.entries(savedData.stv_glossary_profile_GiaThe).map(([orig, info]) => ({
            orig,
            ...info
        }));

        let debounceTimer = null;
        function doSearch(q) {
            return new Promise((resolve) => {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    const filtered = searchTerms.filter(t => t.orig.includes(q) || t.hanviet.toLowerCase().includes(q.toLowerCase()));
                    resolve(filtered);
                }, 30);
            });
        }

        const searchResults = await doSearch('diệp');
        assert.strictEqual(searchResults.length, 1);
        assert.strictEqual(searchResults[0].orig, '叶凡');
        assert.strictEqual(searchResults[0].hanviet, 'Diệp Phàm');

        // Step 3: User exports profile to JSON
        const exportPayload = {
            version: 1,
            profile: 'GiaThe',
            exportedAt: new Date().toISOString(),
            terms: savedData.stv_glossary_profile_GiaThe
        };
        const jsonString = JSON.stringify(exportPayload, null, 2);
        assert.ok(jsonString.includes('"Diệp Phàm"'));
        assert.ok(jsonString.includes('"Cơ Tử Nguyệt"'));

        // Step 4: Simulate a profile reset or switching profiles
        await chrome.storage.local.set({
            stv_glossary_profile_GiaThe: {
                '叶凡': { hanviet: 'Diệp Phàm (Gốc)', locked: true }
            }
        });

        // Step 5: User imports JSON file; modal asks Merge or Overwrite
        const imported = JSON.parse(jsonString);
        assert.strictEqual(imported.version, 1);

        // User clicks "Merge" in modal
        const confirmPromise = UIModal.confirm({
            title: 'Nhập từ điển',
            message: 'Chọn Merge để bảo vệ các từ đã khóa.'
        });
        const overlay = document.querySelector('.stv-modal-overlay');
        if (overlay) {
            overlay.querySelector('#modal-btn-confirm').click();
        }
        const modalConfirm = await confirmPromise;
        assert.strictEqual(modalConfirm, true);

        const currentProfile = (await chrome.storage.local.get(['stv_glossary_profile_GiaThe'])).stv_glossary_profile_GiaThe;

        // Perform merge
        const { merged } = GlossaryUtils.mergeGlossaryTerms(currentProfile, imported.terms);

        // Locked existing term is preserved
        assert.strictEqual(merged['叶凡'].hanviet, 'Diệp Phàm (Gốc)', 'Locked term must keep existing definition');
        // Non-conflicting terms are restored
        assert.strictEqual(merged['庞博'].hanviet, 'Bàng Bác');
        assert.strictEqual(merged['姬紫月'].hanviet, 'Cơ Tử Nguyệt');

        // Save back
        await chrome.storage.local.set({ stv_glossary_profile_GiaThe: merged });
        const finalStorage = await chrome.storage.local.get(['stv_glossary_profile_GiaThe']);
        assert.strictEqual(Object.keys(finalStorage.stv_glossary_profile_GiaThe).length, 3);
    });
});
