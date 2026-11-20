'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadTtsHelpers() {
    const code = fs.readFileSync(path.resolve(__dirname, '..', 'tts-player.js'), 'utf8');
    const sandbox = {
        window: undefined,
        globalThis: {},
        atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
        Blob,
        Float32Array,
        Int16Array,
        Uint8Array,
        ArrayBuffer,
        DataView,
        Math,
        Number,
        String,
        Array
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);
    return sandbox.STV_TTSHelpers;
}

test('float32ToInt16 converts normalized PCM samples with clamping and NaN safety', () => {
    const helpers = loadTtsHelpers();
    const input = new Float32Array([0, 1, -1, 1.8, -2.5, Number.NaN, 0.5]);
    const out = helpers.float32ToInt16(input);

    assert.ok(out instanceof Int16Array);
    assert.equal(out.length, 7);
    assert.equal(out[0], 0);
    assert.equal(out[1], 32767);
    assert.equal(out[2], -32768);
    assert.equal(out[3], 32767);
    assert.equal(out[4], -32768);
    assert.equal(out[5], 0);
    assert.equal(out[6], 16384);
});

test('encodeWavFromInt16Chunks produces valid 24kHz Mono 16-bit RIFF WAVE header and payload', async () => {
    const helpers = loadTtsHelpers();
    const backing = new Int16Array([999, 100, -200, 300, 400, -999]);
    const slicedChunk = backing.subarray(1, 5); // [100, -200, 300, 400]
    const extraChunk = new Int16Array([500, -600]);

    const res = helpers.encodeWavFromInt16Chunks([slicedChunk, new Int16Array(0), extraChunk], 24000);
    assert.equal(res.sampleRate, 24000);
    assert.equal(res.totalSamples, 6);
    assert.equal(res.byteLength, 44 + 6 * 2);
    assert.ok(res.blob);
    assert.equal(res.blob.size, res.byteLength);

    const buf = await res.blob.arrayBuffer();
    const view = new DataView(buf);
    const ascii = (start, len) => Buffer.from(buf, start, len).toString('ascii');

    assert.equal(ascii(0, 4), 'RIFF');
    assert.equal(view.getUint32(4, true), 36 + 12);
    assert.equal(ascii(8, 4), 'WAVE');
    assert.equal(ascii(12, 4), 'fmt ');
    assert.equal(view.getUint32(16, true), 16);
    assert.equal(view.getUint16(20, true), 1);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 24000);
    assert.equal(view.getUint32(28, true), 48000);
    assert.equal(view.getUint16(32, true), 2);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(ascii(36, 4), 'data');
    assert.equal(view.getUint32(40, true), 12);

    const decodedSamples = [
        view.getInt16(44, true),
        view.getInt16(46, true),
        view.getInt16(48, true),
        view.getInt16(50, true),
        view.getInt16(52, true),
        view.getInt16(54, true)
    ];
    assert.deepStrictEqual(decodedSamples, [100, -200, 300, 400, 500, -600]);
});

test('extractCleanTranslatedLines strips markers, glossary block, fences, and blank lines', () => {
    const helpers = loadTtsHelpers();
    const raw = [
        '```markdown',
        '[TRANSLATION]',
        '',
        '  Chương 5: Khởi hành  ',
        '',
        'Hắn bước ra khỏi sơn cốc.',
        '   ',
        '[GLOSSARY]',
        '山谷 = sơn cốc',
        '```'
    ].join('\n');

    const lines = Array.from(helpers.extractCleanTranslatedLines(raw));
    assert.deepStrictEqual(lines, [
        'Chương 5: Khởi hành',
        'Hắn bước ra khỏi sơn cốc.'
    ]);

    assert.deepStrictEqual(Array.from(helpers.extractCleanTranslatedLines('Chỉ có một dòng.\n\nDòng thứ hai.')), [
        'Chỉ có một dòng.',
        'Dòng thứ hai.'
    ]);
    assert.deepStrictEqual(Array.from(helpers.extractCleanTranslatedLines('')), []);
});

test('appendPackedSegment packs consecutive preloaded lines when domEl is null', () => {
    const helpers = loadTtsHelpers();
    const segments = [];
    helpers.appendPackedSegment(segments, 'Câu thứ nhất ngắn gọn', null, 0);
    helpers.appendPackedSegment(segments, 'Câu thứ hai cũng ngắn.', null, 0);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'Câu thứ nhất ngắn gọn. Câu thứ hai cũng ngắn.');
});

