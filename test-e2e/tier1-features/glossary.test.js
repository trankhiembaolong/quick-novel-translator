/**
 * test-e2e/tier1-features/glossary.test.js
 * Feature 8: Glossary Management & Locked Terms
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupSandbox, teardownSandbox } from '../harness/index.js';
import '../../glossary-utils.js';

describe('Feature 8: Glossary Management & Locked Terms', () => {
    let sandbox;
    const GlossaryUtils = globalThis.STV_GlossaryUtils;

    beforeEach(() => {
        sandbox = setupSandbox({
            chrome: {
                initialStorage: {
                    stv_active_glossary_profile: 'TuTien',
                    stv_glossary_profile_TuTien: {
                        '萧炎': { hanviet: 'Tiêu Viêm', locked: true, count: 5 },
                        '药老': { hanviet: 'Dược Lão', locked: false, count: 3 }
                    }
                }
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T1.43: parseGlossaryLine parses novel term pairs across various separator formats', () => {
        const pair1 = GlossaryUtils.parseGlossaryLine('萧炎 = Tiêu Viêm');
        assert.ok(pair1);
        assert.strictEqual(pair1.orig, '萧炎');
        assert.strictEqual(pair1.hanviet, 'Tiêu Viêm');

        const pair2 = GlossaryUtils.parseGlossaryLine('纳兰嫣然 = Nạp Lan Yên Nhiên');
        assert.ok(pair2);
        assert.strictEqual(pair2.orig, '纳兰嫣然');
        assert.strictEqual(pair2.hanviet, 'Nạp Lan Yên Nhiên');

        const pair3 = GlossaryUtils.parseGlossaryLine('《焚诀》 = Phần Quyết');
        assert.ok(pair3);
        assert.strictEqual(pair3.orig, '焚诀');
        assert.strictEqual(pair3.hanviet, 'Phần Quyết');
    });

    it('T1.44: filters out generic nouns, occupation titles, and common words from auto-extraction', () => {
        assert.strictEqual(GlossaryUtils.isPureChineseTerm('掌柜'), true);
        const reason1 = GlossaryUtils.getNonProperNounReason('掌柜', 'Chưởng quầy');
        assert.ok(reason1, 'Common title "掌柜" must be rejected with non-proper noun reason');

        const reason2 = GlossaryUtils.getNonProperNounReason('店小二', 'Điếm tiểu nhị');
        assert.ok(reason2, 'Occupation "店小二" must be rejected');

        const validNameReason = GlossaryUtils.getNonProperNounReason('萧炎', 'Tiêu Viêm');
        assert.strictEqual(validNameReason, null, 'Character name "萧炎" must be accepted');
    });

    it('T1.45: locked terms cannot be overwritten by auto-extracted glossary updates', () => {
        const existing = {
            '萧炎': { hanviet: 'Tiêu Viêm', locked: true, count: 5 },
            '药老': { hanviet: 'Dược Lão', locked: false, count: 2 }
        };

        const incomingNew = {
            '萧炎': { hanviet: 'Tiểu Viêm', locked: false }, // Attempted override
            '药老': { hanviet: 'Dược Trần', locked: false },  // Unlocked update
            '海波东': { hanviet: 'Hải Ba Đông', locked: false } // Brand new term
        };

        const { merged, updated } = GlossaryUtils.mergeGlossaryTerms(existing, incomingNew);

        assert.strictEqual(updated, true);
        assert.strictEqual(merged['萧炎'].hanviet, 'Tiêu Viêm', 'Locked term MUST NOT be overwritten');
        assert.strictEqual(merged['萧炎'].locked, true);
        assert.strictEqual(merged['药老'].hanviet, 'Dược Trần', 'Unlocked term can be updated');
        assert.strictEqual(merged['海波东'].hanviet, 'Hải Ba Đông', 'New term must be added');
    });

    it('T1.46: in-memory glossary search filters terms with debounced delay', async () => {
        const terms = [
            { orig: '萧炎', hanviet: 'Tiêu Viêm' },
            { orig: '萧薰儿', hanviet: 'Tiêu Huân Nhi' },
            { orig: '美杜莎', hanviet: 'Mỹ Đỗ Toa' },
            { orig: '药老', hanviet: 'Dược Lão' }
        ];

        let searchDebounceTimer = null;
        let lastFiltered = null;

        function debouncedSearch(query, delay = 150) {
            return new Promise((resolve) => {
                if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
                searchDebounceTimer = setTimeout(() => {
                    const q = query.trim().toLowerCase();
                    lastFiltered = terms.filter(t => t.orig.toLowerCase().includes(q) || t.hanviet.toLowerCase().includes(q));
                    resolve(lastFiltered);
                }, delay);
            });
        }

        // Rapid typing: "T", "Ti", "Tiêu"
        debouncedSearch('T');
        debouncedSearch('Ti');
        const results = await debouncedSearch('Tiêu', 30);

        assert.strictEqual(results.length, 2);
        assert.strictEqual(results[0].orig, '萧炎');
        assert.strictEqual(results[1].orig, '萧薰儿');
    });

    it('T1.47: status filter pills toggle display between All, Locked, and Unlocked terms', () => {
        const terms = [
            { orig: '萧炎', hanviet: 'Tiêu Viêm', locked: true },
            { orig: '药老', hanviet: 'Dược Lão', locked: false },
            { orig: '海波东', hanviet: 'Hải Ba Đông', locked: false },
            { orig: '美杜莎', hanviet: 'Mỹ Đỗ Toa', locked: true }
        ];

        function filterByPill(pill) {
            if (pill === 'locked') return terms.filter(t => Boolean(t.locked));
            if (pill === 'unlocked') return terms.filter(t => !t.locked);
            return terms;
        }

        assert.strictEqual(filterByPill('all').length, 4);
        assert.strictEqual(filterByPill('locked').length, 2);
        assert.deepStrictEqual(filterByPill('locked').map(t => t.orig), ['萧炎', '美杜莎']);
        assert.strictEqual(filterByPill('unlocked').length, 2);
        assert.deepStrictEqual(filterByPill('unlocked').map(t => t.orig), ['药老', '海波东']);
    });

    it('T1.48: exports profile to JSON and merges imported JSON with conflict preservation', async () => {
        const profileData = await chrome.storage.local.get(['stv_glossary_profile_TuTien']);
        const currentProfile = profileData.stv_glossary_profile_TuTien;

        // 1. Export
        const exportedJson = JSON.stringify({
            version: 1,
            profile: 'TuTien',
            exportedAt: new Date().toISOString(),
            terms: currentProfile
        }, null, 2);

        assert.ok(exportedJson.includes('"萧炎"'));
        assert.ok(exportedJson.includes('"Tiêu Viêm"'));

        // 2. Import merge
        const importedData = JSON.parse(exportedJson);
        // Add conflicting incoming terms
        importedData.terms['萧炎'] = { hanviet: 'Tiểu Viêm Bị Đổi', locked: false };
        importedData.terms['云芝'] = { hanviet: 'Vân Chi', locked: true };

        const { merged } = GlossaryUtils.mergeGlossaryTerms(currentProfile, {
            '萧炎': importedData.terms['萧炎'],
            '云芝': importedData.terms['云芝']
        });

        // Locked existing term in active profile is preserved
        assert.strictEqual(merged['萧炎'].hanviet, 'Tiêu Viêm');
        assert.strictEqual(merged['云芝'].hanviet, 'Vân Chi');
    });
});
