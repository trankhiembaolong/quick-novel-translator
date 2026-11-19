// background.js - Service Worker xử lý dịch ngầm từ phím tắt & Proxy/Controller cho VieNeu-TTS

importScripts('glossary-utils.js', 'url-validator.js', 'tts-icon-describer.js');

const VIENEU_NATIVE_HOST = 'com.stv.vieneu_host';
const DEFAULT_VIENEU_URL = 'http://127.0.0.1:8000';
const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'stepfun/step-3.5-flash';
const DEFAULT_PROMPT = 'Dịch toàn bộ nội dung sau sang tiếng Việt chuẩn, mượt mà, tự nhiên theo văn phong tiểu thuyết. Giữ nguyên định dạng xuống dòng.';
const TTS_ICON_CACHE_KEY = 'stv_tts_icon_cache';
const TTS_CUSTOM_ICONS_KEY = 'stv_tts_custom_icons';
const TTS_ICON_CACHE_MAX = 500;

function mergeTtsIconCache(existingCache, updates, lang = 'vi') {
    const describer = globalThis.STV_IconDescriber || null;
    const normKeyFn = describer?.normalizeCacheKey || ((s) => String(s || '').trim().replace(/\s+/g, ' '));
    const stripFn = describer?.stripResidualIcons || ((s) => String(s || '').trim());
    const safeLang = lang === 'en' ? 'en' : 'vi';
    const nextCache = (existingCache && typeof existingCache === 'object' && !Array.isArray(existingCache))
        ? { ...existingCache }
        : {};
    const flatUpdates = {};
    let changed = false;
    const now = Date.now();

    for (const [rawKey, rawGloss] of Object.entries(updates || {})) {
        const key = normKeyFn(rawKey);
        const gloss = stripFn(String(rawGloss || '')).trim();
        if (!key || !gloss || gloss.length > 60) continue;
        const prev = (nextCache[key] && typeof nextCache[key] === 'object') ? nextCache[key] : {};
        if (prev[safeLang] !== gloss) {
            changed = true;
        }
        nextCache[key] = { ...prev, [safeLang]: gloss, ts: now };
        flatUpdates[key] = { ...nextCache[key] };
    }

    const keys = Object.keys(nextCache);
    if (keys.length > TTS_ICON_CACHE_MAX) {
        keys.sort((a, b) => (Number(nextCache[a]?.ts) || 0) - (Number(nextCache[b]?.ts) || 0));
        const removeCount = keys.length - TTS_ICON_CACHE_MAX;
        for (let i = 0; i < removeCount; i++) {
            delete nextCache[keys[i]];
        }
        changed = true;
    }

    return { merged: nextCache, changed, flatUpdates };
}

function flattenIconCacheForRuntime(rawCache) {
    if (!rawCache || typeof rawCache !== 'object' || Array.isArray(rawCache)) return {};
    const out = {};
    for (const [k, entry] of Object.entries(rawCache)) {
        if (!k || !entry) continue;
        if (typeof entry === 'string') {
            out[k] = { vi: entry };
        } else if (typeof entry === 'object') {
            const compact = {};
            if (typeof entry.vi === 'string' && entry.vi.trim()) compact.vi = entry.vi.trim();
            if (typeof entry.en === 'string' && entry.en.trim()) compact.en = entry.en.trim();
            if (compact.vi || compact.en) out[k] = compact;
        }
    }
    return out;
}

// Enforce secret isolation: Content scripts cannot read chrome.storage.local
async function initSecretIsolation() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && typeof chrome.storage.local.setAccessLevel === 'function') {
        try {
            await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
            console.log('[STV Background] chrome.storage.local accessLevel set to TRUSTED_CONTEXTS');
        } catch (err) {
            console.warn('[STV Background] Failed to setAccessLevel on storage.local:', err);
        }
    }
}

// Run immediately upon worker startup
initSecretIsolation();

// Ensure access level and default configuration on install/update
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(async () => {
        await initSecretIsolation();
        const stored = await chrome.storage.local.get(['endpoint', 'model', 'prompt', 'stv_active_glossary_profile']);
        const defaults = {};
        if (!stored?.endpoint) defaults.endpoint = DEFAULT_ENDPOINT;
        if (!stored?.model) defaults.model = DEFAULT_MODEL;
        if (!stored?.prompt) defaults.prompt = DEFAULT_PROMPT;
        if (!stored?.stv_active_glossary_profile) defaults.stv_active_glossary_profile = 'Default';
        if (Object.keys(defaults).length > 0) {
            await chrome.storage.local.set(defaults);
        }
    });
}

// Quản lý preload chương tiếp theo & tự động chuyển chương
const preloadedChapters = new Map(); // preloadId -> entry
const pendingAutoAdvance = new Map(); // tabId -> { targetUrl, mode, preloadId, startedAt }

async function setPendingAutoAdvance(tabId, data) {
    pendingAutoAdvance.set(tabId, data);
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
            await chrome.storage.session.set({ [`stv_pending_auto_advance_${tabId}`]: data });
        }
    } catch {}
}

async function getAndDeletePendingAutoAdvance(tabId) {
    let pending = pendingAutoAdvance.get(tabId) || null;
    pendingAutoAdvance.delete(tabId);
    const key = `stv_pending_auto_advance_${tabId}`;
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
            if (!pending) {
                const res = await chrome.storage.session.get(key);
                pending = res ? res[key] || null : null;
            }
            if (pending) {
                await chrome.storage.session.remove(key);
            }
        }
    } catch {}
    return pending;
}

async function deletePendingAutoAdvance(tabId) {
    pendingAutoAdvance.delete(tabId);
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
            await chrome.storage.session.remove(`stv_pending_auto_advance_${tabId}`);
        }
    } catch {}
}

const PRELOAD_SESSION_PREFIX = 'stv_preload_';
const PRELOAD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function serializePreloadEntry(entry) {
    if (!entry) return null;
    return {
        preloadId: entry.preloadId,
        tabId: entry.tabId,
        targetUrl: entry.targetUrl,
        mode: entry.mode,
        status: entry.status,
        origChunks: Array.isArray(entry.origChunks) ? entry.origChunks : null,
        nextNextUrl: entry.nextNextUrl || null,
        pureTextForAPI: entry.pureTextForAPI || '',
        finalSystemPrompt: entry.finalSystemPrompt || '',
        sentGlossary: entry.sentGlossary || {},
        activeProfile: entry.activeProfile || 'Default',
        model: entry.model || '',
        fullText: entry.fullText || '',
        glossarySaved: Boolean(entry.glossarySaved),
        glossaryDebug: entry.glossaryDebug || null,
        error: entry.error || '',
        consumedByPage: Boolean(entry.consumedByPage),
        createdAt: entry.createdAt || Date.now()
    };
}

function hydratePreloadEntry(data) {
    if (!data || !data.preloadId) return null;
    return {
        ...data,
        abortController: new AbortController(),
        subscribers: new Set()
    };
}

function isSessionPreloadValid(raw, now = Date.now()) {
    return Boolean(
        raw &&
        raw.preloadId &&
        raw.status === 'ready' &&
        !raw.consumedByPage &&
        (now - (raw.createdAt || 0) <= PRELOAD_MAX_AGE_MS)
    );
}

async function savePreloadEntryToSession(entry) {
    if (!entry || !entry.preloadId || entry.status !== 'ready' || entry.consumedByPage) return;
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
            await chrome.storage.session.set({
                [`${PRELOAD_SESSION_PREFIX}${entry.preloadId}`]: serializePreloadEntry(entry)
            });
        }
    } catch {}
}

async function removePreloadEntryFromSession(preloadId) {
    if (!preloadId) return;
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
            await chrome.storage.session.remove(`${PRELOAD_SESSION_PREFIX}${preloadId}`);
        }
    } catch {}
}

async function getOrRestorePreloadEntry(preloadId) {
    if (!preloadId) return null;
    const existing = preloadedChapters.get(preloadId);
    if (existing) return existing;
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
            const key = `${PRELOAD_SESSION_PREFIX}${preloadId}`;
            const res = await chrome.storage.session.get(key);
            const raw = res ? res[key] : null;
            if (!isSessionPreloadValid(raw)) {
                if (raw) await chrome.storage.session.remove(key);
                return null;
            }
            const hydrated = hydratePreloadEntry(raw);
            if (hydrated) {
                preloadedChapters.set(preloadId, hydrated);
                return hydrated;
            }
        }
    } catch {}
    return null;
}

async function restoreAllPreloadsFromSession() {
    try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return;
        const all = await chrome.storage.session.get(null);
        if (!all || typeof all !== 'object') return;
        const staleKeys = [];
        const now = Date.now();
        for (const [k, raw] of Object.entries(all)) {
            if (!k.startsWith(PRELOAD_SESSION_PREFIX)) continue;
            if (!isSessionPreloadValid(raw, now)) {
                staleKeys.push(k);
                continue;
            }
            if (!preloadedChapters.has(raw.preloadId)) {
                const hydrated = hydratePreloadEntry(raw);
                if (hydrated) {
                    preloadedChapters.set(raw.preloadId, hydrated);
                }
            }
        }
        if (staleKeys.length > 0) {
            await chrome.storage.session.remove(staleKeys);
        }
    } catch {}
}

restoreAllPreloadsFromSession();

function makePreloadId(tabId, url) {
    return `${tabId}|${url}`;
}

function broadcastPreloadEvent(entry, msg) {
    if (!entry || !entry.subscribers) return;
    for (const port of Array.from(entry.subscribers)) {
        try {
            port.postMessage(msg);
        } catch {
            entry.subscribers.delete(port);
        }
    }
}

function cleanupTabPreloads(tabId, keepPreloadId = null, options = {}) {
    const { targetUrlFilter = null, forceAll = false } = options || {};
    for (const [id, entry] of Array.from(preloadedChapters.entries())) {
        if (entry.tabId !== tabId || id === keepPreloadId) continue;
        // Giữ lại preload đã bàn giao cho trang hiện tại để tránh tự ngắt giữa chừng
        if (!forceAll && entry.consumedByPage) continue;
        if (targetUrlFilter && entry.targetUrl !== targetUrlFilter) continue;
        if (entry.abortController && !entry.abortController.signal.aborted) {
            try { entry.abortController.abort(); } catch {}
        }
        entry.status = 'aborted';
        preloadedChapters.delete(id);
        removePreloadEntryFromSession(id);
    }
    if (targetUrlFilter) {
        const targetId = makePreloadId(tabId, targetUrlFilter);
        if (targetId !== keepPreloadId && !preloadedChapters.has(targetId)) {
            removePreloadEntryFromSession(targetId);
        }
    }
}

function decodeHtmlBuffer(buffer, contentType = '') {
    const bytes = new Uint8Array(buffer);
    let charset = '';
    const ctMatch = String(contentType || '').match(/charset=([^;\s"']+)/i);
    if (ctMatch) {
        charset = ctMatch[1].trim().toLowerCase();
    } else {
        let headStr = '';
        const limit = Math.min(bytes.length, 2048);
        for (let i = 0; i < limit; i++) headStr += String.fromCharCode(bytes[i]);
        const metaMatch = headStr.match(/<meta[^>]+charset=["']?\s*([a-zA-Z0-9_-]+)/i);
        if (metaMatch) charset = metaMatch[1].trim().toLowerCase();
    }
    if (charset === 'gbk' || charset === 'gb2312') charset = 'gb18030';
    try {
        return new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch {
        return new TextDecoder('utf-8').decode(bytes);
    }
}

async function saveGlossaryTermsFromBackground(fullText, activeProfile) {
    if (!globalThis.STV_GlossaryUtils || typeof globalThis.STV_GlossaryUtils.saveGlossaryFromFullText !== 'function') {
        return { activeProfile: activeProfile || 'Default', newTerms: {}, skippedTerms: [], updated: false, existingGlossary: null };
    }
    const res = await globalThis.STV_GlossaryUtils.saveGlossaryFromFullText(fullText, activeProfile);
    if (res.skippedTerms.length > 0) {
        console.log(`[STV Background] Đã lọc bỏ ${res.skippedTerms.length} mục glossary rác/không hợp lệ:`, res.skippedTerms);
    }
    if (res.updated) {
        console.log(`[STV Background] Đã cập nhật glossary tự động cho bộ từ điển "${res.activeProfile}":`, res.existingGlossary);
    }
    return res;
}

async function extractChunksFromPreloadedHtml(tabId, html, targetUrl, savedSelector) {
    const runOnce = () => chrome.scripting.executeScript({
        target: { tabId },
        func: (htmlStr, pageUrl, sel) => {
            if (typeof window.STV_extractFromHtml !== 'function') {
                return { missingExtractor: true };
            }
            return window.STV_extractFromHtml(htmlStr, pageUrl, sel);
        },
        args: [html, targetUrl, savedSelector]
    });

    let res = await runOnce();
    let payload = res && res[0] ? res[0].result : null;
    if (payload && payload.missingExtractor) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['extractor.js'] });
        res = await runOnce();
        payload = res && res[0] ? res[0].result : null;
    }
    return payload;
}

async function extractChunksViaHiddenIframe(tabId, targetUrl, savedSelector) {
    const runOnce = () => chrome.scripting.executeScript({
        target: { tabId },
        func: async (pageUrl, sel) => {
            if (typeof window.STV_extractFromUrlViaIframe !== 'function') {
                return { missingExtractor: true };
            }
            return await window.STV_extractFromUrlViaIframe(pageUrl, sel, 10000);
        },
        args: [targetUrl, savedSelector]
    });

    let res = await runOnce();
    let payload = res && res[0] ? res[0].result : null;
    if (payload && payload.missingExtractor) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['extractor.js'] });
        res = await runOnce();
        payload = res && res[0] ? res[0].result : null;
    }
    return payload;
}