test('packSegmentsForExport merges short lines up to 210 chars across segments', () => {
    const helpers = loadTtsHelpers();
    const shortLines = [
        { text: 'Tiêu Viêm bước vào đại điện.' },
        { text: 'Mọi người đều quay sang nhìn hắn' },
        { text: 'Bầu không khí bỗng trở nên im lặng lạ thường.' },
        '   ',
        '---',
        { text: 'Một lát sau, trưởng lão mới chậm rãi mở lời hỏi thăm tình hình tu luyện của hắn trong suốt thời gian qua tại Ma Thú Sơn Mạch.' },
        { text: 'Hắn bình tĩnh đáp lại từng câu một cách dứt khoát và không hề nao núng trước ánh nhìn soi xét của đám người kia.' }
    ];

    const packed = Array.from(helpers.packSegmentsForExport(shortLines, 210));
    assert.ok(packed.length >= 2 && packed.length <= 3, `Expected 2-3 packed chunks, got ${packed.length}`);
    for (const seg of packed) {
        assert.ok(seg.text.length <= 210, `Packed segment length ${seg.text.length} exceeds 210`);
    }
    const joined = packed.map((s) => s.text).join(' ');
    assert.ok(joined.includes('Tiêu Viêm bước vào đại điện. Mọi người đều quay sang nhìn hắn.'));
    assert.ok(joined.includes('đám người kia.'));
});

test('AMD GPU DirectML backend option is wired across popup.html, i18n.js, tts-player.js, background.js, and native host', () => {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
    const hostPy = fs.readFileSync(path.join(root, 'native-host', 'vieneu_host.py'), 'utf8');
    const runnerPy = fs.readFileSync(path.join(root, 'native-host', 'vieneu_server_runner.py'), 'utf8');
    const playerJs = fs.readFileSync(path.join(root, 'tts-player.js'), 'utf8');
    const backgroundJs = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    const i18n = require(path.join(root, 'i18n.js'));

    assert.ok(html.includes('value="amd_gpu"'), 'popup.html must offer amd_gpu option');
    assert.ok(html.includes('data-i18n="optBackendAmdGpu"'), 'popup.html must localize amd_gpu option');
    assert.ok(typeof i18n.DICTIONARY.vi.optBackendAmdGpu === 'string' && i18n.DICTIONARY.vi.optBackendAmdGpu.length > 0);
    assert.ok(typeof i18n.DICTIONARY.en.optBackendAmdGpu === 'string' && i18n.DICTIONARY.en.optBackendAmdGpu.length > 0);

    assert.ok(hostPy.includes('backend == "amd_gpu"'), 'vieneu_host.py must handle amd_gpu backend');
    assert.ok(hostPy.includes('env["VIENEU_PRECISION"] = "amd_gpu"'));
    assert.ok(hostPy.includes('env["VIENEU_MAX_STREAMS"] = "1"'), 'vieneu_host.py must start web listening with 1 worker');
    assert.ok(hostPy.includes('env["VIENEU_EXPORT_MAX_STREAMS"] = "3"'), 'vieneu_host.py must allow 3-worker export scaling');
    assert.ok(hostPy.includes('env["OPENBLAS_NUM_THREADS"] = "1"'), 'vieneu_host.py must constrain BLAS threads to 1');
    assert.ok(!hostPy.includes('ABOVE_NORMAL_PRIORITY_CLASS'), 'vieneu_host.py must not starve Chrome/UI with ABOVE_NORMAL priority');

    assert.ok(runnerPy.includes('detect_amd_dml_device_id'), 'vieneu_server_runner.py must detect discrete DirectML adapter');
    assert.ok(runnerPy.includes('SubprocessDmlWorker'), 'vieneu_server_runner.py must support isolated second GPU process');
    assert.ok(runnerPy.includes('DmlExecutionProvider'));
    assert.ok(runnerPy.includes('ResizableGate'), 'vieneu_server_runner.py must use ResizableGate for live 1 <-> 3 scaling');
    assert.ok(runnerPy.includes('/v1/workers/mode'), 'vieneu_server_runner.py must expose /v1/workers/mode endpoint');
    assert.ok(runnerPy.includes('allow_spinning'), 'vieneu_server_runner.py must disable ORT busy spinning');
    assert.ok(runnerPy.includes('OPENBLAS_NUM_THREADS'), 'vieneu_server_runner.py must enforce OPENBLAS_NUM_THREADS=1');
    assert.ok(runnerPy.includes('eng._ac_pos_steps[ch]'), 'acoustic frame step must index _ac_pos_steps[ch] cleanly');
    assert.ok(!runnerPy.includes('eng._ac_pos_steps[ch - 1]'), 'must not shift acoustic RoPE position_ids by -1');
    assert.ok(!/sess_codec_dec[\s\S]{0,120}providers=dml_prov/.test(runnerPy), 'MOSS codec decoder must stay on CPU to avoid DirectML ConvTranspose hum');

    assert.ok(playerJs.includes('const EXPORT_CONCURRENCY = 3;'), 'tts-player.js must permit 3 concurrent WAV export streams');
    assert.ok(playerJs.includes('vieneu_set_worker_mode'), 'tts-player.js must scale VieNeu workers around WAV export');
    assert.ok(backgroundJs.includes("request.action === 'vieneu_set_worker_mode'"), 'background.js must proxy vieneu_set_worker_mode');
});

