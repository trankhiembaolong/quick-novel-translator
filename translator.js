// translator.js - Content script render streaming kết quả qua Background Broker (không giữ API Key, chống XSS, batch DOM bằng rAF)

(function (global) {
    'use strict';

    function t(key, params) {
        if (global.STV_I18n && typeof global.STV_I18n.t === 'function') {
            return global.STV_I18n.t(key, params);
        }
        return key;
    }

    function notify(msg, type = 'info') {
        if (typeof global.STV_showToast === 'function') {
            global.STV_showToast(msg, type, 4000);
        }
    }

    const GOOGLE_FONTS = {
        'Be Vietnam Pro': 'Be+Vietnam+Pro:wght@400;500;600',
        'Noto Sans Vietnamese': 'Noto+Sans:wght@400;500;600',
        'Roboto': 'Roboto:wght@400;500;700',
        'Inter': 'Inter:wght@400;500;600',
        'Merriweather': 'Merriweather:wght@400;700',
        'Source Serif Pro': 'Source+Serif+Pro:wght@400;600'
    };

    function STV_applyReaderLayoutStyles(contentBox, fontSize = '22px', lineHeight = '1.8', fontFamily = 'Be Vietnam Pro') {
        if (!document.getElementById('stv-custom-styles')) {
            const styleEl = document.createElement('style');
            styleEl.id = 'stv-custom-styles';
            styleEl.textContent = `
                .stv-line {
                    cursor: pointer;
                    border-radius: 4px;
                    transition: background-color 0.2s, opacity 0.2s;
                    display: inline-block;
                    min-width: 50%;
                }
                .stv-line:hover {
                    background-color: rgba(79, 70, 229, 0.12) !important;
                }
                .stv-line.stv-retranslating {
                    opacity: 0.55;
                    pointer-events: none;
                    background-color: rgba(245, 158, 11, 0.2) !important;
                }
            `;
            document.head.appendChild(styleEl);
        }

        if (!global.STV_retranslateLine) {
            global.STV_retranslateLine = function (spanElement) {
                if (!spanElement || spanElement.classList.contains('stv-retranslating')) return;
                const originalText = spanElement.getAttribute('data-orig');
                if (!originalText || originalText.trim() === '') return;

                spanElement.classList.add('stv-retranslating');
                const previousText = spanElement.textContent;
                spanElement.textContent = t('reader_retranslating_line');

                const runId = `re_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                let port;
                try {
                    port = chrome.runtime.connect({ name: 'stv-translate-stream' });
                } catch (err) {
                    spanElement.textContent = previousText;
                    spanElement.classList.remove('stv-retranslating');
                    notify(err?.message || 'Extension context error', 'error');
                    return;
                }

                let resultText = '';
                let settled = false;

                const finish = (isErr, errMsg = '') => {
                    if (settled) return;
                    settled = true;
                    spanElement.classList.remove('stv-retranslating');
                    try { port.disconnect(); } catch {}
                    if (isErr) {
                        spanElement.textContent = previousText;
                        notify(errMsg || 'Retranslate failed', 'error');
                    } else {
                        const clean = resultText.replace(/^```\w*\n?/gi, '').replace(/\n?```$/gi, '').trim();
                        if (clean) {
                            spanElement.setAttribute('data-trans', clean);
                            spanElement.textContent = clean;
                        } else {
                            spanElement.textContent = previousText;
                        }
                    }
                };

                port.onMessage.addListener((msg) => {
                    if (!msg || msg.runId !== runId) return;
                    if (msg.type === 'delta' && typeof msg.delta === 'string') {
                        resultText += msg.delta;
                    } else if (msg.type === 'done') {
                        finish(false);
                    } else if (msg.type === 'error') {
                        finish(true, msg.error);
                    }
                });

                port.onDisconnect.addListener(() => {
                    void chrome?.runtime?.lastError;
                    if (!settled) {
                        finish(true, 'Connection closed');
                    }
                });

                port.postMessage({
                    action: 'retranslate_line',
                    runId,
                    text: originalText
                });
            };
        }

        if (!global.STV_hasBoundRetranslate) {
            global.STV_hasBoundRetranslate = true;
            document.addEventListener('dblclick', function (e) {
                const spanTarget = e.target.closest('.stv-line');
                if (spanTarget) {
                    e.preventDefault();
                    if (global.getSelection) global.getSelection().removeAllRanges();
                    global.STV_retranslateLine(spanTarget);
                }
            });
        }

        if (GOOGLE_FONTS[fontFamily]) {
            let fontLink = document.getElementById('stv-google-font');
            if (!fontLink) {
                fontLink = document.createElement('link');
                fontLink.id = 'stv-google-font';
                fontLink.rel = 'stylesheet';
                document.head.appendChild(fontLink);
            }
            fontLink.href = `https://fonts.googleapis.com/css2?family=${GOOGLE_FONTS[fontFamily]}&display=swap`;
        }

        contentBox.style.setProperty('font-family', `"${fontFamily}", "Segoe UI", "Roboto", sans-serif`, 'important');
        contentBox.style.setProperty('font-size', fontSize, 'important');
        contentBox.style.setProperty('line-height', lineHeight, 'important');
        contentBox.style.setProperty('word-break', 'keep-all', 'important');
        contentBox.style.setProperty('word-wrap', 'normal', 'important');
        contentBox.style.setProperty('overflow-wrap', 'normal', 'important');
        contentBox.style.setProperty('line-break', 'strict', 'important');
        contentBox.style.setProperty('text-justify', 'none', 'important');
        contentBox.setAttribute('lang', 'vi');
        contentBox.style.setProperty('text-align', 'left', 'important');
        contentBox.style.setProperty('letter-spacing', 'normal', 'important');
        contentBox.style.setProperty('white-space', 'pre-wrap', 'important');
    }

    function STV_createStreamRenderer(contentBox, originalLinesArray, translationRunId, autoPlayEnabled) {
        const lineNodes = [];
        let finalizedNonEmptyCount = 0;
        let finalizedCharCount = 0;
        let earlyAutoPlayTriggered = false;
        let pendingRaf = null;
        let latestFullText = '';
        let latestIsFinal = false;

        // Incremental cursor: tránh split lại toàn bộ các dòng đã hoàn tất ở mỗi token
        let firstUnfinalizedLineIdx = 0;
        let consumedDisplayCharOffset = 0;

        const scheduleFrame = (fn) => {
            if (typeof global.requestAnimationFrame === 'function') {
                return global.requestAnimationFrame(fn);
            }
            return setTimeout(fn, 16);
        };
        const cancelFrame = (id) => {
            if (id === null) return;
            if (typeof global.cancelAnimationFrame === 'function') {
                global.cancelAnimationFrame(id);
            } else {
                clearTimeout(id);
            }
        };

        const triggerAutoPlay = () => {
            if (earlyAutoPlayTriggered || !autoPlayEnabled) return;
            earlyAutoPlayTriggered = true;
            if (typeof global.STV_startTTS === 'function') {
                global.STV_startTTS({ autoTriggered: true });
                return;
            }
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ action: 'vieneu_auto_play' }, () => {
                    void chrome.runtime.lastError;
                });
            }
        };

        const flushRender = (fullText, isFinal = false) => {
            const tempFullText = (fullText || '').replace(/^```\w*\n?/gi, '').replace(/\n?```$/gi, '');
            const glossaryIdx = tempFullText.indexOf('[GLOSSARY]');
            const hasGlossary = glossaryIdx !== -1;
            const mainPart = hasGlossary ? tempFullText.slice(0, glossaryIdx) : tempFullText;

            if (!isFinal && !hasGlossary && !mainPart.includes('[TRANSLATION]') && /^\s*\[/.test(mainPart) && mainPart.length < 24) {
                return;
            }

            let displayContent = mainPart.includes('[TRANSLATION]')
                ? mainPart.slice(mainPart.indexOf('[TRANSLATION]') + '[TRANSLATION]'.length)
                : mainPart;
            displayContent = displayContent.replace(/^\s+/, '');
            if (hasGlossary || isFinal) {
                displayContent = displayContent.trimEnd();
            }

            const tailSlice = consumedDisplayCharOffset <= displayContent.length
                ? displayContent.slice(consumedDisplayCharOffset)
                : displayContent;
            if (consumedDisplayCharOffset > displayContent.length) {
                firstUnfinalizedLineIdx = 0;
                consumedDisplayCharOffset = 0;
            }

            const tailLines = tailSlice ? tailSlice.split('\n') : [];
            const totalLinesCount = firstUnfinalizedLineIdx + tailLines.length;
            const completeLimit = (hasGlossary || isFinal)
                ? totalLinesCount
                : Math.max(firstUnfinalizedLineIdx, totalLinesCount - 1);

            let newlyFinalized = false;

            while (lineNodes.length > totalLinesCount) {
                const popped = lineNodes.pop();
                if (popped.el && popped.el.parentNode) popped.el.parentNode.removeChild(popped.el);
                if (popped.brEl && popped.brEl.parentNode) popped.brEl.parentNode.removeChild(popped.brEl);
            }

            const fragment = document.createDocumentFragment();
            let usedFragment = false;

            const baseUnfinalizedIdx = firstUnfinalizedLineIdx;
            for (let tIdx = 0; tIdx < tailLines.length; tIdx++) {
                const i = baseUnfinalizedIdx + tIdx;
                const lineText = tailLines[tIdx];
                const isLineComplete = i < completeLimit;
                const isEmpty = lineText.trim() === '';
                const origText = i < originalLinesArray.length ? originalLinesArray[i] : '';

                if (i < lineNodes.length) {
                    const node = lineNodes[i];
                    if (node.finalized) {
                        if (i === firstUnfinalizedLineIdx) {
                            firstUnfinalizedLineIdx += 1;
                            consumedDisplayCharOffset += lineText.length + 1;
                        }
                        continue;
                    }

                    if (isEmpty && isLineComplete) {
                        if (node.type === 'line') {
                            const br = document.createElement('br');
                            if (node.el && node.el.parentNode) {
                                node.el.parentNode.replaceChild(br, node.el);
                            } else {
                                contentBox.appendChild(br);
                            }
                            if (node.brEl && node.brEl.parentNode) {
                                node.brEl.parentNode.removeChild(node.brEl);
                            }
                            lineNodes[i] = { type: 'br', el: br, brEl: null, finalized: true, text: '' };
                        } else {
                            node.finalized = true;
                        }
                    } else if (!isEmpty) {
                        if (node.type === 'br') {
                            const span = document.createElement('span');
                            span.className = isLineComplete ? 'stv-line' : 'stv-line stv-line-partial';
                            span.setAttribute('data-orig', origText);
                            span.setAttribute('data-trans', lineText);
                            span.textContent = lineText;
                            const br = document.createElement('br');
                            if (node.el && node.el.parentNode) {
                                node.el.parentNode.replaceChild(br, node.el);
                                contentBox.insertBefore(span, br);
                            } else {
                                contentBox.appendChild(span);
                                contentBox.appendChild(br);
                            }
                            lineNodes[i] = { type: 'line', el: span, brEl: br, finalized: isLineComplete, text: lineText };
                        } else {
                            if (node.text !== lineText) {
                                node.el.textContent = lineText;
                                node.el.setAttribute('data-trans', lineText);
                                node.text = lineText;
                            }
                            if (isLineComplete) {
                                node.el.classList.remove('stv-line-partial');
                                node.finalized = true;
                            }
                        }

                        if (isLineComplete) {
                            finalizedNonEmptyCount += 1;
                            finalizedCharCount += lineText.trim().length;
                            newlyFinalized = true;
                        }
                    }
                } else {
                    if (isEmpty) {
                        const br = document.createElement('br');
                        fragment.appendChild(br);
                        usedFragment = true;
                        lineNodes.push({ type: 'br', el: br, brEl: null, finalized: isLineComplete, text: '' });
                    } else {
                        const span = document.createElement('span');
                        span.className = isLineComplete ? 'stv-line' : 'stv-line stv-line-partial';
                        span.setAttribute('data-orig', origText);
                        span.setAttribute('data-trans', lineText);
                        span.textContent = lineText;
                        const br = document.createElement('br');
                        fragment.appendChild(span);
                        fragment.appendChild(br);
                        usedFragment = true;
                        lineNodes.push({ type: 'line', el: span, brEl: br, finalized: isLineComplete, text: lineText });

                        if (isLineComplete) {
                            finalizedNonEmptyCount += 1;
                            finalizedCharCount += lineText.trim().length;
                            newlyFinalized = true;
                        }
                    }
                }

                if (isLineComplete && i === firstUnfinalizedLineIdx) {
                    firstUnfinalizedLineIdx += 1;
                    consumedDisplayCharOffset += lineText.length + 1;
                }
            }

            if (usedFragment) {
                contentBox.appendChild(fragment);
            }

            if (isFinal) {
                global.STV_translationState = { active: false, runId: translationRunId };
            }
            if (newlyFinalized || isFinal) {
                global.dispatchEvent(new CustomEvent('stv-translation-progress', {
                    detail: {
                        runId: translationRunId,
                        active: !isFinal,
                        finalizedCount: finalizedNonEmptyCount
                    }
                }));
            }

            if ((!isFinal && ((finalizedNonEmptyCount >= 1 && finalizedCharCount >= 45) || (finalizedNonEmptyCount >= 2 && finalizedCharCount >= 30))) || (isFinal && finalizedNonEmptyCount > 0)) {
                triggerAutoPlay();
            }
        };

        const syncText = (fullText, isFinal = false) => {
            latestFullText = fullText;
            latestIsFinal = latestIsFinal || Boolean(isFinal);
            if (isFinal) {
                if (pendingRaf !== null) {
                    cancelFrame(pendingRaf);
                    pendingRaf = null;
                }
                flushRender(latestFullText, true);
                return;
            }
            if (pendingRaf === null) {
                pendingRaf = scheduleFrame(() => {
                    pendingRaf = null;
                    flushRender(latestFullText, latestIsFinal);
                });
            }
        };

        return { syncText, triggerAutoPlay };
    }

    global.STV_toggleOriginalMode = function (showOriginal) {
        const lines = document.querySelectorAll('.stv-line');
        lines.forEach((el) => {
            const orig = el.getAttribute('data-orig');
            const trans = el.getAttribute('data-trans');
            if (showOriginal) {
                if (!trans) el.setAttribute('data-trans', el.textContent);
                if (orig !== null && orig !== '') el.textContent = orig;
            } else {
                if (trans !== null && trans !== '') el.textContent = trans;
            }
        });
    };

    global.STV_setFontSize = function (targetPx) {
        const box = global.STV_activeContentBox;
        if (!box) return;
        const parsed = typeof targetPx === 'number' ? targetPx : parseFloat(targetPx);
        if (!Number.isFinite(parsed)) return;
        const next = Math.max(12, Math.min(42, Math.round(parsed)));
        box.style.setProperty('font-size', `${next}px`, 'important');
    };

    global.STV_adjustFontSize = function (deltaPx) {
        const box = global.STV_activeContentBox;
        if (!box) return;
        const current = parseFloat(global.getComputedStyle(box).fontSize) || 22;
        const next = Math.max(12, Math.min(42, Math.round(current + deltaPx)));
        box.style.setProperty('font-size', `${next}px`, 'important');
    };

    global.STV_startTranslation = async function (htmlChunksFromExtractor, fontSize = '22px', lineHeight = '1.8', fontFamily = 'Be Vietnam Pro', options = {}) {
        if (!global.STV_activeContentBox || !htmlChunksFromExtractor) {
            notify('STV: Không xác định được vùng nội dung.', 'error');
            return;
        }

        const translationRunId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        global.STV_translationState = { active: true, runId: translationRunId };
        if (typeof global.STV_getTTSState === 'function' && global.STV_getTTSState().isPlaying && typeof global.STV_stopTTS === 'function') {
            global.STV_stopTTS();
        }

        const contentBox = global.STV_activeContentBox;
        contentBox.innerHTML = '';
        STV_applyReaderLayoutStyles(contentBox, fontSize, lineHeight, fontFamily);
        if (typeof global.STV_ensureFloatingReaderIcon === 'function') {
            global.STV_ensureFloatingReaderIcon();
        }

        const autoPlayEnabled = Boolean(options.forceAutoPlay || options.autoPlayAfterTranslate);
        const renderer = STV_createStreamRenderer(contentBox, htmlChunksFromExtractor, translationRunId, autoPlayEnabled);

        let fullText = '';
        let settled = false;
        let port;
        try {
            port = chrome.runtime.connect({ name: 'stv-translate-stream' });
        } catch (err) {
            global.STV_translationState = { active: false, runId: translationRunId };
            notify(err?.message || 'Extension context error', 'error');
            return;
        }

        port.onMessage.addListener((msg) => {
            if (!msg || msg.runId !== translationRunId) return;
            if (msg.type === 'debug_glossary') {
                if (msg.stage === 'sent') {
                    const count = Object.keys(msg.terms || {}).length;
                    console.groupCollapsed(`[STV Glossary] Gửi cho API (${msg.profile || 'Default'} | ${count} từ | ${msg.model || ''})`);
                    console.log('Matched terms sent:', msg.terms || {});
                    console.groupEnd();
                } else if (msg.stage === 'received') {
                    const returnedCount = Object.keys(msg.aiReturned || {}).length;
                    console.groupCollapsed(`[STV Glossary] AI trả về & Cập nhật thư viện (${msg.profile || 'Default'} | ${returnedCount} từ | updated=${Boolean(msg.updated)})`);
                    console.log('AI returned [GLOSSARY]:', msg.aiReturned || {});
                    console.log('Updated storage:', Boolean(msg.updated), '| Total in profile:', msg.totalInProfile ?? 0);
                    console.log('Skipped (locked/filtered):', msg.skippedTerms || []);
                    console.groupEnd();
                }
                return;
            }
            if (msg.type === 'delta' && typeof msg.delta === 'string') {
                fullText += msg.delta;
                renderer.syncText(fullText, false);
            } else if (msg.type === 'done') {
                settled = true;
                renderer.syncText(fullText, true);
                try { port.disconnect(); } catch {}
            } else if (msg.type === 'aborted') {
                settled = true;
                global.STV_translationState = { active: false, runId: null };
                global.dispatchEvent(new CustomEvent('stv-translation-progress', {
                    detail: { runId: translationRunId, active: false }
                }));
                try { port.disconnect(); } catch {}
            } else if (msg.type === 'error') {
                settled = true;
                const errText = msg.error || 'Translation failed';
                global.STV_translationState = { active: false, runId: translationRunId, error: errText };
                global.dispatchEvent(new CustomEvent('stv-translation-progress', {
                    detail: { runId: translationRunId, active: false, error: errText }
                }));
                try { port.disconnect(); } catch {}
                notify(errText, 'error');
            }
        });

        port.onDisconnect.addListener(() => {
            void chrome?.runtime?.lastError;
            if (!settled) {
                const errText = 'Mất kết nối tiến trình dịch với extension.';
                global.STV_translationState = { active: false, runId: translationRunId, error: errText };
                global.dispatchEvent(new CustomEvent('stv-translation-progress', {
                    detail: { runId: translationRunId, active: false, error: errText }
                }));
            }
        });

        port.postMessage({
            action: 'start_translation',
            runId: translationRunId,
            textChunks: htmlChunksFromExtractor,
            options: { temperature: 0.5 }
        });
    };

    // Áp dụng bản dịch đã tải & dịch sẵn (hoặc đang stream ngầm từ background.js)
    global.STV_startPreloadedTranslation = async function (payload) {
        if (!payload) return false;

        if (!global.STV_activeContentBox && typeof global.STV_extractChapterTextChunks === 'function') {
            await global.STV_extractChapterTextChunks();
        }
        const contentBox = global.STV_activeContentBox;
        if (!contentBox) return false;

        let fontSize = payload.fontSize || '22px';
        if (/^\d+$/.test(fontSize)) fontSize += 'px';
        const lineHeight = payload.lineHeight || '1.8';
        const fontFamily = payload.fontFamily || 'Be Vietnam Pro';

        const translationRunId = `pre_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const initiallyDone = payload.status === 'ready';
        global.STV_translationState = { active: !initiallyDone, runId: translationRunId };
        if (typeof global.STV_getTTSState === 'function' && global.STV_getTTSState().isPlaying && typeof global.STV_stopTTS === 'function') {
            global.STV_stopTTS();
        }

        const originalLines = Array.isArray(payload.origChunks) ? payload.origChunks : [];
        contentBox.innerHTML = '';
        STV_applyReaderLayoutStyles(contentBox, fontSize, lineHeight, fontFamily);
        if (typeof global.STV_ensureFloatingReaderIcon === 'function') {
            global.STV_ensureFloatingReaderIcon();
        }

        const logPreloadGlossary = (stage, gd) => {
            if (!payload.debugLog) return;
            if (stage === 'sent') {
                const terms = (gd && gd.sentGlossary) || payload.sentGlossary || {};
                const profile = (gd && gd.activeProfile) || payload.activeProfile || 'Default';
                const model = (gd && gd.model) || payload.model || '';
                console.groupCollapsed(`[STV Glossary] (Preload) Gửi cho API (${profile} | ${Object.keys(terms).length} từ | ${model})`);
                console.log('Matched terms sent:', terms);
                console.groupEnd();
            } else if (stage === 'received' && gd) {
                const aiRet = gd.aiReturned || {};
                console.groupCollapsed(`[STV Glossary] (Preload) AI trả về & Cập nhật thư viện (${gd.activeProfile || 'Default'} | ${Object.keys(aiRet).length} từ | updated=${Boolean(gd.updated)})`);
                console.log('AI returned [GLOSSARY]:', aiRet);
                console.log('Updated storage:', Boolean(gd.updated), '| Total in profile:', gd.totalInProfile ?? Object.keys(gd.existingGlossary || {}).length);
                console.log('Skipped (locked/filtered):', gd.skippedTerms || []);
                console.groupEnd();
            }
        };

        logPreloadGlossary('sent', payload.glossaryDebug);
        if (initiallyDone && payload.glossaryDebug) {
            logPreloadGlossary('received', payload.glossaryDebug);
        }

        const renderer = STV_createStreamRenderer(contentBox, originalLines, translationRunId, payload.forceAutoPlay !== false);

        let fullText = payload.fullText || '';
        if (fullText) {
            renderer.syncText(fullText, initiallyDone);
        }

        if (initiallyDone) {
            return true;
        }

        let completedHandled = false;
        const port = chrome.runtime.connect({ name: 'stv-preload-stream' });
        port.onMessage.addListener((msg) => {
            if (!msg) return;
            if (msg.type === 'snapshot') {
                fullText = msg.fullText || '';
                renderer.syncText(fullText, Boolean(msg.done));
                if (msg.done && !completedHandled) {
                    completedHandled = true;
                    if (msg.glossaryDebug) logPreloadGlossary('received', msg.glossaryDebug);
                    try { port.disconnect(); } catch {}
                }
            } else if (msg.type === 'delta') {
                if (typeof msg.delta === 'string') {
                    fullText += msg.delta;
                } else if (typeof msg.fullText === 'string') {
                    fullText = msg.fullText;
                }
                renderer.syncText(fullText, Boolean(msg.done));
                if (msg.done && !completedHandled) {
                    completedHandled = true;
                    if (msg.glossaryDebug) logPreloadGlossary('received', msg.glossaryDebug);
                    try { port.disconnect(); } catch {}
                }
            } else if (msg.type === 'error') {
                completedHandled = true;
                global.STV_translationState = { active: false, runId: translationRunId };
                global.dispatchEvent(new CustomEvent('stv-translation-progress', {
                    detail: { runId: translationRunId, active: false }
                }));
                try { port.disconnect(); } catch {}
                notify(msg.error || 'Preload failed', 'error');
            }
        });
        port.onDisconnect.addListener(() => {
            void chrome?.runtime?.lastError;
            if (!completedHandled && global.STV_translationState && global.STV_translationState.runId === translationRunId) {
                global.STV_translationState = { active: false, runId: translationRunId };
                global.dispatchEvent(new CustomEvent('stv-translation-progress', {
                    detail: { runId: translationRunId, active: false }
                }));
            }
        });
        port.postMessage({ type: 'subscribe', preloadId: payload.preloadId });
        return true;
    };

    global.STV_applyReaderLayoutStyles = STV_applyReaderLayoutStyles;
    global.STV_createStreamRenderer = STV_createStreamRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
