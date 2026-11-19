'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STV_I18n = require(path.join(ROOT, 'i18n.js'));

test('Production Compliance: i18n vi/en key parity & interpolation', () => {
    const viKeys = Object.keys(STV_I18n.DICTIONARY.vi).sort();
    const enKeys = Object.keys(STV_I18n.DICTIONARY.en).sort();
    assert.deepStrictEqual(viKeys, enKeys, 'vi and en dictionaries must have identical keys');

    assert.equal(STV_I18n.t('site_selector_saved', { host: 'example.com' }, 'en'), 'Saved selector for example.com');
    assert.equal(STV_I18n.t('site_selector_saved', { host: 'example.com' }, 'vi'), 'Đã lưu vùng chọn cho example.com');
});

test('Production Compliance: manifest.json MV3 permissions & optimized icons (<100 KB)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(!manifest.content_scripts, 'Should not declare unconditional content_scripts');
    assert.ok(!(manifest.host_permissions || []).includes('<all_urls>'), 'Must not request <all_urls> in host_permissions');
    assert.ok((manifest.optional_host_permissions || []).includes('*://*/*'), 'Must support optional_host_permissions');

    const war = manifest.web_accessible_resources || [];
    assert.ok(war.length > 0 && war.every((entry) => entry.use_dynamic_url === true), 'web_accessible_resources must set use_dynamic_url: true');

    const iconPaths = Object.values(manifest.icons || {});
    assert.ok(iconPaths.length >= 3);
    let totalBytes = 0;
    for (const rel of iconPaths) {
        const full = path.join(ROOT, rel);
        assert.ok(fs.existsSync(full), `Icon missing: ${rel}`);
        totalBytes += fs.statSync(full).size;
    }
    assert.ok(totalBytes < 100 * 1024, `Total icon size ${totalBytes} must be < 100 KB`);
});

test('Production Compliance: popup.js element IDs exist in popup.html', () => {
    const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
    const idMatches = [...js.matchAll(/\$\(\s*['"]([a-zA-Z0-9_-]+)['"]\s*\)/g)].map((m) => m[1]);
    const uniqueIds = [...new Set(idMatches)];
    assert.ok(uniqueIds.length > 30, 'Expected popup.js to bind popup.html controls');

    for (const id of uniqueIds) {
        assert.ok(
            html.includes(`id="${id}"`) || html.includes(`id='${id}'`),
            `Element id="${id}" referenced in popup.js is missing from popup.html`
        );
    }
});

test('Production Compliance: no blocking dialogs or hardcoded developer paths', () => {
    const filesToCheck = [
        'background.js',
        'extractor.js',
        'glossary-utils.js',
        'i18n.js',
        'page-ui.js',
        'picker.js',
        'popup.js',
        'translator.js',
        'tts-player.js',
        'url-validator.js',
        path.join('native-host', 'vieneu_host.py'),
        path.join('native-host', 'vieneu_server_runner.py'),
        path.join('native-host', 'install_host.bat'),
        path.join('native-host', 'vieneu_host.bat')
    ];

    for (const rel of filesToCheck) {
        const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        assert.ok(!/D:\\Demo/i.test(content), `Hardcoded developer path found in ${rel}`);
        if (rel.endsWith('.js')) {
            assert.ok(!/\b(alert|confirm|prompt)\s*\(/.test(content), `Blocking dialog found in ${rel}`);
        }
    }
});