function startPreloadWorker(tabId, targetUrl, mode = 'translate') {
    const normalizedMode = mode === 'translate' ? 'translate' : 'tts_only';
    const preloadId = makePreloadId(tabId, targetUrl);
    const existing = preloadedChapters.get(preloadId);
    if (existing && existing.mode === normalizedMode && (existing.status === 'fetching' || existing.status === 'translating' || existing.status === 'ready')) {
        return { ok: true, preloadId, status: existing.status, reused: true };
    }

    cleanupTabPreloads(tabId, preloadId);

    const entry = {
        preloadId,
        tabId,
        targetUrl,
        mode: normalizedMode,
        status: 'fetching',
        origChunks: null,
        nextNextUrl: null,
        pureTextForAPI: '',
        finalSystemPrompt: '',
        fullText: '',
        glossarySaved: false,
        glossaryDebug: null,
        error: '',
        consumedByPage: false,
        abortController: new AbortController(),
        subscribers: new Set(),
        createdAt: Date.now()
    };
    preloadedChapters.set(preloadId, entry);

    (async () => {
        try {
            const htmlRes = await fetch(targetUrl, {
                method: 'GET',
                credentials: 'include',
                signal: entry.abortController.signal
            });
            if (htmlRes.url && htmlRes.url !== targetUrl) {
                const validator = globalThis.STV_UrlValidator || globalThis;
                if (typeof validator.isSafePreloadTarget === 'function') {
                    const redirectCheck = validator.isSafePreloadTarget(targetUrl, htmlRes.url);
                    if (!redirectCheck.allowed) {
                        throw new Error(`Redirect bị từ chối bởi SSRF policy: ${redirectCheck.reason}`);
                    }
                }
            }
            if (!htmlRes.ok) {
                throw new Error(`Không tải được trang sau (HTTP ${htmlRes.status})`);
            }
            const buf = await htmlRes.arrayBuffer();
            const html = decodeHtmlBuffer(buf, htmlRes.headers.get('content-type') || '');

            let selectorKey = '';
            try {
                selectorKey = `stv_selector_${new URL(targetUrl).hostname}`;
            } catch {}
            const selData = selectorKey ? await chrome.storage.local.get([selectorKey]) : {};
            const savedSelector = selectorKey ? (selData[selectorKey] || '') : '';

            let extracted = await extractChunksFromPreloadedHtml(tabId, html, targetUrl, savedSelector);
            if (entry.abortController.signal.aborted) return;

            // Nếu là trang tải nội dung hoặc link "Chương sau" (/0/, #) bằng AJAX/JS (như STV), thử nạp qua iframe ẩn cùng origin
            if (!extracted || !extracted.ok || !Array.isArray(extracted.chunks) || extracted.chunks.length === 0) {
                extracted = await extractChunksViaHiddenIframe(tabId, targetUrl, savedSelector);
                if (entry.abortController.signal.aborted) return;
            } else if (!extracted.nextUrl && extracted.pendingNextUrl) {
                try {
                    const iframeExtracted = await extractChunksViaHiddenIframe(tabId, targetUrl, savedSelector);
                    if (entry.abortController.signal.aborted) return;
                    if (iframeExtracted && iframeExtracted.ok && Array.isArray(iframeExtracted.chunks) && iframeExtracted.chunks.length > 0) {
                        extracted = iframeExtracted;
                    }
                } catch (iframeErr) {
                    console.warn('[STV Background] Hidden iframe fallback cho nextUrl thất bại, giữ kết quả HTML:', iframeErr);
                }
            }

            if (!extracted || !extracted.ok || !Array.isArray(extracted.chunks) || extracted.chunks.length === 0) {
                throw new Error(extracted?.error || extracted?.reason || 'Không trích xuất được nội dung chương tiếp theo');
            }

            entry.origChunks = extracted.chunks;
            entry.nextNextUrl = extracted.nextUrl || null;

            if (normalizedMode === 'tts_only') {
                if (entry.abortController.signal.aborted) return;
                entry.status = 'ready';
                await savePreloadEntryToSession(entry);
                broadcastPreloadEvent(entry, {
                    type: 'delta',
                    fullText: '',
                    origChunks: entry.origChunks,
                    nextUrl: entry.nextNextUrl,
                    done: true,
                    glossarySaved: false
                });
                return;
            }

            const config = await chrome.storage.local.get([
                'endpoint', 'apikey', 'model', 'prompt', 'stv_active_glossary_profile', 'stvDebugLog'
            ]);
            const apikey = (config.apikey || '').trim();
            if (!apikey) {
                throw new Error('Không có API Key để dịch trước chương sau');
            }
            const endpoint = config.endpoint || DEFAULT_ENDPOINT;
            const validator = globalThis.STV_UrlValidator || globalThis;
            if (typeof validator.isValidUrl === 'function' && !validator.isValidUrl(endpoint)) {
                throw new Error('API Endpoint URL không hợp lệ');
            }
            const model = config.model || DEFAULT_MODEL;
            const activeProfile = config.stv_active_glossary_profile || 'Default';
            const glossaryKey = `stv_glossary_profile_${activeProfile}`;
            const glossaryData = await chrome.storage.local.get([glossaryKey]);
            const glossary = glossaryData[glossaryKey] || {};

            const pureTextForAPI = extracted.chunks.join('\n');
            const sentGlossary = (globalThis.STV_GlossaryUtils && typeof globalThis.STV_GlossaryUtils.findMatchingGlossaryTerms === 'function')
                ? globalThis.STV_GlossaryUtils.findMatchingGlossaryTerms(pureTextForAPI, glossary)
                : {};
            const { finalSystemPrompt, userMessage } = globalThis.STV_GlossaryUtils.buildTranslationPromptPayload(
                pureTextForAPI,
                config.prompt,
                glossary
            );

            entry.pureTextForAPI = pureTextForAPI;
            entry.finalSystemPrompt = finalSystemPrompt;
            entry.sentGlossary = sentGlossary;
            entry.model = model;
            entry.activeProfile = activeProfile;
            entry.status = 'translating';

            if (config.stvDebugLog) {
                console.log("=== [Preload] NỘI DUNG GỬI CHO AI ===\n\n" + pureTextForAPI);
                console.log("=== [Preload] SYSTEM PROMPT ===\n\n" + finalSystemPrompt);
            }

            const aiRes = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apikey}`
                },
                body: JSON.stringify({
                    model,
                    temperature: 0.5,
                    stream: true,
                    messages: [
                        { role: 'system', content: finalSystemPrompt },
                        { role: 'user', content: userMessage }
                    ]
                }),
                signal: entry.abortController.signal
            });

            if (!aiRes.ok) {
                if (aiRes.status === 402) {
                    throw new Error("API OpenRouter báo lỗi 402 Limit (Hết tiền hoặc hết credit).");
                }
                throw new Error(`Phiên dịch thất bại do HTTP Status: ${aiRes.status}`);
            }

            const reader = aiRes.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let sseBuffer = '';

            const handleSseLine = (rawLine) => {
                const trimmed = rawLine.trim();
                if (!trimmed || !trimmed.startsWith('data:')) return false;
                const dataStr = (trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5)).trim();
                if (dataStr === '[DONE]') return false;

                let parsed;
                try {
                    parsed = JSON.parse(dataStr);
                } catch {
                    console.warn('[STV Background] Bỏ qua dòng SSE JSON lỗi:', JSON.stringify(rawLine));
                    return false;
                }

                if (parsed && parsed.error) {
                    throw new Error(parsed.error.message || 'Lỗi nội bộ từ API');
                }

                const delta = parsed?.choices?.[0]?.delta?.content;
                if (delta != null && delta !== '') {
                    entry.fullText += delta;
                    return true;
                }
                return false;
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    if (sseBuffer.trim()) {
                        for (const line of sseBuffer.split('\n')) {
                            handleSseLine(line);
                        }
                    }
                    break;
                }
                sseBuffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
                const lastNewlineIndex = sseBuffer.lastIndexOf('\n');
                if (lastNewlineIndex === -1) continue;

                const completePart = sseBuffer.substring(0, lastNewlineIndex);
                sseBuffer = sseBuffer.substring(lastNewlineIndex + 1);

                let deltaChunk = '';
                for (const line of completePart.split('\n')) {
                    const prevLen = entry.fullText.length;
                    if (handleSseLine(line)) {
                        deltaChunk += entry.fullText.slice(prevLen);
                    }
                }
                if (deltaChunk) {
                    broadcastPreloadEvent(entry, {
                        type: 'delta',
                        delta: deltaChunk,
                        done: false,
                        glossarySaved: false
                    });
                }
            }

            if (entry.abortController.signal.aborted) return;

            if (config.stvDebugLog) {
                console.log("=== [Preload] KẾT QUẢ AI TRẢ VỀ ===\n\n", entry.fullText);
            }

            try {
                const glossaryRes = await saveGlossaryTermsFromBackground(entry.fullText, activeProfile);
                const aiReturned = (globalThis.STV_GlossaryUtils && typeof globalThis.STV_GlossaryUtils.extractGlossaryTermsFromFullText === 'function')
                    ? globalThis.STV_GlossaryUtils.extractGlossaryTermsFromFullText(entry.fullText)
                    : {};
                entry.glossarySaved = true;
                entry.glossaryDebug = {
                    activeProfile: glossaryRes.activeProfile,
                    model: entry.model || '',
                    sentGlossary: entry.sentGlossary || {},
                    aiReturned,
                    skippedTerms: glossaryRes.skippedTerms,
                    updated: glossaryRes.updated,
                    totalInProfile: Object.keys(glossaryRes.existingGlossary || {}).length,
                    existingGlossary: glossaryRes.existingGlossary
                };
            } catch (e) {
                console.warn('[STV Background] Lỗi lưu glossary preload:', e);
            }

            if (entry.abortController.signal.aborted) return;
            entry.status = 'ready';
            await savePreloadEntryToSession(entry);
            broadcastPreloadEvent(entry, {
                type: 'delta',
                fullText: entry.fullText,
                origChunks: entry.origChunks,
                nextUrl: entry.nextNextUrl,
                done: true,
                glossarySaved: entry.glossarySaved,
                glossaryDebug: entry.glossaryDebug || null
            });
            if (entry.consumedByPage) {
                preloadedChapters.delete(entry.preloadId);
                await removePreloadEntryFromSession(entry.preloadId);
            }
        } catch (err) {
            if (entry.abortController.signal.aborted) {
                entry.status = 'aborted';
                return;
            }
            entry.status = 'error';
            entry.error = err?.message || String(err);
            broadcastPreloadEvent(entry, { type: 'error', error: entry.error });
        }
    })();

    return { ok: true, preloadId, status: entry.status };
}

function normalizeServerUrl(url) {
    const clean = (url || DEFAULT_VIENEU_URL).trim().replace(/\/+$/, '');
    return clean || DEFAULT_VIENEU_URL;
}

function parsePortFromUrl(url) {
    try {
        const parsed = new URL(normalizeServerUrl(url));
        return parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    } catch {
        return 8000;
    }
}

function buildAuthHeaders(apiKey, extra = {}) {
    const headers = { ...extra };
    if (apiKey && apiKey.trim()) {
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }
    return headers;
}

function deriveModelsEndpointUrl(chatEndpoint) {
    try {
        const parsed = new URL(String(chatEndpoint || '').trim());
        const pathname = parsed.pathname.replace(/\/+$/, '');
        if (/\/models$/i.test(pathname)) {
            parsed.pathname = pathname;
        } else if (/\/(chat\/completions|completions|responses)$/i.test(pathname)) {
            parsed.pathname = pathname.replace(/\/(chat\/completions|completions|responses)$/i, '/models');
        } else if (!pathname || pathname === '/') {
            parsed.pathname = '/v1/models';
        } else {
            parsed.pathname = `${pathname}/models`;
        }
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return '';
    }
}

function isModelLikeEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return (typeof entry.model === 'string' && entry.model.trim().length > 0)
        || (typeof entry.model_id === 'string' && entry.model_id.trim().length > 0)
        || (typeof entry.model_name === 'string' && entry.model_name.trim().length > 0)
        || (typeof entry.full_id === 'string' && entry.full_id.trim().length > 0)
        || (typeof entry.id === 'string' && entry.id.trim().length > 0 && !isOpaqueIdentifier(entry.id));
}

function extractRawModelList(payload) {
    const primary = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.data)
            ? payload.data
            : (Array.isArray(payload?.models)
                ? payload.models
                : (Array.isArray(payload?.items)
                    ? payload.items
                    : (Array.isArray(payload?.subscriptions) ? payload.subscriptions : []))));

    if (payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray(payload.data)) {
        const extras = [];
        if (Array.isArray(payload.subscriptions)) {
            for (const sub of payload.subscriptions) {
                if (isModelLikeEntry(sub)) extras.push(sub);
            }
        }
        if (Array.isArray(payload.aliases)) {
            for (const aliasEntry of payload.aliases) {
                if (typeof aliasEntry === 'string') {
                    const trimmed = aliasEntry.trim();
                    const sIdx = trimmed.indexOf('/');
                    if (sIdx > 0 && sIdx < trimmed.length - 1 && isValidRoutingPrefix(trimmed.slice(0, sIdx))) {
                        extras.push(trimmed);
                    }
                } else if (isModelLikeEntry(aliasEntry)) {
                    extras.push(aliasEntry);
                }
            }
        }
        if (extras.length > 0) {
            return [...primary, ...extras];
        }
    }

    return primary;
}

function isOpaqueIdentifier(value) {
    if (typeof value !== 'string') return true;
    const s = value.trim();
    if (!s) return true;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
        || /^[0-9a-f]{24}$|^[0-9a-f]{32}$/i.test(s)
        || /^\d{12,}$/.test(s);
}

function formatShortOpaqueId(rawId) {
    const cleaned = String(rawId || '').replace(/[^a-z0-9]/gi, '');
    return cleaned ? `#${cleaned.slice(0, 6).toLowerCase()}` : '#unknown';
}

function pickFirstString(candidates, { rejectOpaque = false, maxLen = 80 } = {}) {
    for (const cand of candidates) {
        if (typeof cand !== 'string') continue;
        const s = cand.trim();
        if (!s || s.length > maxLen) continue;
        if (/^https?:\/\//i.test(s)) continue;
        if (rejectOpaque && isOpaqueIdentifier(s)) continue;
        return s;
    }
    return '';
}

function isValidRoutingPrefix(val) {
    if (typeof val !== 'string') return false;
    const s = val.trim();
    if (s.length < 1 || s.length > 40) return false;
    if (/\s/.test(s) || s.includes('/')) return false;
    if (isOpaqueIdentifier(s)) return false;
    if (/^(model|list|object|default)$/i.test(s)) return false;
    return true;
}

function scanMatchingObjectValues(obj, keyPattern) {
    const found = [];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return found;
    for (const [key, val] of Object.entries(obj)) {
        if (typeof val === 'string' && keyPattern.test(key) && !/(^|_)(id|uuid)$/i.test(key)) {
            found.push(val);
        }
    }
    return found;
}

function buildProviderDirectory(payload) {
    const directory = new Map();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return directory;
    }
    const sources = [payload.providers, payload.owners, payload.sellers, payload.channels];
    const registerEntry = (rawKey, entry) => {
        const key = typeof rawKey === 'string' ? rawKey.trim() : '';
        if (!key) return;
        let prefix = '';
        let name = '';
        if (typeof entry === 'string') {
            name = pickFirstString([entry], { rejectOpaque: true });
        } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const prefixCands = [
                entry.prefix, entry.provider_prefix, entry.providerPrefix,
                entry.slug, entry.code, entry.handle, entry.short_name, entry.shortName
            ];
            for (const cand of prefixCands) {
                if (isValidRoutingPrefix(cand)) {
                    prefix = cand.trim();
                    break;
                }
            }
            name = pickFirstString([
                entry.display_name, entry.displayName, entry.name,
                entry.username, entry.title, entry.label
            ], { rejectOpaque: true });
        }
        if (prefix || name) {
            const normalized = { prefix, name };
            directory.set(key, normalized);
            directory.set(key.toLowerCase(), normalized);
        }
    };

    for (const source of sources) {
        if (!source) continue;
        if (Array.isArray(source)) {
            for (const entry of source) {
                if (!entry || typeof entry !== 'object') continue;
                const entryKey = pickFirstString([
                    entry.id, entry.uuid, entry.provider_id, entry.providerId, entry.owner_id, entry.ownerId
                ], { rejectOpaque: false, maxLen: 128 });
                registerEntry(entryKey, entry);
            }
        } else if (typeof source === 'object') {
            for (const [key, entry] of Object.entries(source)) {
                registerEntry(key, entry);
            }
        }
    }
    return directory;
}

const NON_VARIANT_ARRAY_KEYS = new Set([
    'permission', 'permissions', 'capabilities', 'modalities',
    'input_modalities', 'output_modalities', 'supported_parameters',
    'tags', 'features', 'pricing', 'limits'
]);
const EXPLICIT_PREFIX_ARRAY_KEYS = new Set([
    'prefixes', 'provider_prefixes', 'providerPrefixes',
    'model_prefixes', 'modelPrefixes', 'route_prefixes', 'routePrefixes',
    'routing_prefixes', 'routingPrefixes', 'provider_slugs', 'providerSlugs',
    'namespaces'
]);
const NAMED_VARIANT_ARRAY_KEYS = new Set([
    'providers', 'sellers', 'owners', 'routes', 'variants', 'channels',
    'endpoints', 'offers', 'listings', 'subscriptions', 'pools',
    'upstreams', 'backends', 'instances', 'sub_models', 'subModels',
    'aliases', 'model_aliases', 'modelAliases', 'entries', 'models'
]);
const EXPLICIT_VARIANT_OBJECT_KEYS = [
    'prefix', 'provider_prefix', 'providerPrefix', 'slug',
    'provider_slug', 'providerSlug', 'full_id', 'fullId', 'route',
    'api_model', 'provider_name', 'providerName', 'seller_name', 'sellerName'
];
const EXPLICIT_VARIANT_SLASH_KEYS = new Set(['full_id', 'fullId', 'route', 'api_model']);

function collectItemVariants(item, baseModelName, displayName, providerDirectory) {
    const variants = [];
    const containers = [item, item?.meta, item?.metadata];

    for (const container of containers) {
        if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
        for (const [key, val] of Object.entries(container)) {
            if (!Array.isArray(val) || val.length === 0) continue;
            if (NON_VARIANT_ARRAY_KEYS.has(key.toLowerCase())) continue;

            const isExplicitPrefixArray = EXPLICIT_PREFIX_ARRAY_KEYS.has(key);
            const isNamedVariantArray = NAMED_VARIANT_ARRAY_KEYS.has(key);

            for (const el of val) {
                if (typeof el === 'string') {
                    const s = el.trim();
                    if (!s) continue;
                    const sIdx = s.indexOf('/');
                    if (sIdx > 0 && sIdx < s.length - 1) {
                        const left = s.slice(0, sIdx).trim();
                        const right = s.slice(sIdx + 1).trim();
                        if (isValidRoutingPrefix(left) && right.toLowerCase() === baseModelName.toLowerCase()) {
                            variants.push({
                                id: `${left}/${right}`,
                                prefix: left,
                                modelName: right,
                                ownedBy: '',
                                providerId: '',
                                isOpaqueProvider: false,
                                displayName
                            });
                        }
                    } else if (isExplicitPrefixArray && isValidRoutingPrefix(s)) {
                        variants.push({
                            id: `${s}/${baseModelName}`,
                            prefix: s,
                            modelName: baseModelName,
                            ownedBy: '',
                            providerId: '',
                            isOpaqueProvider: false,
                            displayName
                        });
                    }
                    continue;
                }

                if (!el || typeof el !== 'object' || Array.isArray(el)) continue;
                if (el.object === 'model_permission') continue;

                const hasVariantKey = EXPLICIT_VARIANT_OBJECT_KEYS.some((k) => (
                    typeof el[k] === 'string' ? el[k].trim().length > 0 : (el[k] !== undefined && el[k] !== null)
                ));
                if (!isNamedVariantArray && !hasVariantKey) continue;

                let vPrefix = '';
                const slashFields = [
                    ['full_id', el.full_id],
                    ['fullId', el.fullId],
                    ['qualified_id', el.qualified_id],
                    ['api_model', el.api_model],
                    ['route', el.route],
                    ['alias', el.alias],
                    ['slug', el.slug],
                    ['id', el.id],
                    ['model', el.model]
                ];
                for (const [fKey, fVal] of slashFields) {
                    if (typeof fVal !== 'string') continue;
                    const trimmed = fVal.trim();
                    const sIdx = trimmed.indexOf('/');
                    if (sIdx <= 0 || sIdx >= trimmed.length - 1) continue;
                    const left = trimmed.slice(0, sIdx).trim();
                    const right = trimmed.slice(sIdx + 1).trim();
                    if (!isValidRoutingPrefix(left) || !right) continue;
                    if (EXPLICIT_VARIANT_SLASH_KEYS.has(fKey) || right.toLowerCase() === baseModelName.toLowerCase()) {
                        vPrefix = left;
                        break;
                    }
                }

                if (!vPrefix) {
                    const elPrefixCands = [
                        el.prefix, el.provider_prefix, el.providerPrefix,
                        el.model_prefix, el.route_prefix,
                        el.provider_slug, el.providerSlug, el.slug,
                        el.code, el.handle, el.short_name, el.shortName,
                        el.provider?.prefix, el.provider?.slug
                    ];
                    for (const cand of elPrefixCands) {
                        if (isValidRoutingPrefix(cand)) {
                            vPrefix = cand.trim();
                            break;
                        }
                    }
                }

                const vRawOwnedBy = typeof el.owned_by === 'string' ? el.owned_by.trim() : '';
                const vProviderId = pickFirstString([
                    el.provider_id, el.providerId,
                    el.owner_id, el.seller_id,
                    isOpaqueIdentifier(vRawOwnedBy) ? vRawOwnedBy : '',
                    isOpaqueIdentifier(el.id) ? el.id : ''
                ], { rejectOpaque: false, maxLen: 128 });

                const vDir = (vRawOwnedBy && (providerDirectory.get(vRawOwnedBy) || providerDirectory.get(vRawOwnedBy.toLowerCase())))
                    || (vProviderId && (providerDirectory.get(vProviderId) || providerDirectory.get(vProviderId.toLowerCase())))
                    || null;

                if (!vPrefix && vDir?.prefix && isValidRoutingPrefix(vDir.prefix)) {
                    vPrefix = vDir.prefix.trim();
                }

                const vOwner = pickFirstString([
                    el.provider_name, el.providerName,
                    el.seller_name, el.sellerName,
                    el.owner_name,
                    el.display_name, el.displayName,
                    el.name, el.username,
                    el.provider?.name,
                    typeof el.provider === 'string' ? el.provider : '',
                    vDir?.name || '',
                    vRawOwnedBy
                ], { rejectOpaque: true });

                if (vPrefix) {
                    variants.push({
                        id: `${vPrefix}/${baseModelName}`,
                        prefix: vPrefix,
                        modelName: baseModelName,
                        ownedBy: vOwner,
                        providerId: vProviderId,
                        isOpaqueProvider: false,
                        displayName
                    });
                } else if (vOwner) {
                    variants.push({
                        id: baseModelName,
                        prefix: '',
                        modelName: baseModelName,
                        ownedBy: vOwner,
                        providerId: vProviderId,
                        isOpaqueProvider: false,
                        displayName
                    });
                } else if (vProviderId && isOpaqueIdentifier(vProviderId)) {
                    variants.push({
                        id: baseModelName,
                        prefix: '',
                        modelName: baseModelName,
                        ownedBy: '',
                        providerId: vProviderId,
                        isOpaqueProvider: true,
                        displayName
                    });
                }
            }
        }
    }

    return variants;
}

function finalizeModelEntry({ id, prefix, modelName, readableOwner, rawOwnedBy, rawProviderId, displayName }) {
    let provider = 'default';
    let providerKey = 'default';
    let ownedBy = '';
    let isOpaqueProvider = false;
    let providerId = rawProviderId || (isOpaqueIdentifier(rawOwnedBy) ? rawOwnedBy : '');

    if (prefix) {
        provider = prefix;
        providerKey = prefix;
        ownedBy = readableOwner;
        isOpaqueProvider = false;
    } else if (readableOwner) {
        provider = readableOwner;
        providerKey = readableOwner;
        ownedBy = readableOwner;
        isOpaqueProvider = false;
    } else if ((rawOwnedBy && isOpaqueIdentifier(rawOwnedBy)) || (rawProviderId && isOpaqueIdentifier(rawProviderId))) {
        const opaque = (rawOwnedBy && isOpaqueIdentifier(rawOwnedBy)) ? rawOwnedBy : rawProviderId;
        provider = formatShortOpaqueId(opaque);
        providerKey = opaque;
        providerId = opaque;
        ownedBy = '';
        isOpaqueProvider = true;
    }

    return {
        id,
        provider,
        providerKey,
        providerId,
        isOpaqueProvider,
        modelName,
        ownedBy,
        displayName
    };
}

function normalizeFetchedModels(payload) {
    const rawList = extractRawModelList(payload);
    const providerDirectory = buildProviderDirectory(payload);
    const seenKeys = new Set();
    const result = [];
    const EXPLICIT_SLASH_ID_KEYS = new Set([
        'full_id', 'fullId', 'qualified_id', 'qualifiedId', 'api_model', 'apiModel', 'route'
    ]);

    for (const item of rawList) {
        if (!item) continue;
        const isObj = typeof item === 'object' && !Array.isArray(item);
        let rawId = '';
        if (typeof item === 'string') {
            rawId = item.trim();
        } else if (isObj) {
            const candidateRawId = pickFirstString([item.id, item.model, item.model_id, item.model_name], { rejectOpaque: false, maxLen: 200 });
            const altModelId = pickFirstString([item.model, item.model_id, item.model_name, item.modelName], { rejectOpaque: true, maxLen: 200 });
            rawId = (typeof item.id === 'string' && isOpaqueIdentifier(item.id) && altModelId)
                ? altModelId
                : candidateRawId;
        }
        if (!rawId) continue;

        const rawOwnedBy = isObj && typeof item.owned_by === 'string' ? item.owned_by.trim() : '';
        const rawProviderId = isObj
            ? pickFirstString([
                item.provider_id, item.providerId,
                item.owner_id, item.ownerId,
                item.seller_id, item.sellerId,
                isOpaqueIdentifier(rawOwnedBy) ? rawOwnedBy : ''
            ], { rejectOpaque: false, maxLen: 128 })
            : '';

        const dirEntry = (rawOwnedBy && (providerDirectory.get(rawOwnedBy) || providerDirectory.get(rawOwnedBy.toLowerCase())))
            || (rawProviderId && (providerDirectory.get(rawProviderId) || providerDirectory.get(rawProviderId.toLowerCase())))
            || null;

        const displayName = isObj
            ? pickFirstString([item.display_name, item.displayName, item.name], { rejectOpaque: false, maxLen: 160 })
            : '';

        let id = rawId;
        let prefix = '';
        let modelName = rawId;

        const rawSlashIdx = rawId.indexOf('/');
        const baseModelName = (rawSlashIdx > 0 && rawSlashIdx < rawId.length - 1)
            ? rawId.slice(rawSlashIdx + 1).trim()
            : rawId;

        if (rawSlashIdx > 0 && rawSlashIdx < rawId.length - 1) {
            prefix = rawId.slice(0, rawSlashIdx).trim();
            modelName = baseModelName;
        } else if (isObj) {
            const slashCandidates = [
                ['full_id', item.full_id],
                ['fullId', item.fullId],
                ['qualified_id', item.qualified_id],
                ['qualifiedId', item.qualifiedId],
                ['api_model', item.api_model],
                ['apiModel', item.apiModel],
                ['route', item.route],
                ['model_slug', item.model_slug],
                ['modelSlug', item.modelSlug],
                ['slug', item.slug],
                ['canonical_slug', item.canonical_slug],
                ['canonicalSlug', item.canonicalSlug],
                ['alias', item.alias],
                ['model_alias', item.model_alias],
                ['modelAlias', item.modelAlias],
                ['full_name', item.full_name],
                ['fullName', item.fullName],
                ['display_id', item.display_id],
                ['displayId', item.displayId],
                ['name', item.name],
                ['display_name', item.display_name],
                ['displayName', item.displayName]
            ];

            let matchedQualified = false;
            for (const [key, cand] of slashCandidates) {
                if (typeof cand !== 'string') continue;
                const trimmed = cand.trim();
                const sIdx = trimmed.indexOf('/');
                if (sIdx <= 0 || sIdx >= trimmed.length - 1) continue;
                const left = trimmed.slice(0, sIdx).trim();
                const right = trimmed.slice(sIdx + 1).trim();
                if (!isValidRoutingPrefix(left) || !right) continue;
                if (EXPLICIT_SLASH_ID_KEYS.has(key) || right.toLowerCase() === rawId.toLowerCase()) {
                    prefix = left;
                    modelName = right;
                    id = `${left}/${right}`;
                    matchedQualified = true;
                    break;
                }
            }

            if (!matchedQualified) {
                const subObjects = [
                    item.provider, item.owner, item.seller, item.channel,
                    item.routing, item.meta, item.metadata
                ];
                const prefixCandidates = [
                    item.prefix, item.model_prefix, item.modelPrefix,
                    item.provider_prefix, item.providerPrefix,
                    item.route_prefix, item.routePrefix,
                    item.routing_prefix, item.routingPrefix,
                    item.provider_slug, item.providerSlug,
                    item.seller_slug, item.sellerSlug,
                    item.owner_slug, item.ownerSlug,
                    item.channel_prefix, item.channelPrefix,
                    item.namespace,
                    item.provider_code, item.providerCode,
                    item.prefix_code, item.prefixCode
                ];
                for (const sub of subObjects) {
                    if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
                        prefixCandidates.push(
                            sub.prefix, sub.provider_prefix, sub.providerPrefix,
                            sub.slug, sub.code, sub.handle, sub.short_name, sub.shortName
                        );
                    }
                }
                if (dirEntry?.prefix) prefixCandidates.push(dirEntry.prefix);

                const prefixKeyRegex = /(^|_)prefix($|_)|provider_?(slug|code|tag)|route_?(prefix|slug)/i;
                prefixCandidates.push(...scanMatchingObjectValues(item, prefixKeyRegex));
                for (const sub of [item.provider, item.owner, item.seller, item.channel, item.meta, item.metadata]) {
                    prefixCandidates.push(...scanMatchingObjectValues(sub, prefixKeyRegex));
                }

                for (const cand of prefixCandidates) {
                    if (isValidRoutingPrefix(cand)) {
                        prefix = cand.trim();
                        id = `${prefix}/${rawId}`;
                        modelName = rawId;
                        break;
                    }
                }
            }
        }

        let readableOwner = '';
        if (isObj) {
            const ownerCandidates = [
                item.provider_name, item.providerName, item.provider_display_name, item.providerDisplayName,
                item.provider?.display_name, item.provider?.displayName, item.provider?.name, item.provider?.username, item.provider?.title,
                typeof item.provider === 'string' ? item.provider : '',
                item.seller_name, item.sellerName,
                item.seller?.display_name, item.seller?.name, item.seller?.username,
                typeof item.seller === 'string' ? item.seller : '',
                item.owner_name, item.ownerName,
                item.owner?.display_name, item.owner?.name, item.owner?.username,
                typeof item.owner === 'string' ? item.owner : '',
                item.channel_name, item.channelName, item.channel?.name,
                typeof item.channel === 'string' ? item.channel : '',
                item.owned_by_name, item.ownedByName,
                item.by, item.author, item.vendor, item.organization, item.org, item.creator, item.source,
                item.meta?.provider_name, item.meta?.providerName, item.meta?.provider, item.meta?.owner_name, item.meta?.seller_name, item.meta?.seller,
                item.metadata?.provider_name, item.metadata?.providerName, item.metadata?.provider, item.metadata?.owner_name, item.metadata?.seller_name, item.metadata?.seller,
                dirEntry?.name || '',
                rawOwnedBy
            ];
            const ownerKeyRegex = /(provider|seller|owner|vendor|author|channel).*(name|label|title|handle|user)|^(provider|seller|owner|vendor|author|by)$/i;
            ownerCandidates.push(...scanMatchingObjectValues(item, ownerKeyRegex));
            for (const sub of [item.provider, item.owner, item.seller, item.channel, item.meta, item.metadata]) {
                ownerCandidates.push(...scanMatchingObjectValues(sub, ownerKeyRegex));
            }
            readableOwner = pickFirstString(ownerCandidates, { rejectOpaque: true });
        }

        const primaryRaw = {
            id,
            prefix,
            modelName,
            readableOwner,
            rawOwnedBy,
            rawProviderId,
            displayName
        };

        const variants = isObj ? collectItemVariants(item, baseModelName, displayName, providerDirectory) : [];
        let entriesToEmit = [primaryRaw];

        if (variants.length > 0) {
            const primaryHasPrefix = Boolean(prefix);
            const variantsHavePrefix = variants.some((v) => Boolean(v.prefix));

            if (primaryHasPrefix) {
                entriesToEmit = [primaryRaw];
                for (const v of variants) {
                    if (v.id.toLowerCase() === primaryRaw.id.toLowerCase()) {
                        if (!primaryRaw.readableOwner && v.ownedBy) primaryRaw.readableOwner = v.ownedBy;
                        if (!primaryRaw.rawProviderId && v.providerId) primaryRaw.rawProviderId = v.providerId;
                    } else {
                        entriesToEmit.push({
                            id: v.id,
                            prefix: v.prefix,
                            modelName: v.modelName,
                            readableOwner: v.ownedBy || '',
                            rawOwnedBy: v.ownedBy || '',
                            rawProviderId: v.providerId || '',
                            displayName: v.displayName || displayName
                        });
                    }
                }
            } else if (variantsHavePrefix) {
                entriesToEmit = variants.map((v) => ({
                    id: v.id,
                    prefix: v.prefix,
                    modelName: v.modelName,
                    readableOwner: v.ownedBy || (variants.length === 1 ? readableOwner : ''),
                    rawOwnedBy: v.ownedBy || (variants.length === 1 ? rawOwnedBy : ''),
                    rawProviderId: v.providerId || (variants.length === 1 ? rawProviderId : ''),
                    displayName: v.displayName || displayName
                }));
            } else {
                const variantEntries = variants.map((v) => ({
                    id: v.id,
                    prefix: v.prefix,
                    modelName: v.modelName,
                    readableOwner: v.ownedBy || '',
                    rawOwnedBy: v.ownedBy || '',
                    rawProviderId: v.providerId || '',
                    displayName: v.displayName || displayName
                }));
                entriesToEmit = (!readableOwner && !rawProviderId && (!rawOwnedBy || !isOpaqueIdentifier(rawOwnedBy)))
                    ? variantEntries
                    : [primaryRaw, ...variantEntries];
            }
        }

        for (const candidate of entriesToEmit) {
            const entry = finalizeModelEntry(candidate);
            const dedupKey = `${entry.id.toLowerCase()}::${(entry.providerKey || entry.provider || '').toLowerCase()}`;
            if (seenKeys.has(dedupKey)) continue;
            seenKeys.add(dedupKey);
            result.push(entry);
        }
    }

    return result;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function safePortPost(port, msg) {
    try {
        port.postMessage(msg);
        return true;
    } catch {
        return false;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !request.action) return false;
    if (request.action === 'get_runtime_config') {
        chrome.storage.local.get(['stv_locale'], (data) => sendResponse(data || {}));
        return true;
    }
    if (request.action === 'set_runtime_setting' && request.key) {
        const allowed = new Set(['ttsAutoNextChapter', 'ttsSpeed', 'stv_locale', 'ttsDownloadMinutes', 'ttsIconMode', 'ttsIconStyle']);
        if (!allowed.has(request.key)) {
            sendResponse({ ok: false, error: 'Setting không được phép' });
            return false;
        }
        chrome.storage.local.set({ [request.key]: request.value }, () => {
            sendResponse({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message || '' });
        });
        return true;
    }
    if (request.action === 'get_shortcut') {
        chrome.storage.local.get(['shortcut'], (data) => {
            sendResponse({ shortcut: data.shortcut || 'Ctrl+Q' });
        });
        return true;
    }

    if (request.action === 'shortcut_triggered' && sender.tab) {
        runTranslationSequence(sender.tab.id).then(res => {
            sendResponse({ status: "started", data: res });
        }).catch(err => {
            sendResponse({ status: "error", error: err.toString() });
        });
        return true;
    }

    if (request.action === 'translate_active_tab') {
        const targetTabId = request.tabId;
        (async () => {
            let tabId = targetTabId;
            if (!tabId) {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                tabId = tab && tab.id;
            }
            if (!tabId) throw new Error('Không tìm thấy tab đang mở');
            return await runTranslationSequence(tabId);
        })()
            .then((data) => sendResponse({ ok: true, data }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }

    if (request.action === 'vieneu_native_control') {
        const rawPort = request.port || parsePortFromUrl(request.serverUrl);
        const portNum = Math.floor(Number(rawPort));
        if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
            sendResponse({ ok: false, error: 'Port VieNeu không hợp lệ (1-65535)' });
            return false;
        }
        const payload = {
            action: request.command || 'status',
            port: portNum,
            backend: request.backend || 'auto'
        };
        chrome.runtime.sendNativeMessage(VIENEU_NATIVE_HOST, payload, (response) => {
            if (chrome.runtime.lastError) {
                const msg = chrome.runtime.lastError.message || 'Native host unavailable';
                const notInstalled = /not found|forbidden|exited/i.test(msg);
                sendResponse({ ok: false, notInstalled, error: msg });
                return;
            }
            sendResponse(response || { ok: false, error: 'Phản hồi rỗng từ Native Host' });
        });
        return true;
    }

    if (request.action === 'vieneu_check_health') {
        const serverUrl = normalizeServerUrl(request.serverUrl);
        fetchWithTimeout(`${serverUrl}/health`, { method: 'GET' }, 2500)
            .then(async (res) => {
                if (!res.ok) {
                    const txt = await res.text().catch(() => '');
                    throw new Error(`HTTP ${res.status}${txt ? ': ' + txt : ''}`);
                }
                const data = await res.json();
                sendResponse({ ok: true, data });
            })
            .catch((err) => {
                sendResponse({ ok: false, error: err.name === 'AbortError' ? 'Timeout kết nối VieNeu' : err.message });
            });
        return true;
    }

    if (request.action === 'vieneu_set_worker_mode') {
        const serverUrl = normalizeServerUrl(request.serverUrl);
        const mode = request.mode === 'export' ? 'export' : 'listen';
        const timeoutMs = mode === 'export' ? 25000 : 5000;
        const body = { mode };
        if (request.leaseId) body.lease_id = String(request.leaseId);
        if (mode === 'export' && Number.isFinite(Number(request.workers))) {
            body.workers = Math.max(1, Math.min(4, Math.floor(Number(request.workers))));
        }
        if (Number.isFinite(Number(request.ttlSec))) {
            body.ttl_sec = Math.max(10, Math.min(600, Number(request.ttlSec)));
        }
        (async () => {
            const ttsCfg = await chrome.storage.local.get(['ttsApiKey']);
            const resolvedApiKey = (request.apiKey !== undefined && request.apiKey !== '')
                ? request.apiKey
                : (ttsCfg.ttsApiKey || '');
            const headers = buildAuthHeaders(resolvedApiKey, { 'Content-Type': 'application/json' });
            const res = await fetchWithTimeout(`${serverUrl}/v1/workers/mode`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            }, timeoutMs);
            if (!res.ok) {
                const txt = await res.text().catch(() => '');
                sendResponse({
                    ok: false,
                    unsupported: res.status === 404 || res.status === 405,
                    status: res.status,
                    error: `HTTP ${res.status}${txt ? ': ' + txt : ''}`
                });
                return;
            }
            const data = await res.json().catch(() => ({}));
            sendResponse({ ok: true, data });
        })().catch((err) => {
            sendResponse({
                ok: false,
                error: err?.name === 'AbortError' ? 'Timeout chuyển chế độ worker VieNeu' : (err?.message || String(err))
            });
        });
        return true;
    }

    if (request.action === 'vieneu_get_voices') {
        const serverUrl = normalizeServerUrl(request.serverUrl);
        const headers = buildAuthHeaders(request.apiKey);
        fetchWithTimeout(`${serverUrl}/v1/voices`, { method: 'GET', headers }, 4000)
            .then(async (res) => {
                if (!res.ok) {
                    const errBody = await res.json().catch(() => null);
                    const msg = errBody?.error?.message || `HTTP ${res.status}`;
                    throw new Error(msg);
                }
                const json = await res.json();
                const list = Array.isArray(json?.data) ? json.data : [];
                sendResponse({ ok: true, voices: list });
            })
            .catch((err) => {
                sendResponse({ ok: false, error: err.message });
            });
        return true;
    }

    if (request.action === 'vieneu_auto_play' && sender.tab) {
        const tabId = sender.tab.id;
        (async () => {
            const locData = await chrome.storage.local.get(['stv_locale']);
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['i18n.js', 'page-ui.js', 'extractor.js', 'tts-icon-describer.js', 'tts-player.js']
            });
            await chrome.scripting.executeScript({
                target: { tabId },
                func: (loc) => {
                    if (loc && window.STV_I18n && typeof window.STV_I18n.setLocale === 'function') {
                        window.STV_I18n.setLocale(loc);
                    }
                    if (typeof window.STV_startTTS === 'function') {
                        window.STV_startTTS({ autoTriggered: true });
                    }
                },
                args: [locData.stv_locale || '']
            });
        })()
            .then(() => sendResponse({ ok: true }))
            .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
    }

    if (request.action === 'stv_retranslate_line') {
        handleRetranslateLine(request).then(sendResponse);
        return true; // Giữ kênh phản hồi bất đồng bộ
    }

    if (request.action === 'start_chapter_preload' && sender.tab) {
        const tabId = sender.tab.id;
        const targetUrl = String(request.url || '').trim();
        const senderUrl = sender.tab.url || '';

        // Kiểm tra an toàn bảo mật SSRF và Cùng Origin/Site qua url-validator
        const validator = globalThis.STV_UrlValidator || globalThis;
        let resolvedUrl = targetUrl;
        if (typeof validator.isSafePreloadTarget === 'function') {
            const check = validator.isSafePreloadTarget(senderUrl, targetUrl);
            if (!check.valid) {
                console.warn(`[STV Background] Preload URL bị từ chối bởi SSRF policy: ${check.reason} (Target: ${targetUrl})`);
                sendResponse({ ok: false, error: `Preload bị từ chối: ${check.reason}` });
                return false;
            }
            resolvedUrl = check.resolvedUrl || targetUrl;
        } else if (!/^https?:\/\//i.test(targetUrl)) {
            sendResponse({ ok: false, error: 'URL chương tiếp theo không hợp lệ' });
            return false;
        }

        const preloadId = makePreloadId(tabId, resolvedUrl);
        if (!preloadedChapters.has(preloadId) && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
            getOrRestorePreloadEntry(preloadId)
                .then(() => {
                    const result = startPreloadWorker(tabId, resolvedUrl, request.mode);
                    sendResponse(result);
                })
                .catch(() => {
                    const result = startPreloadWorker(tabId, resolvedUrl, request.mode);
                    sendResponse(result);
                });
            return true;
        }

        const result = startPreloadWorker(tabId, resolvedUrl, request.mode);
        sendResponse(result);
        return false;
    }

    if (request.action === 'cancel_chapter_preload' && sender.tab) {
        const targetUrlFilter = request.url ? String(request.url).trim() : null;
        cleanupTabPreloads(sender.tab.id, null, { targetUrlFilter });
        sendResponse({ ok: true });
        return false;
    }

    if (request.action === 'navigate_next_chapter' && sender.tab) {
        const tabId = sender.tab.id;
        const targetUrl = String(request.url || '').trim();
        const senderUrl = sender.tab.url || '';

        const validator = globalThis.STV_UrlValidator || globalThis;
        let resolvedUrl = targetUrl;
        if (typeof validator.isSafePreloadTarget === 'function') {
            const check = validator.isSafePreloadTarget(senderUrl, targetUrl);
            if (!check.valid) {
                console.warn(`[STV Background] Chuyển chương bị từ chối bởi SSRF policy: ${check.reason} (Target: ${targetUrl})`);
                sendResponse({ ok: false, error: `Chuyển chương bị từ chối: ${check.reason}` });
                return false;
            }
            resolvedUrl = check.resolvedUrl || targetUrl;
        } else if (!/^https?:\/\//i.test(targetUrl)) {
            sendResponse({ ok: false, error: 'URL chương tiếp theo không hợp lệ' });
            return false;
        }

        const mode = request.mode === 'translate' ? 'translate' : 'tts_only';
        const preloadId = makePreloadId(tabId, resolvedUrl);
        setPendingAutoAdvance(tabId, {
            targetUrl: resolvedUrl,
            mode,
            preloadId,
            startedAt: Date.now()
        }).then(() => {
            if (request.rendererNavigate === true) {
                sendResponse({ ok: true, preloadId, rendererNavigate: true, targetUrl: resolvedUrl });
                return;
            }
            return chrome.tabs.update(tabId, { url: resolvedUrl })
                .then(() => sendResponse({ ok: true, preloadId }));
        }).catch((err) => {
            deletePendingAutoAdvance(tabId);
            sendResponse({ ok: false, error: err?.message || String(err) });
        });
        return true;
    }

    if (request.action === 'stv_get_public_config') {
        chrome.storage.local.get(['fontSize', 'fontFamily', 'lineHeight', 'ttsAutoPlay', 'stv_locale'], (data) => {
            sendResponse({ ok: true, data });
        });
        return true;
    }

    if (request.action === 'get_tts_runtime_config') {
        chrome.storage.local.get([
            'ttsEngine', 'ttsWsEndpoint', 'ttsWsVoice', 'ttsWsFallback', 'ttsWsAutoFallback',
            'ttsEndpoint', 'ttsVoice', 'ttsApiKey', 'ttsSpeed', 'ttsStability', 'ttsStabilityProfile',
            'ttsAutoNext', 'ttsAutoNextChapter', 'ttsPreloadSec', 'ttsPreloadSeconds', 'ttsDownloadMinutes',
            'ttsIconMode', 'ttsIconStyle', TTS_ICON_CACHE_KEY, TTS_CUSTOM_ICONS_KEY,
            'stv_locale', 'stvDebugLog'
        ], (data) => {
            if (data.ttsWsAutoFallback === undefined) data.ttsWsAutoFallback = data.ttsWsFallback;
            if (data.ttsStabilityProfile === undefined) data.ttsStabilityProfile = data.ttsStability;
            if (data.ttsAutoNextChapter === undefined) data.ttsAutoNextChapter = data.ttsAutoNext;
            if (data.ttsPreloadSeconds === undefined) data.ttsPreloadSeconds = data.ttsPreloadSec;
            if (!data.ttsIconMode) data.ttsIconMode = 'auto';
            if (!data.ttsIconStyle) data.ttsIconStyle = 'tagged';
            data.ttsIconLearnedCache = flattenIconCacheForRuntime(data[TTS_ICON_CACHE_KEY]);
            delete data[TTS_ICON_CACHE_KEY];
            const describer = globalThis.STV_IconDescriber || null;
            const rawCustom = data[TTS_CUSTOM_ICONS_KEY];
            data.ttsCustomIcons = (describer && typeof describer.normalizeCustomIconsMap === 'function')
                ? describer.normalizeCustomIconsMap(rawCustom)
                : ((rawCustom && typeof rawCustom === 'object' && !Array.isArray(rawCustom)) ? rawCustom : {});
            delete data[TTS_CUSTOM_ICONS_KEY];
            sendResponse({ ok: true, data });
        });
        return true;
    }

    if (request.action === 'get_site_selector') {
        const host = String(request.hostname || '').trim();
        if (!host) {
            sendResponse({ ok: false, selector: '' });
            return false;
        }
        const key = `stv_selector_${host}`;
        chrome.storage.local.get([key], (data) => {
            sendResponse({ ok: true, selector: data[key] || '' });
        });
        return true;
    }

    if (request.action === 'save_site_selector' && request.hostname && request.selector) {
        const host = String(request.hostname).trim();
        const key = `stv_selector_${host}`;
        chrome.storage.local.set({ [key]: String(request.selector) }, () => {
            sendResponse({ ok: true });
        });
        return true;
    }

    if (request.action === 'stv_save_selector' && request.key && request.value) {
        // Chỉ cho phép lưu khóa css selector có tiền tố stv_selector_
        if (typeof request.key === 'string' && request.key.startsWith('stv_selector_')) {
            chrome.storage.local.set({ [request.key]: request.value }, () => {
                sendResponse({ ok: true });
            });
        } else {
            sendResponse({ ok: false, error: 'Khóa lưu selector không hợp lệ' });
        }
        return true;
    }

    if (request.action === 'fetch_ai_models') {
        (async () => {
            const stored = await chrome.storage.local.get(['endpoint', 'apikey', 'stvDebugLog']);
            const rawEndpoint = (typeof request.endpoint === 'string' && request.endpoint.trim())
                ? request.endpoint.trim()
                : ((stored.endpoint || '').trim() || DEFAULT_ENDPOINT);
            const resolvedApiKey = (typeof request.apiKey === 'string' && request.apiKey.trim())
                ? request.apiKey.trim()
                : (stored.apikey || '').trim();

            const validator = globalThis.STV_UrlValidator || globalThis;
            if (typeof validator.isValidUrl === 'function' && !validator.isValidUrl(rawEndpoint)) {
                sendResponse({ ok: false, error: 'API Endpoint URL không hợp lệ (chỉ hỗ trợ http/https).' });
                return;
            }

            const modelsUrl = deriveModelsEndpointUrl(rawEndpoint);
            if (!modelsUrl) {
                sendResponse({ ok: false, error: 'Không tạo được URL /models từ Endpoint hiện tại.' });
                return;
            }

            const headers = buildAuthHeaders(resolvedApiKey, { 'Accept': 'application/json' });
            const res = await fetchWithTimeout(modelsUrl, { method: 'GET', headers }, 12000);
            if (!res.ok) {
                let errMsg = `HTTP ${res.status}`;
                if (res.status === 401 || res.status === 403) {
                    errMsg = `Xác thực thất bại (HTTP ${res.status}). Hãy kiểm tra API Key.`;
                } else {
                    try {
                        const errJson = await res.json();
                        if (errJson?.error?.message) errMsg = errJson.error.message;
                        else if (errJson?.message) errMsg = errJson.message;
                    } catch {}
                }
                sendResponse({ ok: false, error: errMsg, status: res.status, modelsUrl });
                return;
            }

            const json = await res.json();
            const rawList = extractRawModelList(json);
            const topLevelKeys = (json && typeof json === 'object' && !Array.isArray(json))
                ? Object.keys(json).slice(0, 20)
                : [];
            const itemKeysSet = new Set();
            const arrayFieldsSet = new Set();
            for (const entry of rawList) {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
                for (const [k, v] of Object.entries(entry)) {
                    itemKeysSet.add(k);
                    if (Array.isArray(v)) arrayFieldsSet.add(k);
                }
            }
            const itemKeys = Array.from(itemKeysSet).sort().slice(0, 30);
            const arrayFields = Array.from(arrayFieldsSet).sort().slice(0, 20);
            const models = normalizeFetchedModels(json);
            const opaqueProviderCount = models.filter((m) => m.isOpaqueProvider).length;
            const meta = {
                totalRaw: rawList.length,
                normalizedCount: models.length,
                opaqueProviderCount,
                topLevelKeys,
                itemKeys,
                arrayFields,
                sampleKeys: itemKeys.slice(0, 20)
            };
            console.info('[STV Background] fetch_ai_models:', {
                modelsUrl,
                totalRaw: rawList.length,
                normalizedCount: models.length,
                opaqueProviderCount,
                topLevelKeys,
                itemKeys,
                arrayFields
            });
            sendResponse({ ok: true, models, modelsUrl, meta });
        })().catch((err) => {
            const msg = err?.name === 'AbortError'
                ? 'Timeout khi tải danh sách model từ API'
                : (err?.message || String(err));
            sendResponse({ ok: false, error: msg });
        });
        return true;
    }

    if (request.action === 'resolve_tts_icons') {
        const describer = globalThis.STV_IconDescriber || null;
        if (!describer) {
            sendResponse({ ok: false, error: 'Icon describer unavailable' });
            return false;
        }
        const rawItems = Array.isArray(request.items) ? request.items.slice(0, 15) : [];
        if (rawItems.length === 0) {
            sendResponse({ ok: true, results: [], cacheUpdates: {} });
            return false;
        }

        const style = request.style === 'natural' ? 'natural' : 'tagged';
        const lang = request.lang === 'en' ? 'en' : 'vi';

        (async () => {
            const config = await chrome.storage.local.get([
                'endpoint', 'apikey', 'model', TTS_ICON_CACHE_KEY, TTS_CUSTOM_ICONS_KEY, 'stvDebugLog'
            ]);
            const apikey = (config.apikey || '').trim();
            if (!apikey) {
                sendResponse({ ok: false, reason: 'no_api_key', error: 'API key not configured' });
                return;
            }
            const endpoint = (config.endpoint || '').trim() || DEFAULT_ENDPOINT;
            const validator = globalThis.STV_UrlValidator || globalThis;
            if (typeof validator.isValidUrl === 'function' && !validator.isValidUrl(endpoint)) {
                sendResponse({ ok: false, error: 'API Endpoint URL không hợp lệ' });
                return;
            }
            const model = (config.model || '').trim() || DEFAULT_MODEL;

            const normalizedItems = rawItems.map((it) => ({
                id: Number(it?.id),
                prev: String(it?.prev || '').slice(0, 240),
                text: String(it?.text || '').slice(0, 500),
                fallbackText: String(it?.fallbackText || '').slice(0, 500),
                next: String(it?.next || '').slice(0, 240),
                icons: Array.isArray(it?.icons) ? it.icons.slice(0, 8).map((s) => String(s || '')) : []
            })).filter((it) => Number.isFinite(it.id) && it.text.length > 0);

            if (normalizedItems.length === 0) {
                sendResponse({ ok: true, results: [], cacheUpdates: {} });
                return;
            }

            const { systemPrompt, userMessage } = describer.buildAiIconPrompt(normalizedItems, { style, lang });
            const res = await fetchWithTimeout(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apikey}`,
                    'HTTP-Referer': 'https://github.com/stv-extension',
                    'X-Title': 'Quick Novel Translator'
                },
                body: JSON.stringify({
                    model,
                    temperature: 0.2,
                    stream: false,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMessage }
                    ]
                })
            }, 6000);

            if (!res.ok) {
                sendResponse({ ok: false, status: res.status, error: `HTTP ${res.status}` });
                return;
            }

            const json = await res.json();
            const rawContent = json?.choices?.[0]?.message?.content || '';
            const parsed = describer.parseAiIconResponse(rawContent);
            if (!parsed) {
                sendResponse({ ok: false, error: 'Invalid AI icon response JSON' });
                return;
            }

            const itemById = new Map(normalizedItems.map((it) => [it.id, it]));
            const finalResults = [];
            const rawCacheUpdates = {};

            for (const entry of parsed) {
                const orig = itemById.get(entry.id);
                if (!orig) continue;
                const safeSpoken = describer.sanitizeAiSpokenText(entry.spoken, orig.text, orig.fallbackText, {
                    iconCount: orig.icons.length || 1
                });
                finalResults.push({ id: orig.id, spoken: safeSpoken });

                if (entry.icon_gloss && typeof entry.icon_gloss === 'object') {
                    const glossEntries = Object.entries(entry.icon_gloss);
                    for (const [k, v] of glossEntries) {
                        rawCacheUpdates[k] = v;
                    }
                    if (orig.icons.length === 1 && glossEntries.length === 1) {
                        rawCacheUpdates[orig.icons[0]] = glossEntries[0][1];
                    }
                }
            }

            const customIcons = (typeof describer.normalizeCustomIconsMap === 'function')
                ? describer.normalizeCustomIconsMap(config[TTS_CUSTOM_ICONS_KEY])
                : {};
            const filteredCacheUpdates = {};
            for (const [k, v] of Object.entries(rawCacheUpdates)) {
                if (typeof describer.lookupCustomIcon === 'function' && describer.lookupCustomIcon(customIcons, k, k)) {
                    continue;
                }
                filteredCacheUpdates[k] = v;
            }

            let cacheUpdates = {};
            if (Object.keys(filteredCacheUpdates).length > 0) {
                const mergedRes = mergeTtsIconCache(config[TTS_ICON_CACHE_KEY], filteredCacheUpdates, lang);
                cacheUpdates = mergedRes.flatUpdates;
                if (mergedRes.changed) {
                    await chrome.storage.local.set({ [TTS_ICON_CACHE_KEY]: mergedRes.merged });
                }
            }

            if (config.stvDebugLog) {
                console.log('[STV Background TTS Icons]', { model, style, lang, count: finalResults.length, cacheUpdates });
            }
            sendResponse({ ok: true, results: finalResults, cacheUpdates });
        })().catch((err) => {
            const msg = err?.name === 'AbortError'
                ? 'Timeout mô tả icon TTS'
                : (err?.message || String(err));
            sendResponse({ ok: false, error: msg });
        });
        return true;
    }
});

async function handleRetranslateLine(request) {
    const origText = String(request.origText || request.text || '').trim();
    const lineIndex = typeof request.lineIndex === 'number' ? request.lineIndex : -1;
    const glossaryProfile = request.glossaryProfile;

    if (!origText) {
        return { ok: false, error: 'Văn bản cần dịch lại rỗng' };
    }

    try {
        const config = await chrome.storage.local.get([
            'endpoint', 'apikey', 'model', 'stv_active_glossary_profile'
        ]);
        const apikey = (config.apikey || '').trim();
        if (!apikey) {
            return { ok: false, error: 'Chưa cấu hình API Key trong tiện ích' };
        }

        const endpoint = config.endpoint || DEFAULT_ENDPOINT;
        const model = config.model || DEFAULT_MODEL;
        const activeProfile = glossaryProfile || config.stv_active_glossary_profile || 'Default';

        let singlePrompt = "Dịch câu/đoạn sau sang tiếng Việt. Trả về kết quả dịch thuần túy, KHÔNG có thẻ HTML hay Markdown, KHÔNG giải thích.";

        const utils = globalThis.STV_GlossaryUtils || (typeof window !== 'undefined' ? window.STV_GlossaryUtils : null);
        const glossaryKey = `stv_glossary_profile_${activeProfile}`;
        const glossaryData = await chrome.storage.local.get([glossaryKey]);
        const glossary = glossaryData[glossaryKey] || {};
        let matched = {};
        if (utils && typeof utils.findMatchingGlossaryTerms === 'function') {
            matched = utils.findMatchingGlossaryTerms(origText, glossary);
        } else {
            for (const [orig, info] of Object.entries(glossary)) {
                if (orig && info && (info.hanviet || typeof info === 'string') && origText.includes(orig)) {
                    matched[orig] = typeof info === 'string' ? info : info.hanviet;
                }
            }
        }
        if (matched && Object.keys(matched).length > 0) {
            const glossaryPrompt = Object.entries(matched).map(([k, v]) => `- "${k}": "${v}"`).join('\n');
            singlePrompt += `\nBắt buộc tuân thủ các thuật ngữ sau:\n${glossaryPrompt}`;
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apikey}`,
                'HTTP-Referer': 'https://github.com/stv-extension',
                'X-Title': 'Quick Novel Translator'
            },
            body: JSON.stringify({
                model,
                temperature: 0.2,
                messages: [
                    { role: 'system', content: singlePrompt },
                    { role: 'user', content: origText }
                ]
            })
        });

        if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            if (response.status === 402) {
                errMsg = 'API OpenRouter báo lỗi 402 Limit (Hết tiền hoặc hết credit).';
            } else if (response.status === 401) {
                errMsg = 'API Key không hợp lệ (HTTP 401).';
            } else {
                try {
                    const errJson = await response.json();
                    if (errJson?.error?.message) errMsg = errJson.error.message;
                } catch {}
            }
            return { ok: false, error: errMsg };
        }

        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            let text = data.choices[0].message.content || '';
            text = text.replace(/^```\w*\n?/gi, '').replace(/\n?```$/gi, '').trim();
            return { ok: true, lineIndex, translatedText: text };
        }
        return { ok: false, error: 'Phản hồi từ AI không đúng định dạng' };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

