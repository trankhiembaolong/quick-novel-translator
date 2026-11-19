'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STV_I18n = require(path.join(ROOT, 'i18n.js'));

test('VieNeu Setup Page: MV3 CSP compliance, DOM IDs, and no blocking dialogs', () => {
    const htmlPath = path.join(ROOT, 'vieneu-setup.html');
    const cssPath = path.join(ROOT, 'vieneu-setup.css');
    const jsPath = path.join(ROOT, 'vieneu-setup.js');

    assert.ok(fs.existsSync(htmlPath), 'vieneu-setup.html must exist');
    assert.ok(fs.existsSync(cssPath), 'vieneu-setup.css must exist');
    assert.ok(fs.existsSync(jsPath), 'vieneu-setup.js must exist');

    const html = fs.readFileSync(htmlPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');

    // MV3 CSP: no inline script bodies and no inline on*= handlers
    const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.ok(scriptTags.length >= 3, 'Expected external scripts loaded in vieneu-setup.html');
    for (const [, attrs, body] of scriptTags) {
        assert.ok(/\bsrc\s*=\s*['"][^'"]+['"]/i.test(attrs), 'Script tags must use src attribute');
        assert.equal(body.trim(), '', 'Inline <script> bodies are forbidden under MV3 CSP');
    }
    assert.ok(!/\son[a-z]+\s*=/i.test(html), 'Inline event handler attributes (on*=) are forbidden under MV3 CSP');

    assert.ok(!/\b(alert|confirm|prompt)\s*\(/.test(js), 'Blocking dialogs must not appear in vieneu-setup.js');
    assert.ok(!/D:\\Demo/i.test(html + js), 'Hardcoded developer path found in vieneu-setup assets');

    // Every $('id') or getElementById('id') referenced in vieneu-setup.js must exist in vieneu-setup.html
    const idRefs = [
        ...js.matchAll(/\$\(\s*['"]([a-zA-Z0-9_-]+)['"]\s*\)/g),
        ...js.matchAll(/document\.getElementById\(\s*['"]([a-zA-Z0-9_-]+)['"]\s*\)/g)
    ].map((m) => m[1]);
    assert.ok(idRefs.length >= 10, 'Expected vieneu-setup.js to bind DOM controls');
    for (const id of new Set(idRefs)) {
        assert.ok(
            html.includes(`id="${id}"`) || html.includes(`id='${id}'`),
            `Element id="${id}" referenced in vieneu-setup.js is missing from vieneu-setup.html`
        );
    }
});

test('VieNeu Setup Page: all data-i18n and data-i18n-attr keys exist in both vi and en', () => {
    const html = fs.readFileSync(path.join(ROOT, 'vieneu-setup.html'), 'utf8');

    const textKeys = [...html.matchAll(/data-i18n=['"]([a-zA-Z0-9_]+)['"]/g)].map((m) => m[1]);
    const attrSpecs = [...html.matchAll(/data-i18n-attr=['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const attrKeys = [];
    for (const spec of attrSpecs) {
        for (const pair of spec.split(',')) {
            const [, key] = pair.split(':').map((s) => s.trim());
            if (key) attrKeys.push(key);
        }
    }

    const allKeys = [...new Set([...textKeys, ...attrKeys])];
    assert.ok(allKeys.length >= 40, 'Expected comprehensive localized strings for vieneu-setup.html');

    for (const key of allKeys) {
        assert.ok(Object.hasOwn(STV_I18n.DICTIONARY.vi, key), `Missing vi i18n key: ${key}`);
        assert.ok(Object.hasOwn(STV_I18n.DICTIONARY.en, key), `Missing en i18n key: ${key}`);
    }
});

test('VieNeu Setup Page: copy buttons, accessible tabs, and dark-mode contracts', () => {
    const html = fs.readFileSync(path.join(ROOT, 'vieneu-setup.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'vieneu-setup.css'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'vieneu-setup.js'), 'utf8');

    // Copy buttons: command="--copy", valid commandfor targets, unique aria-label keys, single-path CommandEvent check
    const copyButtons = [...html.matchAll(/<button\b[^>]*class="copy-button"[^>]*>/g)].map((m) => m[0]);
    assert.ok(copyButtons.length >= 15, 'Expected copy buttons for all command blocks and Extension ID');
    const seenAriaKeys = new Set();
    for (const btnTag of copyButtons) {
        assert.ok(btnTag.includes('command="--copy"'), `Copy button missing command="--copy": ${btnTag}`);
        const targetMatch = btnTag.match(/commandfor="([a-zA-Z0-9_-]+)"/);
        assert.ok(targetMatch, `Copy button missing commandfor: ${btnTag}`);
        const targetId = targetMatch[1];
        assert.ok(html.includes(`id="${targetId}"`), `commandfor target #${targetId} missing in HTML`);
        const ariaKeyMatch = btnTag.match(/aria-label:([a-zA-Z0-9_]+)/);
        assert.ok(ariaKeyMatch, `Copy button missing localized aria-label: ${btnTag}`);
        assert.ok(!seenAriaKeys.has(ariaKeyMatch[1]), `Duplicate copy button aria-label key: ${ariaKeyMatch[1]}`);
        seenAriaKeys.add(ariaKeyMatch[1]);
    }
    assert.ok(js.includes("!('CommandEvent' in window)"), 'Must guard click fallback with CommandEvent feature detection');
    assert.ok(css.includes('.copy .tip') && css.includes('opacity: 0'), 'Copy tip bubble must toggle via opacity');

    // Accessible tabs: initial aria-selected and hidden="until-found", no aria-controls, beforematch handling, no headings inside <summary>
    const tabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
    assert.equal(tabs.length, 4, 'Expected 4 hardware/platform tabs');
    for (const tabTag of tabs) {
        assert.ok(/aria-selected="(true|false)"/.test(tabTag), `Tab missing aria-selected: ${tabTag}`);
        assert.ok(!/aria-controls=/.test(tabTag), `Tab should omit redundant aria-controls: ${tabTag}`);
    }
    const panels = [...html.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/g)].map((m) => m[0]);
    assert.equal(panels.length, 4, 'Expected 4 hardware/platform tabpanels');
    const untilFoundCount = panels.filter((p) => p.includes('hidden="until-found"')).length;
    assert.equal(untilFoundCount, 3, 'Inactive panels must render initial hidden="until-found"');
    assert.ok(js.includes("addEventListener('beforematch'"), 'Must sync tabs on beforematch for find-in-page');
    assert.ok(!/<summary\b[^>]*>[\s\S]*?<h[1-6]\b/i.test(html), 'Must not place headings inside <summary>');

    // Dark mode color-scheme
    assert.ok(html.includes('<meta name="color-scheme" content="dark light">'));
    assert.ok(css.includes('color-scheme: light dark;'));
    assert.ok(css.includes('@supports not (scrollbar-color: auto)'));
});

test('VieNeu Backend Wiring & Windows Companion Scripts', () => {
    const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
    const popupJs = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
    const hostPy = fs.readFileSync(path.join(ROOT, 'native-host', 'vieneu_host.py'), 'utf8');
    const setupBat = fs.readFileSync(path.join(ROOT, 'native-host', 'setup_vieneu.bat'), 'utf8');
    const installBat = fs.readFileSync(path.join(ROOT, 'native-host', 'install_host.bat'), 'utf8');
    const uninstallBat = fs.readFileSync(path.join(ROOT, 'native-host', 'uninstall_host.bat'), 'utf8');

    assert.ok(popupHtml.includes('value="cpu_fp32"'), 'popup.html must use value="cpu_fp32" for CPU ONNX FP32');
    assert.ok(popupJs.includes("chrome.runtime.getURL('vieneu-setup.html')"), 'showVieNeuGuide must open vieneu-setup.html');
    assert.ok(!/elif backend == "amd_gpu" or backend == "onnx"/.test(hostPy), 'amd_gpu must not swallow onnx CPU FP32 mode');
    assert.ok(hostPy.includes('elif backend in ("cpu_fp32", "onnx"):'), 'vieneu_host.py must map cpu_fp32 and legacy onnx to fp32');
    assert.ok(hostPy.includes('"vieneuDir": str(VIENEU_DIR)'), 'vieneu_host.py get_status must report vieneuDir');

    for (const [name, content] of [
        ['setup_vieneu.bat', setupBat],
        ['install_host.bat', installBat],
        ['uninstall_host.bat', uninstallBat]
    ]) {
        assert.ok(!/D:\\Demo/i.test(content), `Hardcoded developer path found in ${name}`);
    }
    assert.ok(installBat.includes('%LOCALAPPDATA%\\STV-VieNeu\\host'), 'install_host.bat must install to %LOCALAPPDATA%\\STV-VieNeu\\host');
    assert.ok(uninstallBat.includes('%LOCALAPPDATA%\\STV-VieNeu'), 'uninstall_host.bat must clean up %LOCALAPPDATA%\\STV-VieNeu');
    assert.ok(setupBat.includes('install_host.bat'), 'setup_vieneu.bat must invoke install_host.bat');
    assert.ok(setupBat.includes('uv sync') && setupBat.includes('--extra cuda') && setupBat.includes('onnxruntime-directml'));
});