test('optimized decodePcm16Base64ToFloat32, createAnchorTrimmer, and WSOLAProcessor preserve accuracy', () => {
    const helpers = loadTtsHelpers();

    // 1. decodePcm16Base64ToFloat32 exact conversion
    const pcm = new Int16Array([0, 16384, -32768, 32767]);
    const b64 = Buffer.from(pcm.buffer).toString('base64');
    const f32 = helpers.decodePcm16Base64ToFloat32(b64);
    assert.equal(f32.length, 4);
    assert.equal(f32[0], 0);
    assert.ok(Math.abs(f32[1] - 0.5) < 1e-6);
    assert.equal(f32[2], -1);
    assert.ok(Math.abs(f32[3] - (32767 / 32768)) < 1e-6);

    // 2. incremental createAnchorTrimmer detects anchor + valley across uneven chunk boundaries
    const sr = 16000; // hop = 160 samples (10ms)
    const trimmer = helpers.createAnchorTrimmer(sr);
    const hop = 160;
    const totalFrames = 30; // 10 active anchor, 10 silence valley, 10 speech
    const full = new Float32Array(totalFrames * hop);
    for (let f = 0; f < 10; f++) {
        for (let k = 0; k < hop; k++) full[f * hop + k] = 0.2;
    }
    // frames 10..19 stay 0.0 (valley >= 7 frames)
    for (let f = 20; f < 30; f++) {
        for (let k = 0; k < hop; k++) full[f * hop + k] = 0.25;
    }
    // Push in awkward non-hop-aligned slices (e.g. 250 samples)
    const emitted = [];
    for (let off = 0; off < full.length; off += 250) {
        const piece = full.subarray(off, Math.min(full.length, off + 250));
        const res = trimmer.push(piece);
        if (res && res.length > 0) emitted.push(res);
    }
    const rest = trimmer.flush();
    if (rest && rest.length > 0) emitted.push(rest);
    const totalEmitted = emitted.reduce((sum, c) => sum + c.length, 0);
    assert.ok(totalEmitted > 0, 'Anchor trimmer must emit trimmed speech audio');
    assert.ok(totalEmitted <= (totalFrames - 12) * hop, `Anchor prefix must be trimmed (got ${totalEmitted})`);
    assert.ok(totalEmitted >= 10 * hop, `Speech body must be preserved (got ${totalEmitted})`);

    // 3. hierarchical WSOLAProcessor at 1.5x and 0.8x produces finite output at expected duration ratio
    for (const speed of [1.5, 0.8]) {
        const wsola = new helpers.WSOLAProcessor(48000, speed);
        const src = new Float32Array(48000); // 1 second 440Hz sine
        for (let i = 0; i < src.length; i++) {
            src[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
        }
        const out1 = wsola.process(src.subarray(0, 24000));
        const out2 = wsola.process(src.subarray(24000));
        const out3 = wsola.flush();
        const totalOut = out1.length + out2.length + out3.length;
        const expected = 48000 / speed;
        assert.ok(Math.abs(totalOut - expected) < 6000, `Expected ~${expected} samples at ${speed}x, got ${totalOut}`);
        for (const chunk of [out1, out2, out3]) {
            for (let i = 0; i < chunk.length; i++) {
                assert.ok(Number.isFinite(chunk[i]), 'WSOLA output samples must be finite');
            }
        }
    }
});

test('tts-player Shadow DOM enforces [hidden] over flex download bars and background falls back on pending nextUrl', () => {
    const root = path.resolve(__dirname, '..');
    const playerJs = fs.readFileSync(path.join(root, 'tts-player.js'), 'utf8');
    const backgroundJs = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

    assert.ok(
        /#stv-tts-player\s+\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/.test(playerJs),
        'TTS_PLAYER_SHADOW_CSS must ensure [hidden] hides flex rows such as dlIdleRow and dlActiveBox'
    );
    assert.ok(
        backgroundJs.includes('extracted.pendingNextUrl') && backgroundJs.includes('extractChunksViaHiddenIframe'),
        'background preload must fall back to hidden iframe when raw HTML only has a pending placeholder nextUrl'
    );
});

test('packSegmentsForExport avoids multi-part rawText duplication and double icon wrapping', () => {
    const describerCode = fs.readFileSync(path.resolve(__dirname, '..', 'tts-icon-describer.js'), 'utf8');
    const playerCode = fs.readFileSync(path.resolve(__dirname, '..', 'tts-player.js'), 'utf8');
    const sandbox = {
        window: undefined,
        globalThis: {},
        atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
        Blob,
        Float32Array,
        Int16Array,
        Uint8Array,
        ArrayBuffer,
        DataView,
        Math,
        Number,
        String,
        Array
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(describerCode, sandbox);
    vm.runInNewContext(playerCode, sandbox);
    const helpers = sandbox.STV_TTSHelpers;

    const longParagraph = [
        'Đoạn mở đầu rất dài nói về hành trình tu luyện gian khổ trong núi sâu qua nhiều năm tháng trường kỳ.',
        'Đoạn tiếp theo kể về việc hắn tìm thấy bí kíp cổ xưa dưới đáy vực thẳm lạnh lẽo đầy sương mù.',
        'Đoạn cuối cùng miêu tả cảnh hắn đột phá cảnh giới giữa cơn giông bão mịt mù trời đất.'
    ].join(' ');

    const segments = [];
    helpers.appendPackedSegment(segments, longParagraph, null, 0, { mode: 'auto', style: 'tagged' });
    assert.ok(segments.length >= 2, 'Long paragraph must split across multiple playback segments');

    const exported = helpers.packSegmentsForExport(segments, 210, { mode: 'auto', style: 'tagged' });
    const joined = exported.map((s) => s.text).join(' ');
    const firstSentenceCount = joined.split('Đoạn mở đầu rất dài').length - 1;
    assert.equal(firstSentenceCount, 1, 'Multi-part paragraph must not be duplicated when repacked for export');

    const kaomojiSegments = [];
    const iconOpts = { mode: 'auto', style: 'tagged' };
    helpers.appendPackedSegment(kaomojiSegments, 'Sở Oánh: "Con gái, sao thế?"', null, 0, iconOpts);
    helpers.appendPackedSegment(kaomojiSegments, 'Cô con gái: ૮ε˚۵ ⋋ʌ⋋۵ 3˚ა', null, 0, iconOpts);
    helpers.appendPackedSegment(kaomojiSegments, 'Cô lao bổ vào Sở Oánh.', null, 0, iconOpts);

    const packedKaomoji = helpers.packSegmentsForExport(kaomojiSegments, 210, iconOpts);
    assert.equal(packedKaomoji.length, 3, 'Kaomoji segment must not merge into adjacent prose segments');
    assert.equal(packedKaomoji[1].needsAiIconResolve, true);
    assert.ok(!/biểu cảm\s+biểu cảm/i.test(packedKaomoji[1].text), `Must not double-wrap tag: ${packedKaomoji[1].text}`);
});

test('getColabGpuExportConfig returns exact workers and maxChunkChars per GPU tier and auto-scales from healthData', () => {
    const helpers = loadTtsHelpers();
    assert.equal(typeof helpers.getColabGpuExportConfig, 'function');

    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('T4') }, { tier: 'T4', workers: 6, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('L4') }, { tier: 'L4', workers: 8, maxChunkChars: 320 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('A100') }, { tier: 'A100', workers: 12, maxChunkChars: 350 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('auto') }, { tier: 'auto', workers: 6, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('auto', { export_max_streams: 8 }) }, { tier: 'auto', workers: 8, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('auto', { export_max_streams: 12 }) }, { tier: 'auto', workers: 12, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('auto', { export_max_streams: 24 }) }, { tier: 'auto', workers: 12, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('T4', { export_max_streams: 12 }) }, { tier: 'T4', workers: 6, maxChunkChars: 300 });
    assert.deepStrictEqual({ ...helpers.getColabGpuExportConfig('unknown-tier') }, { tier: 'T4', workers: 6, maxChunkChars: 300 });
});