function handleStreamConnection(port) {
    const activeRuns = new Map(); // runId -> AbortController

    const abortRun = (runId) => {
        const controller = activeRuns.get(runId);
        if (controller) {
            try { controller.abort(); } catch {}
            activeRuns.delete(runId);
        }
    };

    port.onDisconnect.addListener(() => {
        void chrome?.runtime?.lastError;
        for (const [runId, controller] of activeRuns.entries()) {
            try { controller.abort(); } catch {}
        }
        activeRuns.clear();
    });

    port.onMessage.addListener(async (msg) => {
        if (!msg) return;

        if (msg.action === 'abort_translation') {
            if (msg.runId) {
                abortRun(msg.runId);
            } else {
                for (const runId of Array.from(activeRuns.keys())) {
                    abortRun(runId);
                }
            }
            safePortPost(port, { type: 'aborted', runId: msg.runId });
            return;
        }

        if (msg.action !== 'start_translation' && msg.action !== 'retranslate_line') return;

        const isRetranslate = msg.action === 'retranslate_line';
        const runId = msg.runId || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        abortRun(runId); // Abort previous in-flight run for the same runId if any

        const controller = new AbortController();
        activeRuns.set(runId, controller);

        try {
            const config = await chrome.storage.local.get([
                'endpoint', 'apikey', 'model', 'prompt', 'stv_active_glossary_profile', 'stvDebugLog'
            ]);

            const apikey = (config.apikey || '').trim();
            if (!apikey) {
                safePortPost(port, {
                    type: 'error',
                    runId,
                    error: 'API key not configured / Chưa cấu hình API Key. Vui lòng mở tiện ích để cài đặt API Key.',
                    code: 401
                });
                activeRuns.delete(runId);
                return;
            }

            const endpoint = config.endpoint || DEFAULT_ENDPOINT;
            const validator = globalThis.STV_UrlValidator || globalThis;
            if (typeof validator.isValidUrl === 'function' && !validator.isValidUrl(endpoint)) {
                safePortPost(port, {
                    type: 'error',
                    runId,
                    error: 'API Endpoint URL không hợp lệ (chỉ hỗ trợ http/https).',
                    code: 400
                });
                activeRuns.delete(runId);
                return;
            }

            const model = config.model || DEFAULT_MODEL;
            const activeProfile = msg.glossaryProfile || config.stv_active_glossary_profile || 'Default';

            const glossaryKey = `stv_glossary_profile_${activeProfile}`;
            const glossaryData = await chrome.storage.local.get([glossaryKey]);
            const glossary = glossaryData[glossaryKey] || {};

            let finalSystemPrompt = '';
            let userMessage = '';
            let sentGlossary = {};

            if (isRetranslate) {
                const origText = String(msg.text || '').trim();
                finalSystemPrompt = 'Dịch câu/đoạn sau sang tiếng Việt. Trả về kết quả dịch thuần túy, KHÔNG có thẻ HTML hay Markdown, KHÔNG giải thích.';
                if (origText && Object.keys(glossary).length > 0) {
                    const matchedTerms = [];
                    for (const [orig, info] of Object.entries(glossary)) {
                        if (orig && info && info.hanviet && origText.includes(orig)) {
                            matchedTerms.push(`${orig} = ${info.hanviet}`);
                            sentGlossary[orig] = info;
                        }
                    }
                    if (matchedTerms.length > 0) {
                        finalSystemPrompt += `\nBắt buộc tuân thủ các thuật ngữ sau:\n${matchedTerms.join('\n')}`;
                    }
                }
                userMessage = origText;
            } else {
                const textChunks = Array.isArray(msg.textChunks) ? msg.textChunks : [];
                const pureTextForAPI = textChunks.join('\n');
                userMessage = pureTextForAPI;
                if (globalThis.STV_GlossaryUtils && typeof globalThis.STV_GlossaryUtils.findMatchingGlossaryTerms === 'function') {
                    sentGlossary = globalThis.STV_GlossaryUtils.findMatchingGlossaryTerms(pureTextForAPI, glossary);
                }
                if (globalThis.STV_GlossaryUtils && typeof globalThis.STV_GlossaryUtils.buildTranslationPromptPayload === 'function') {
                    const built = globalThis.STV_GlossaryUtils.buildTranslationPromptPayload(
                        pureTextForAPI,
                        config.prompt,
                        glossary
                    );
                    finalSystemPrompt = built.finalSystemPrompt;
                    userMessage = built.userMessage;
                }
            }

            if (config.stvDebugLog) {
                console.log('[STV Background Glossary] Sent to API:', {
                    profile: activeProfile,
                    model,
                    count: Object.keys(sentGlossary).length,
                    terms: sentGlossary
                });
                safePortPost(port, {
                    type: 'debug_glossary',
                    runId,
                    stage: 'sent',
                    profile: activeProfile,
                    model,
                    terms: sentGlossary
                });
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apikey}`,
                    'HTTP-Referer': 'https://github.com/stv-extension',
                    'X-Title': 'Quick Novel Translator'
                },
                body: JSON.stringify({
                    model,
                    temperature: msg.options?.temperature ?? 0.5,
                    stream: true,
                    messages: [
                        { role: 'system', content: finalSystemPrompt },
                        { role: 'user', content: userMessage }
                    ]
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                let errorMsg = `HTTP ${response.status}`;
                if (response.status === 402) {
                    errorMsg = 'API OpenRouter báo lỗi 402 Limit (Hết tiền hoặc hết credit).';
                } else if (response.status === 401) {
                    errorMsg = 'API Key không hợp lệ hoặc đã bị vô hiệu hóa (HTTP 401).';
                } else {
                    try {
                        const errJson = await response.json();
                        if (errJson?.error?.message) errorMsg = errJson.error.message;
                    } catch {}
                }
                safePortPost(port, {
                    type: 'error',
                    runId,
                    error: errorMsg,
                    code: response.status
                });
                activeRuns.delete(runId);
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let sseBuffer = '';
            let accumulatedFullText = '';

            const processSseBlock = (textBlock) => {
                for (const rawLine of textBlock.split('\n')) {
                    const trimmed = rawLine.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) continue;
                    const dataStr = (trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5)).trim();
                    if (dataStr === '[DONE]') continue;

                    let parsed;
                    try {
                        parsed = JSON.parse(dataStr);
                    } catch {
                        continue;
                    }

                    if (parsed && parsed.error) {
                        throw new Error(parsed.error.message || 'Lỗi nội bộ từ API');
                    }

                    const delta = parsed?.choices?.[0]?.delta?.content;
                    if (delta != null && delta !== '') {
                        accumulatedFullText += delta;
                        if (!safePortPost(port, { type: 'delta', runId, delta })) {
                            abortRun(runId);
                            return false;
                        }
                    }
                }
                return true;
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (controller.signal.aborted) break;

                sseBuffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
                const lastNl = sseBuffer.lastIndexOf('\n');
                if (lastNl === -1) continue;

                const completePart = sseBuffer.slice(0, lastNl);
                sseBuffer = sseBuffer.slice(lastNl + 1);

                if (!processSseBlock(completePart)) break;
            }

            if (sseBuffer.trim() && !controller.signal.aborted) {
                processSseBlock(sseBuffer);
            }

            if (!controller.signal.aborted) {
                // Tự động lưu glossary từ toàn bộ kết quả dịch hoàn tất trong Background (chỉ khi dịch cả chương)
                if (!isRetranslate) {
                    try {
                        const glossaryRes = await saveGlossaryTermsFromBackground(accumulatedFullText, activeProfile);
                        if (config.stvDebugLog) {
                            const aiReturned = (globalThis.STV_GlossaryUtils && typeof globalThis.STV_GlossaryUtils.extractGlossaryTermsFromFullText === 'function')
                                ? globalThis.STV_GlossaryUtils.extractGlossaryTermsFromFullText(accumulatedFullText)
                                : {};
                            console.log('[STV Background Glossary] AI returned & saved:', {
                                profile: glossaryRes.activeProfile,
                                aiReturned,
                                updated: glossaryRes.updated,
                                skippedTerms: glossaryRes.skippedTerms,
                                totalInProfile: Object.keys(glossaryRes.existingGlossary || {}).length
                            });
                            safePortPost(port, {
                                type: 'debug_glossary',
                                runId,
                                stage: 'received',
                                profile: glossaryRes.activeProfile,
                                aiReturned,
                                updated: glossaryRes.updated,
                                skippedTerms: glossaryRes.skippedTerms,
                                totalInProfile: Object.keys(glossaryRes.existingGlossary || {}).length
                            });
                        }
                    } catch (gErr) {
                        console.warn('[STV Background] saveGlossary error:', gErr);
                    }
                }

                safePortPost(port, {
                    type: 'done',
                    runId
                });
            }
        } catch (err) {
            if (err.name === 'AbortError' || controller.signal.aborted) {
                return;
            }
            safePortPost(port, {
                type: 'error',
                runId,
                error: err?.message || String(err),
                code: 0
            });
        } finally {
            activeRuns.delete(runId);
        }
    });
}

// Stream TTS audio qua Port (vượt CORS & Mixed Content, hỗ trợ hủy tức thì)
// và nhận đăng ký stream preload chương tiếp theo
chrome.runtime.onConnect.addListener((port) => {
    // Broker streaming dịch văn bản cho Content Script (cách ly hoàn toàn API Key trong Background)
    if (port.name === 'stv-translate-stream') {
        handleStreamConnection(port);
        return;
    }
    if (port.name === 'stv-preload-stream') {
        let subscribedEntry = null;
        let portDisconnected = false;
        port.onMessage.addListener(async (msg) => {
            if (!msg || msg.type !== 'subscribe') return;
            const entry = preloadedChapters.get(msg.preloadId) || await getOrRestorePreloadEntry(msg.preloadId);
            if (portDisconnected) return;
            if (!entry) {
                safePortPost(port, { type: 'error', error: 'Preload entry not found' });
                return;
            }
            subscribedEntry = entry;
            entry.subscribers.add(port);
            if (entry.status === 'error') {
                safePortPost(port, { type: 'error', error: entry.error || 'Preload failed' });
            } else if (entry.status === 'ready') {
                safePortPost(port, {
                    type: 'snapshot',
                    fullText: entry.fullText,
                    origChunks: entry.origChunks || [],
                    nextUrl: entry.nextNextUrl || null,
                    done: true,
                    glossarySaved: entry.glossarySaved,
                    glossaryDebug: entry.glossaryDebug || null
                });
            } else {
                safePortPost(port, { type: 'snapshot', fullText: entry.fullText, done: false, glossarySaved: false });
            }
        });
        port.onDisconnect.addListener(() => {
            void chrome?.runtime?.lastError;
            portDisconnected = true;
            if (subscribedEntry && subscribedEntry.subscribers) {
                subscribedEntry.subscribers.delete(port);
            }
        });
        return;
    }
    if (port.name !== 'stv-tts-stream') return;

    let activeController = null;
    let disconnected = false;

    const abortCurrent = () => {
        if (activeController) {
            activeController.abort();
            activeController = null;
        }
    };

    port.onDisconnect.addListener(() => {
        void chrome?.runtime?.lastError;
        disconnected = true;
        abortCurrent();
    });

    port.onMessage.addListener(async (msg) => {
        if (!msg) return;
        if (msg.type === 'abort') {
            abortCurrent();
            return;
        }
        if (msg.type !== 'start') return;

        abortCurrent();
        activeController = new AbortController();
        const controller = activeController;

        const serverUrl = normalizeServerUrl(msg.serverUrl);
        const sampleRate = Number(msg.sampleRate) || 48000;
        const s = msg.sampling && typeof msg.sampling === 'object' ? msg.sampling : {};
        const clamp = (val, min, max, fallback) => {
            const num = Number(val);
            return Number.isFinite(num) ? Math.max(min, Math.min(max, num)) : fallback;
        };
        const body = {
            model: 'vieneu-v3-turbo',
            input: msg.text || '',
            response_format: 'pcm',
            stream_format: 'sse',
            sample_rate: sampleRate,
            temperature: clamp(s.temperature, 0.0, 2.0, 0.4),
            top_k: Math.round(clamp(s.top_k, 1, 1024, 12)),
            top_p: clamp(s.top_p, 0.01, 1.0, 0.85),
            repetition_penalty: clamp(s.repetition_penalty, 1.0, 2.0, 1.05),
            max_chars: Math.round(clamp(s.max_chars, 64, 512, 280))
        };
        if (msg.voice) {
            body.voice = msg.voice;
        }

        try {
            const ttsCfg = await chrome.storage.local.get(['ttsApiKey', 'stvDebugLog']);
            const resolvedApiKey = (msg.apiKey !== undefined && msg.apiKey !== '') ? msg.apiKey : (ttsCfg.ttsApiKey || '');
            if (ttsCfg.stvDebugLog) {
                console.log('[STV Background TTS] POST /v1/audio/speech', {
                    serverUrl,
                    voice: body.voice || '(default)',
                    sample_rate: body.sample_rate,
                    temperature: body.temperature,
                    repetition_penalty: body.repetition_penalty,
                    textLen: body.input.length
                });
            }
            const response = await fetch(`${serverUrl}/v1/audio/speech`, {
                method: 'POST',
                headers: buildAuthHeaders(resolvedApiKey, { 'Content-Type': 'application/json' }),
                body: JSON.stringify(body),
                signal: controller.signal
            });

            if (!response.ok) {
                const errJson = await response.json().catch(() => null);
                const errMsg = errJson?.error?.message || `VieNeu API trả lỗi HTTP ${response.status}`;
                throw new Error(errMsg);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let sseBuffer = '';
            let sentDone = false;

            const processSseLines = (textBlock) => {
                for (const rawLine of textBlock.split('\n')) {
                    const line = rawLine.trim();
                    if (!line || !line.startsWith('data:')) continue;
                    const jsonStr = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
                    if (!jsonStr || jsonStr === '[DONE]') continue;

                    try {
                        const ev = JSON.parse(jsonStr);
                        if (ev.type === 'speech.audio.delta' && ev.audio) {
                            const chunkSampleRate = Number(ev.sample_rate || ev.sampleRate) || sampleRate;
                            if (!safePortPost(port, { type: 'chunk', audio: ev.audio, sampleRate: chunkSampleRate })) {
                                abortCurrent();
                                return false;
                            }
                        } else if (ev.type === 'speech.audio.done') {
                            sentDone = true;
                            safePortPost(port, { type: 'done', usage: ev.usage || null });
                        }
                    } catch {
                        // Bỏ qua frame SSE không hợp lệ
                    }
                }
                return true;
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (disconnected || controller.signal.aborted) break;

                sseBuffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
                const lastNl = sseBuffer.lastIndexOf('\n');
                if (lastNl === -1) continue;

                const completePart = sseBuffer.slice(0, lastNl);
                sseBuffer = sseBuffer.slice(lastNl + 1);
                if (!processSseLines(completePart)) return;
            }

            if (sseBuffer.trim() && !disconnected && !controller.signal.aborted) {
                if (!processSseLines(sseBuffer)) return;
            }

            if (!sentDone && !disconnected && !controller.signal.aborted) {
                safePortPost(port, { type: 'done', usage: null });
            }
        } catch (err) {
            if (err.name === 'AbortError' || disconnected) return;
            const friendly = /Failed to fetch|NetworkError/i.test(err.message)
                ? `Không kết nối được tới VieNeu server (${serverUrl}). Hãy bật Server trong Popup trước.`
                : err.message;
            safePortPost(port, { type: 'error', error: friendly });
        } finally {
            if (activeController === controller) {
                activeController = null;
            }
        }
    });
});

async function runTranslationSequence(tabId, options = {}) {
    // Tiêm một hàm helper để ghi log trực tiếp ra màn hình Toast của web (nếu cần)
    async function notifyTab(msg, type = 'info') {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: (text, toastType) => {
                    if (typeof window.STV_showToast === 'function') {
                        window.STV_showToast(text, toastType, 3000);
                        return;
                    }
                    const t = document.getElementById('stv-shortcut-toast');
                    if (t) { t.innerText = text; }
                },
                args: [msg, type]
            });
        } catch (e) { }
    }

    try {
        await notifyTab("Đang kiểm tra cấu hình...");
        const config = await chrome.storage.local.get([
            'apikey', 'fontSize', 'fontFamily', 'lineHeight', 'ttsAutoPlay', 'stv_locale'
        ]);
        if (!config.apikey || config.apikey.trim() === '') {
            await notifyTab("Lỗi: Không có API Key!", 'error');
            return "no_api_key";
        }

        await notifyTab("Đang trích xuất văn bản...");
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['i18n.js', 'page-ui.js', 'extractor.js']
        });

        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: (loc) => {
                if (loc && window.STV_I18n && typeof window.STV_I18n.setLocale === 'function') {
                    window.STV_I18n.setLocale(loc);
                }
            },
            args: [config.stv_locale || '']
        });

        const extractedHtmlChunks = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: async () => {
                if (typeof window.STV_extractChapterTextChunks === 'undefined') return { error: "Không nạp được extractor" };
                return await window.STV_extractChapterTextChunks();
            }
        });

        if (!extractedHtmlChunks || !extractedHtmlChunks[0]) {
            await notifyTab("Lỗi: Không lấy được kết quả từ Extractor (Chrome Scripting chặn).");
            return "chrome_scripting_error";
        }

        const htmlChunks = extractedHtmlChunks[0].result;

        if (htmlChunks && htmlChunks.error) {
            await notifyTab("Lỗi nội bộ Extractor: " + htmlChunks.error);
            return "extractor_error";
        }

        if (!htmlChunks || htmlChunks.length === 0) {
            await notifyTab("Chưa xác định vùng chọn, Mở Picker...");
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['picker.js']
            });
            return "auto_pick_started";
        }

        await notifyTab(`Tìm thấy ${htmlChunks.length} dòng. Khởi động AI...`);
        let currentFontSize = config.fontSize || '22';
        if (/^\d+$/.test(currentFontSize)) currentFontSize += 'px';
        let currentLineHeight = config.lineHeight || '1.8';
        let currentFontFamily = config.fontFamily || 'Be Vietnam Pro';

        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['glossary-utils.js', 'translator.js']
        });

        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: (chunks, fSize, lHeight, fFamily, opts) => {
                if (typeof window.STV_startTranslation === 'undefined') {
                    if (typeof window.STV_showToast === 'function') {
                        window.STV_showToast("novel-translator ERROR: Module translator.js chưa sẵn sàng!", 'error');
                    }
                    return;
                }
                window.STV_startTranslation(chunks, fSize, lHeight, fFamily, opts || {});
            },
            args: [htmlChunks, currentFontSize, currentLineHeight, currentFontFamily, {
                forceAutoPlay: Boolean(options.forceAutoPlay),
                autoPlayAfterTranslate: Boolean(config.ttsAutoPlay)
            }]
        });

        await notifyTab("Đang dịch, vui lòng đợi...");
        return "success";
    } catch (err) {
        console.error("STV Background Error: ", err);
        await notifyTab("Lỗi hệ thống ngầm: " + err.message);
        throw err;
    }
}

async function handleAutoAdvanceOnTabComplete(tabId, pending) {
    try {
        if (!pending || Date.now() - pending.startedAt > 60000) return;

        let selectorKey = '';
        try {
            selectorKey = `stv_selector_${new URL(pending.targetUrl).hostname}`;
        } catch {}
        const selData = selectorKey ? await chrome.storage.local.get([selectorKey]) : {};
        const savedSelector = selectorKey ? (selData[selectorKey] || '') : '';

        // Chờ DOM trang mới tải xong nội dung AJAX (nếu web load động như STV) song song với đợi preload fetching
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['extractor.js']
        });

        let entry = pending.preloadId
            ? (preloadedChapters.get(pending.preloadId) || await getOrRestorePreloadEntry(pending.preloadId))
            : null;
        await Promise.all([
            chrome.scripting.executeScript({
                target: { tabId },
                func: async (sel) => {
                    if (typeof window.STV_waitForContentReady === 'function') {
                        return await window.STV_waitForContentReady(sel, 8000);
                    }
                    return { ready: true };
                },
                args: [savedSelector]
            }).catch(() => null),
            (async () => {
                if (entry && entry.status === 'fetching') {
                    const deadline = Date.now() + 4000;
                    while (entry.status === 'fetching' && Date.now() < deadline) {
                        await new Promise((r) => setTimeout(r, 120));
                    }
                }
            })()
        ]);

        const config = await chrome.storage.local.get(['fontSize', 'fontFamily', 'lineHeight', 'stvDebugLog']);
        let currentFontSize = config.fontSize || '22';
        if (/^\d+$/.test(currentFontSize)) currentFontSize += 'px';
        const currentLineHeight = config.lineHeight || '1.8';
        const currentFontFamily = config.fontFamily || 'Be Vietnam Pro';

        if (pending.mode === 'translate') {
            if (entry && (entry.status === 'translating' || entry.status === 'ready') && Array.isArray(entry.origChunks) && entry.origChunks.length > 0) {
                entry.consumedByPage = true;
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ['i18n.js', 'page-ui.js', 'glossary-utils.js', 'translator.js', 'tts-icon-describer.js', 'tts-player.js']
                });

                const prepRes = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: async (payload) => {
                        if (typeof window.STV_extractChapterTextChunks === 'function' && !window.STV_activeContentBox) {
                            await window.STV_extractChapterTextChunks();
                        }
                        if (!window.STV_activeContentBox || typeof window.STV_startPreloadedTranslation !== 'function') {
                            return { ok: false };
                        }
                        await window.STV_startPreloadedTranslation(payload);
                        return { ok: true };
                    },
                    args: [{
                        origChunks: entry.origChunks,
                        preloadId: entry.preloadId,
                        pureTextForAPI: entry.pureTextForAPI || '',
                        finalSystemPrompt: entry.finalSystemPrompt || '',
                        sentGlossary: entry.sentGlossary || {},
                        activeProfile: entry.activeProfile || 'Default',
                        model: entry.model || '',
                        debugLog: Boolean(config.stvDebugLog),
                        fullText: entry.fullText,
                        status: entry.status,
                        glossarySaved: entry.glossarySaved,
                        glossaryDebug: entry.glossaryDebug || null,
                        fontSize: currentFontSize,
                        lineHeight: currentLineHeight,
                        fontFamily: currentFontFamily,
                        forceAutoPlay: true
                    }]
                });

                if (prepRes && prepRes[0] && prepRes[0].result && prepRes[0].result.ok) {
                    if (entry.status === 'ready') {
                        preloadedChapters.delete(entry.preloadId);
                        await removePreloadEntryFromSession(entry.preloadId);
                    }
                    return;
                }
            }

            // Fallback: dịch trực tiếp và tự phát ngay khi dịch xong dòng đầu
            await runTranslationSequence(tabId, { forceAutoPlay: true });
            return;
        }

        // Chế độ chỉ đọc (truyện tiếng Việt sẵn)
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['i18n.js', 'page-ui.js', 'extractor.js', 'tts-icon-describer.js', 'tts-player.js']
        });
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                if (typeof window.STV_startTTS === 'function') {
                    window.STV_startTTS({ autoTriggered: true, fromAutoAdvance: true });
                }
            }
        });
    } catch (err) {
        console.error('[STV Background] Auto-advance tab load error:', err);
    }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab || !/^https?:\/\//i.test(tab.url || '')) return;
    const pending = await getAndDeletePendingAutoAdvance(tabId);
    if (!pending) return;
    await handleAutoAdvanceOnTabComplete(tabId, pending);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    deletePendingAutoAdvance(tabId);
    cleanupTabPreloads(tabId, null, { forceAll: true });
});

// Phím tắt bàn phím qua commands API (tự động cấp activeTab cho tab đang mở)
if (typeof chrome !== 'undefined' && chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(async (command) => {
        if (command === 'translate-active-tab') {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && tab.id) {
                    await runTranslationSequence(tab.id);
                }
            } catch (err) {
                console.error('[STV Background] Command translation failed:', err);
            }
        }
    });
}

globalThis.STV_TranslationBroker = {
    handleStreamConnection,
    handleRetranslateLine,
    deriveModelsEndpointUrl,
    normalizeFetchedModels
};
