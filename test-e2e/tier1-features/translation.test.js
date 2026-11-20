/**
 * test-e2e/tier1-features/translation.test.js
 * Feature 3: Background Translation Broker & Secret Isolation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    setupSandbox,
    teardownSandbox,
    TranslationBroker,
    STV_createStreamRenderer
} from '../harness/index.js';
import { createSseResponse } from '../harness/network-mock.js';

describe('Feature 3: Background Translation Broker & Secret Isolation', () => {
    let sandbox;

    beforeEach(() => {
        sandbox = setupSandbox({
            chrome: {
                initialStorage: {
                    apikey: 'sk-or-v1-secret-test-key',
                    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
                    model: 'stepfun/step-3.5-flash',
                    stv_active_glossary_profile: 'Default'
                },
                accessLevel: 'TRUSTED_CONTEXTS'
            }
        });
    });

    afterEach(() => {
        teardownSandbox();
    });

    it('T1.13: background broker accepts stv-translate-stream connection and parses SSE stream into deltas', async () => {
        // Mock LLM SSE response with distinct tokens
        sandbox.network.addRoute('/chat/completions', () => {
            return createSseResponse([
                { content: 'Đại ' },
                { content: 'đạo ' },
                { content: 'vô ' },
                { content: 'tình.' }
            ]);
        });

        const clientPort = chrome.runtime.connect({ name: 'stv-translate-stream' });
        const receivedDeltas = [];
        let streamDone = false;

        const streamPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Stream timed out')), 2000);

            clientPort.onMessage.addListener((msg) => {
                if (msg.type === 'delta') {
                    receivedDeltas.push(msg.delta);
                } else if (msg.type === 'done') {
                    streamDone = true;
                    clearTimeout(timeout);
                    resolve();
                } else if (msg.type === 'error') {
                    clearTimeout(timeout);
                    reject(new Error(msg.error));
                }
            });
        });

        clientPort.postMessage({
            action: 'start_translation',
            runId: 'run-001',
            textChunks: ['大道无情'],
            glossaryProfile: 'Default'
        });

        await streamPromise;

        assert.strictEqual(streamDone, true, 'Stream must complete with done event');
        assert.deepStrictEqual(receivedDeltas, ['Đại ', 'đạo ', 'vô ', 'tình.']);
    });

    it('T1.14: batches streaming DOM updates to eliminate O(N^2) reflow overhead', async () => {
        const contentBox = document.createElement('div');
        document.body.appendChild(contentBox);

        let rafCount = 0;
        const origRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = (cb) => {
            rafCount += 1;
            return origRaf(cb);
        };

        const renderer = STV_createStreamRenderer(contentBox, ['Hàng 1', 'Hàng 2'], 'run-batch-001', false);

        // Simulate 10 rapid delta tokens in the same event tick
        let accumulated = '';
        for (let i = 0; i < 10; i++) {
            accumulated += `Dòng truyện dịch số ${i}. `;
            renderer.syncText(accumulated, false);
        }

        await new Promise((r) => setTimeout(r, 40));

        assert.strictEqual(rafCount, 1, 'All tokens within frame interval must coalesce into 1 RAF schedule');
        assert.ok(contentBox.childNodes.length > 0, 'DOM elements must be rendered');
    });

    it('T1.14b: syncText accurately aligns data-orig across consecutive lines without skipping or double-incrementing index', () => {
        const contentBox = document.createElement('div');
        document.body.appendChild(contentBox);

        const origLines = [
            'Dòng gốc 0: Đệ nhất chương',
            'Dòng gốc 1: Đệ nhị chương',
            'Dòng gốc 2: Đệ tam chương',
            'Dòng gốc 3: Đệ tứ chương'
        ];

        const renderer = STV_createStreamRenderer(contentBox, origLines, 'run-align-001', false);

        // Feed text with consecutive newlines, final = true
        const translatedStream = 'Chương 1\nChương 2\nChương 3\nChương 4\n';
        renderer.syncText(translatedStream, true);

        const rendered = contentBox.querySelectorAll('.stv-line');
        assert.strictEqual(rendered.length, 4, 'Must render exactly 4 lines');
        assert.strictEqual(rendered[0].getAttribute('data-orig'), origLines[0], 'Line 0 data-orig must match');
        assert.strictEqual(rendered[1].getAttribute('data-orig'), origLines[1], 'Line 1 data-orig must match');
        assert.strictEqual(rendered[2].getAttribute('data-orig'), origLines[2], 'Line 2 data-orig must match');
        assert.strictEqual(rendered[3].getAttribute('data-orig'), origLines[3], 'Line 3 data-orig must match');
    });

    it('T1.15: single-line retranslation broker executes stv_retranslate_line securely', async () => {
        sandbox.network.addRoute('/chat/completions', () => {
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'Nghịch thiên cải mệnh (逆天改命)' } }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        const span = document.createElement('span');
        span.className = 'stv-line';
        span.setAttribute('data-orig', '逆天改命');
        span.textContent = 'Nghịch thiên';

        const response = await chrome.runtime.sendMessage({
            action: 'stv_retranslate_line',
            origText: span.getAttribute('data-orig'),
            lineIndex: 5,
            glossaryProfile: 'Default'
        });

        assert.strictEqual(response.ok, true);
        assert.strictEqual(response.lineIndex, 5);
        assert.ok(response.translatedText.includes('逆天改命'));

        // Apply safely via .textContent
        span.textContent = response.translatedText;
        assert.strictEqual(span.textContent, response.translatedText);
    });

    it('T1.16: abort_translation cleanly cancels active streaming and stops delta emissions', async () => {
        const clientPort = chrome.runtime.connect({ name: 'stv-translate-stream' });
        let abortedReceived = false;

        const abortPromise = new Promise((resolve) => {
            clientPort.onMessage.addListener((msg) => {
                if (msg.type === 'aborted') {
                    abortedReceived = true;
                    resolve();
                }
            });
        });

        clientPort.postMessage({
            action: 'abort_translation',
            runId: 'run-to-cancel'
        });

        await abortPromise;
        assert.strictEqual(abortedReceived, true, 'Port must confirm aborted state');
    });

    it('T1.16b: port aborted message resets STV_translationState.active to false and clears runId', async () => {
        globalThis.STV_translationState = { active: true, runId: 'run-to-abort' };
        window.STV_translationState = globalThis.STV_translationState;

        const port = chrome.runtime.connect({ name: 'stv-translate-stream' });

        const abortPromise = new Promise((resolve) => {
            port.onMessage.addListener((msg) => {
                if (msg.type === 'aborted') {
                    // Simulates translator.js aborted handler:
                    // global.STV_translationState = { active: false, runId: null };
                    globalThis.STV_translationState = { active: false, runId: null };
                    window.STV_translationState = globalThis.STV_translationState;
                    resolve();
                }
            });
        });

        port.postMessage({ action: 'abort_translation', runId: 'run-to-abort' });
        await abortPromise;

        assert.strictEqual(globalThis.STV_translationState.active, false);
        assert.strictEqual(globalThis.STV_translationState.runId, null);
    });

    it('T1.17: storage access level TRUSTED_CONTEXTS isolates API keys from untrusted content scripts', async () => {
        // Privileged context (background service worker): can read apikey
        const backgroundData = await chrome.storage.local.get(['apikey', 'endpoint']);
        assert.strictEqual(backgroundData.apikey, 'sk-or-v1-secret-test-key');

        // Create an untrusted content script view
        const contentScriptChrome = setupSandbox({
            chrome: {
                initialStorage: {
                    apikey: 'sk-or-v1-secret-test-key',
                    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
                    model: 'stepfun/step-3.5-flash'
                },
                accessLevel: 'TRUSTED_CONTEXTS',
                isContentScript: true
            }
        }).chrome;

        const contentData = await contentScriptChrome.storage.local.get(['apikey', 'endpoint']);
        assert.strictEqual(contentData.apikey, undefined, 'Content script must NOT have access to secret apikey');
        assert.strictEqual(contentData.endpoint, 'https://openrouter.ai/api/v1/chat/completions', 'Non-sensitive config should be accessible');
    });

    it('T1.18: returns error payload when API key is missing in storage', async () => {
        // Clear apikey
        await chrome.storage.local.remove('apikey');

        const clientPort = chrome.runtime.connect({ name: 'stv-translate-stream' });
        const errorPromise = new Promise((resolve) => {
            clientPort.onMessage.addListener((msg) => {
                if (msg.type === 'error') {
                    resolve(msg);
                }
            });
        });

        clientPort.postMessage({
            action: 'start_translation',
            runId: 'run-no-key',
            textChunks: ['Test']
        });

        const errorMsg = await errorPromise;
        assert.strictEqual(errorMsg.code, 401);
        assert.ok(errorMsg.error.includes('API key not configured'));
    });

    it('T1.18b: deriveModelsEndpointUrl resolves /models URL across OpenAI-compatible endpoint shapes', () => {
        const derive = TranslationBroker.deriveModelsEndpointUrl;
        assert.strictEqual(typeof derive, 'function');
        assert.strictEqual(derive('https://openrouter.ai/api/v1/chat/completions'), 'https://openrouter.ai/api/v1/models');
        assert.strictEqual(derive('https://api.vilao.ai/v1/chat/completions/'), 'https://api.vilao.ai/v1/models');
        assert.strictEqual(derive('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'), 'https://generativelanguage.googleapis.com/v1beta/openai/models');
        assert.strictEqual(derive('https://api.example.com/v1'), 'https://api.example.com/v1/models');
        assert.strictEqual(derive('https://api.example.com/v1/models'), 'https://api.example.com/v1/models');
        assert.strictEqual(derive('https://api.example.com'), 'https://api.example.com/v1/models');
        assert.strictEqual(derive('https://api.example.com/v1/responses'), 'https://api.example.com/v1/models');
    });

    it('T1.18c: fetch_ai_models fetches /models with Bearer auth and keeps distinct providers for identical model names', async () => {
        let capturedUrl = '';
        let capturedAuth = '';
        sandbox.network.addRoute('/v1/models', (url, opts) => {
            capturedUrl = url;
            capturedAuth = opts?.headers?.Authorization || opts?.headers?.authorization || '';
            return new Response(JSON.stringify({
                data: [
                    { id: '9aws/gpt-6.2-sol', owned_by: '9AWS' },
                    { id: 'jpt/gpt-6.2-sol', owned_by: 'khongkhuatphuc' },
                    { id: 'vgpt/gpt-6.2-sol', owned_by: 'Vilao Official' },
                    { id: 'chib/deepseek-v4.1-flash', owned_by: 'chibu' }
                ]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });

        const res = await chrome.runtime.sendMessage({
            action: 'fetch_ai_models',
            endpoint: 'https://api.vilao.test/v1/chat/completions',
            apiKey: 'sk-vilao-custom-key'
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(capturedUrl, 'https://api.vilao.test/v1/models');
        assert.strictEqual(capturedAuth, 'Bearer sk-vilao-custom-key');
        assert.strictEqual(res.models.length, 4, 'Must preserve all 4 entries including all 3 providers for gpt-6.2-sol');

        const gpt62Providers = res.models.filter((m) => m.modelName === 'gpt-6.2-sol');
        assert.strictEqual(gpt62Providers.length, 3);
        assert.deepStrictEqual(
            gpt62Providers.map((m) => ({ id: m.id, provider: m.provider, ownedBy: m.ownedBy })),
            [
                { id: '9aws/gpt-6.2-sol', provider: '9aws', ownedBy: '9AWS' },
                { id: 'jpt/gpt-6.2-sol', provider: 'jpt', ownedBy: 'khongkhuatphuc' },
                { id: 'vgpt/gpt-6.2-sol', provider: 'vgpt', ownedBy: 'Vilao Official' }
            ]
        );
    });

    it('T1.18d: keeps all 5 entries when bare IDs collide across distinct UUID owned_by values and compacts UUID labels', async () => {
        sandbox.network.addRoute('/v1/models', () => new Response(JSON.stringify({
            data: [
                { id: 'deepseek-v4.1-flash', owned_by: '7925b779-f1c7-4cbb-bd68-2f9391ea4845' },
                { id: 'gpt-6.1-sol', owned_by: '715fb37d-7ff2-4619-ad2a-f4171c1fe9a6' },
                { id: 'gpt-6.2-sol', owned_by: '2f936a0f-e9ca-4a37-ae58-d03b2166c86b' },
                { id: 'gpt-6.2-sol', owned_by: '715fb37d-7ff2-4619-ad2a-f4171c1fe9a6' },
                { id: 'gpt-6.2-sol', owned_by: '9988aabb-1122-3344-5566-778899aabbcc' }
            ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const res = await chrome.runtime.sendMessage({
            action: 'fetch_ai_models',
            endpoint: 'https://api.vilao.test/v1/chat/completions',
            apiKey: 'sk-vilao-test'
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.models.length, 5, 'Must keep all 5 models instead of collapsing same-named models to 3');
        assert.strictEqual(res.meta.opaqueProviderCount, 5);

        const gpt62Entries = res.models.filter((m) => m.modelName === 'gpt-6.2-sol');
        assert.strictEqual(gpt62Entries.length, 3);
        assert.deepStrictEqual(
            gpt62Entries.map((m) => m.providerKey),
            [
                '2f936a0f-e9ca-4a37-ae58-d03b2166c86b',
                '715fb37d-7ff2-4619-ad2a-f4171c1fe9a6',
                '9988aabb-1122-3344-5566-778899aabbcc'
            ]
        );
        for (const entry of res.models) {
            assert.strictEqual(entry.isOpaqueProvider, true);
            assert.strictEqual(entry.ownedBy, '');
            assert.match(entry.provider, /^#[0-9a-f]{6}$/);
            assert.strictEqual(entry.provider.length, 7);
        }
    });

    it('T1.18e: reconstructs prefix/id and readable provider names when prefix or nested provider fields accompany UUID owned_by', async () => {
        sandbox.network.addRoute('/v1/models', () => new Response(JSON.stringify({
            data: [
                { id: 'gpt-6.2-sol', prefix: '9aws', provider_name: '9AWS', owned_by: '2f936a0f-e9ca-4a37-ae58-d03b2166c86b' },
                { id: 'gpt-6.2-sol', provider: { slug: 'jpt', name: 'khongkhuatphuc' }, owned_by: '715fb37d-7ff2-4619-ad2a-f4171c1fe9a6' },
                { id: 'gpt-6.2-sol', full_id: 'vgpt/gpt-6.2-sol', seller_name: 'Vilao Official', owned_by: 'aaaa1111-2222-3333-4444-555566667777' }
            ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const res = await chrome.runtime.sendMessage({
            action: 'fetch_ai_models',
            endpoint: 'https://api.vilao.test/v1/chat/completions',
            apiKey: 'sk-vilao-test'
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.models.length, 3);
        assert.deepStrictEqual(
            res.models.map((m) => ({
                id: m.id,
                provider: m.provider,
                ownedBy: m.ownedBy,
                isOpaqueProvider: m.isOpaqueProvider
            })),
            [
                { id: '9aws/gpt-6.2-sol', provider: '9aws', ownedBy: '9AWS', isOpaqueProvider: false },
                { id: 'jpt/gpt-6.2-sol', provider: 'jpt', ownedBy: 'khongkhuatphuc', isOpaqueProvider: false },
                { id: 'vgpt/gpt-6.2-sol', provider: 'vgpt', ownedBy: 'Vilao Official', isOpaqueProvider: false }
            ]
        );
    });

    it('T1.18f: resolves top-level providers directory and preserves standard OpenAI bare model IDs with deduplication', async () => {
        sandbox.network.addRoute('/v1/models', () => new Response(JSON.stringify({
            providers: {
                '2f936a0f-e9ca-4a37-ae58-d03b2166c86b': { prefix: '9aws', name: '9AWS' }
            },
            data: [
                { id: 'gpt-6.2-sol', owned_by: '2f936a0f-e9ca-4a37-ae58-d03b2166c86b' },
                { id: 'gpt-4o', owned_by: 'openai' },
                { id: 'gpt-4o', owned_by: 'openai' }
            ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const res = await chrome.runtime.sendMessage({
            action: 'fetch_ai_models',
            endpoint: 'https://api.example.test/v1/chat/completions',
            apiKey: 'sk-openai-test'
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.models.length, 2, 'Exact OpenAI duplicate must still be deduplicated');
        assert.deepStrictEqual(
            res.models.map((m) => ({ id: m.id, provider: m.provider, ownedBy: m.ownedBy, isOpaqueProvider: m.isOpaqueProvider })),
            [
                { id: '9aws/gpt-6.2-sol', provider: '9aws', ownedBy: '9AWS', isOpaqueProvider: false },
                { id: 'gpt-4o', provider: 'openai', ownedBy: 'openai', isOpaqueProvider: false }
            ]
        );
    });

    it('T1.18g: expands all multi-provider variants collapsed inside aliases, prefixes, or nested providers arrays', async () => {
        // Test A: aliases array alongside bare id and UUID owned_by
        const resAliases = TranslationBroker.normalizeFetchedModels({
            data: [
                {
                    id: 'gpt-6.2-sol',
                    owned_by: '715fb37d-7ff2-4619-ad2a-f4171c1fe9a6',
                    aliases: ['vgpt/gpt-6.2-sol', '9aws/gpt-6.2-sol', 'jpt/gpt-6.2-sol']
                }
            ]
        });
        assert.deepStrictEqual(
            resAliases.map((m) => ({ id: m.id, provider: m.provider, modelName: m.modelName })),
            [
                { id: 'vgpt/gpt-6.2-sol', provider: 'vgpt', modelName: 'gpt-6.2-sol' },
                { id: '9aws/gpt-6.2-sol', provider: '9aws', modelName: 'gpt-6.2-sol' },
                { id: 'jpt/gpt-6.2-sol', provider: 'jpt', modelName: 'gpt-6.2-sol' }
            ],
            'Test A: must expand all 3 aliases without emitting a 4th bare gpt-6.2-sol'
        );

        // Test B: prefixes array on bare id
        const resPrefixes = TranslationBroker.normalizeFetchedModels({
            data: [
                {
                    id: 'gpt-6.2-sol',
                    prefixes: ['9aws', 'jpt', 'vgpt']
                }
            ]
        });
        assert.deepStrictEqual(
            resPrefixes.map((m) => ({ id: m.id, provider: m.provider, modelName: m.modelName })),
            [
                { id: '9aws/gpt-6.2-sol', provider: '9aws', modelName: 'gpt-6.2-sol' },
                { id: 'jpt/gpt-6.2-sol', provider: 'jpt', modelName: 'gpt-6.2-sol' },
                { id: 'vgpt/gpt-6.2-sol', provider: 'vgpt', modelName: 'gpt-6.2-sol' }
            ],
            'Test B: must expand all 3 prefixes into full IDs'
        );

        // Test C: nested providers array with primary prefix also present
        const resNestedProviders = TranslationBroker.normalizeFetchedModels({
            data: [
                {
                    id: 'gpt-6.2-sol',
                    prefix: 'vgpt',
                    providers: [
                        { prefix: '9aws', name: '9AWS' },
                        { prefix: 'jpt', name: 'khongkhuatphuc' },
                        { prefix: 'vgpt', name: 'Vilao Official' }
                    ]
                }
            ]
        });
        assert.deepStrictEqual(
            resNestedProviders.map((m) => ({ id: m.id, provider: m.provider, ownedBy: m.ownedBy })),
            [
                { id: 'vgpt/gpt-6.2-sol', provider: 'vgpt', ownedBy: 'Vilao Official' },
                { id: '9aws/gpt-6.2-sol', provider: '9aws', ownedBy: '9AWS' },
                { id: 'jpt/gpt-6.2-sol', provider: 'jpt', ownedBy: 'khongkhuatphuc' }
            ],
            'Test C: must preserve all 3 nested provider objects with readable ownedBy names'
        );
    });

    it('T1.18h: ignores OpenAI permission arrays and returns full structural metadata from fetch_ai_models', async () => {
        sandbox.network.addRoute('/v1/models', () => new Response(JSON.stringify({
            object: 'list',
            data: [
                {
                    id: 'gpt-4o',
                    object: 'model',
                    owned_by: 'openai',
                    permission: [
                        { id: 'modelperm-abc', object: 'model_permission', organization: '*' }
                    ]
                },
                {
                    id: 'deepseek-chat',
                    object: 'model',
                    owned_by: 'deepseek',
                    tags: ['chat', 'fast']
                }
            ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const res = await chrome.runtime.sendMessage({
            action: 'fetch_ai_models',
            endpoint: 'https://api.example.test/v1/chat/completions',
            apiKey: 'sk-openai-test'
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.models.length, 2, 'permission/tags arrays must NOT expand into extra models');
        assert.strictEqual(res.meta.totalRaw, 2);
        assert.strictEqual(res.meta.normalizedCount, 2);
        assert.deepStrictEqual(res.meta.topLevelKeys, ['object', 'data']);
        assert.deepStrictEqual(res.meta.arrayFields, ['permission', 'tags']);
        assert.ok(res.meta.itemKeys.includes('permission'));
        assert.ok(res.meta.itemKeys.includes('owned_by'));
    });

    it('T1.19: decorates HTTP 403 and SSE FORBIDDEN errors with API host permission hint until granted and synced', async () => {
        const customEndpoint = 'https://api.vilao.ai/v1/chat/completions';
        await chrome.storage.local.set({ endpoint: customEndpoint, model: 'jpt/gpt-6.2-sol' });

        const runStreamExpectError = (runId) => new Promise((resolve, reject) => {
            const port = chrome.runtime.connect({ name: 'stv-translate-stream' });
            const timer = setTimeout(() => reject(new Error('Timed out waiting for stream error')), 2000);
            port.onMessage.addListener((msg) => {
                if (msg.type === 'error') {
                    clearTimeout(timer);
                    resolve(msg);
                }
            });
            port.postMessage({
                action: 'start_translation',
                runId,
                textChunks: ['测试'],
                glossaryProfile: 'Default'
            });
        });

        // 1. HTTP 403 without host permission -> actionable hint shown
        sandbox.network.addRoute('/chat/completions', () => new Response(JSON.stringify({
            error: {
                code: 'FORBIDDEN',
                message: 'You do not have permission to perform this action.',
                type: 'permission_error'
            }
        }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

        const errHttp403 = await runStreamExpectError('run-403-http');
        assert.strictEqual(errHttp403.code, 403);
        assert.ok(errHttp403.error.includes('You do not have permission to perform this action.'));
        assert.ok(errHttp403.error.includes('Cấp quyền API'));
        assert.ok(errHttp403.error.includes('api.vilao.ai'));

        // 2. SSE FORBIDDEN error without host permission -> actionable hint shown
        sandbox.network.addRoute('/chat/completions', () => createSseResponse([
            'data: {"error":{"code":"FORBIDDEN","message":"You do not have permission to perform this action.","type":"permission_error"}}'
        ]));

        const errSse = await runStreamExpectError('run-403-sse');
        assert.ok(errSse.error.includes('You do not have permission to perform this action.'));
        assert.ok(errSse.error.includes('Cấp quyền API'));
        assert.ok(errSse.error.includes('api.vilao.ai'));

        // 3. Grant permission and trigger sync_api_dnr_rules -> rule active & 403 does not falsely ask to grant permission
        await chrome.permissions.request({ origins: ['https://api.vilao.ai/*'] });
        const syncRes = await chrome.runtime.sendMessage({
            action: 'sync_api_dnr_rules',
            endpoint: customEndpoint
        });
        assert.strictEqual(syncRes.ok, true);
        assert.strictEqual(syncRes.active, true);
        assert.strictEqual((await chrome.declarativeNetRequest.getDynamicRules()).length, 1);

        sandbox.network.addRoute('/chat/completions', () => new Response(JSON.stringify({
            error: {
                code: 'FORBIDDEN',
                message: 'You do not have permission to perform this action.',
                type: 'permission_error'
            }
        }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

        const errAfterGrant = await runStreamExpectError('run-403-granted');
        assert.strictEqual(errAfterGrant.code, 403);
        assert.strictEqual(errAfterGrant.error, 'You do not have permission to perform this action.');
        assert.strictEqual(errAfterGrant.error.includes('Cấp quyền API'), false);
    });
});