test('Google Colab GPU export option and GPU tier selector are wired across popup, i18n, background, tts-player, and colab assets', () => {
    const root = path.resolve(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
    const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
    const backgroundJs = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    const playerJs = fs.readFileSync(path.join(root, 'tts-player.js'), 'utf8');
    const runnerPy = fs.readFileSync(path.join(root, 'colab', 'vieneu_colab_runner.py'), 'utf8');
    const notebook = JSON.parse(fs.readFileSync(path.join(root, 'colab', 'VieNeu_Colab_GPU.ipynb'), 'utf8'));
    const i18n = require(path.join(root, 'i18n.js'));

    // Popup controls & GPU tier options
    for (const id of [
        'tts-download-source', 'tts-colab-panel', 'tts-colab-badge', 'tts-colab-status-label',
        'tts-colab-gpu-pill', 'btn-tts-colab-open', 'btn-tts-colab-copy', 'tts-colab-url',
        'btn-tts-colab-paste', 'tts-colab-voice', 'tts-colab-hint', 'tts-colab-gpu'
    ]) {
        assert.ok(html.includes(`id="${id}"`), `popup.html missing #${id}`);
    }
    assert.ok(html.includes('value="colab_gpu"'));
    for (const tier of ['value="T4"', 'value="L4"', 'value="A100"', 'value="auto"']) {
        assert.ok(html.includes(tier), `popup.html missing Colab GPU tier ${tier}`);
    }

    assert.ok(popupJs.includes('https://*.trycloudflare.com/*'));
    assert.ok(popupJs.includes('ensureColabTunnelPermission'));
    assert.ok(popupJs.includes('ttsDownloadSource') && popupJs.includes('ttsColabUrl') && popupJs.includes('ttsColabGpu'));

    // Background & Player
    assert.ok(backgroundJs.includes('Math.min(12, Math.floor(Number(request.workers)))'));
    assert.ok(backgroundJs.includes('ngrok-skip-browser-warning'));
    assert.ok(backgroundJs.includes('syncColabOriginStripRule'));
    assert.ok(playerJs.includes('COLAB_TIER_CONFIG') && playerJs.includes('getColabGpuExportConfig'));
    assert.ok(playerJs.includes("requestedSource === 'colab_gpu'"));

    // Colab notebook & runner
    assert.equal(notebook.metadata.accelerator, 'GPU');
    assert.equal(notebook.metadata.colab.gpuType, 'T4');
    assert.equal(notebook.cells[0].metadata.cellView, 'form');
    assert.ok(runnerPy.includes('CORSMiddleware'));
    assert.ok(runnerPy.includes('le=12'));
    assert.ok(runnerPy.includes('"colab": True'));

    // i18n keys
    for (const key of [
        'tts_download_source_colab', 'tts_colab_btn_open', 'tts_colab_btn_paste',
        'settings_colab_gpu_label', 'optColabGpuT4', 'optColabGpuL4', 'optColabGpuA100', 'optColabGpuAuto'
    ]) {
        assert.ok(typeof i18n.DICTIONARY.vi[key] === 'string' && i18n.DICTIONARY.vi[key].length > 0, `Missing vi key ${key}`);
        assert.ok(typeof i18n.DICTIONARY.en[key] === 'string' && i18n.DICTIONARY.en[key].length > 0, `Missing en key ${key}`);
    }
});

test('startTTSDownload routes colab_gpu exports independently of webspeech listening engine', async () => {
    const code = fs.readFileSync(path.resolve(__dirname, '..', 'tts-player.js'), 'utf8');
    const messages = [];
    const portStarts = [];
    const createdAnchorClicks = [];

    const makeEl = (tag) => ({
        tagName: tag.toUpperCase(),
        style: {},
        dataset: {},
        classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {},
        getAttribute() { return ''; },
        appendChild() {},
        append() {},
        remove() {},
        click() { createdAnchorClicks.push(this.download); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {}
    });

    const lineEl = { textContent: 'Tiêu Viêm bước ra khỏi đại điện.', classList: { contains: () => false } };
    const doc = {
        head: { appendChild() {} },
        body: { appendChild() {} },
        documentElement: { appendChild() {} },
        contains: () => true,
        addEventListener() {},
        removeEventListener() {},
        getElementById(id) {
            if (id === 'stv-tts-root') return { shadowRoot: { innerHTML: '', append() {} } };
            return null;
        },
        querySelectorAll(sel) {
            if (sel && sel.includes('.stv-line')) return [lineEl];
            return [];
        },
        createElement: makeEl
    };
    doc.body.querySelectorAll = doc.querySelectorAll;

    const sandbox = {
        window: undefined,
        globalThis: {},
        document: doc,
        location: { href: 'https://example.com/ch1' },
        URL: { createObjectURL: () => 'blob:mock-wav', revokeObjectURL() {} },
        atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
        Blob,
        Float32Array,
        Int16Array,
        Uint8Array,
        ArrayBuffer,
        DataView,
        Math,
        Number,
        String,
        Array,
        Set,
        Map,
        Promise,
        Error,
        setTimeout: (fn, ms, ...args) => {
            const handle = setTimeout(fn, ms, ...args);
            if (handle && typeof handle.unref === 'function') handle.unref();
            return handle;
        },
        clearTimeout,
        addEventListener() {},
        chrome: {
            runtime: {
                id: 'test-ext-id',
                lastError: null,
                sendMessage(msg, cb) {
                    messages.push(msg);
                    if (msg.action === 'get_tts_runtime_config') {
                        cb({
                            ok: true,
                            data: {
                                ttsEngine: 'webspeech',
                                ttsEndpoint: 'http://127.0.0.1:8000',
                                ttsDownloadSource: 'colab_gpu',
                                ttsColabUrl: 'https://fast-gpu.trycloudflare.com',
                                ttsColabVoice: 'Binh',
                                ttsColabGpu: 'A100',
                                ttsIconMode: 'off'
                            }
                        });
                    } else if (msg.action === 'vieneu_check_health') {
                        cb({ ok: true, data: { status: 'ok', gpu_name: 'NVIDIA A100', export_max_streams: 12 } });
                    } else if (msg.action === 'vieneu_set_worker_mode') {
                        cb({ ok: true, data: { mode: msg.mode, max_streams: msg.workers || 6, active_workers: msg.workers || 6 } });
                    } else {
                        cb({ ok: true });
                    }
                },
                connect({ name }) {
                    const listeners = { msg: [], disc: [] };
                    return {
                        name,
                        onMessage: { addListener: (fn) => listeners.msg.push(fn) },
                        onDisconnect: { addListener: (fn) => listeners.disc.push(fn) },
                        disconnect() {},
                        postMessage(msg) {
                            if (msg.type === 'start') {
                                portStarts.push(msg);
                                const pcm = new Int16Array(2400).fill(500);
                                const b64 = Buffer.from(pcm.buffer).toString('base64');
                                queueMicrotask(() => {
                                    listeners.msg.forEach((fn) => fn({ type: 'chunk', audio: b64, sampleRate: 24000 }));
                                    listeners.msg.forEach((fn) => fn({ type: 'done' }));
                                });
                            }
                        }
                    };
                }
            }
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(code, sandbox);

    const res = await sandbox.STV_TTSController.startDownload({ downloadMinutes: 1 });
    assert.equal(res.ok, true, `Expected download ok, got: ${JSON.stringify(res)}`);
    assert.equal(sandbox.STV_TTSController.getState().engine, 'webspeech');
    assert.equal(portStarts.length, 1);
    assert.equal(portStarts[0].serverUrl, 'https://fast-gpu.trycloudflare.com');
    assert.equal(portStarts[0].voice, 'Binh');

    const scaleExportMsg = messages.find((m) => m.action === 'vieneu_set_worker_mode' && m.mode === 'export');
    assert.ok(scaleExportMsg);
    assert.equal(scaleExportMsg.serverUrl, 'https://fast-gpu.trycloudflare.com');
    assert.equal(scaleExportMsg.workers, 12);
    assert.equal(scaleExportMsg.gpuTier, 'A100');

    const scaleListenMsg = messages.find((m) => m.action === 'vieneu_set_worker_mode' && m.mode === 'listen');
    assert.ok(scaleListenMsg);
    assert.equal(scaleListenMsg.serverUrl, 'https://fast-gpu.trycloudflare.com');
    assert.equal(createdAnchorClicks.length, 1);
});
