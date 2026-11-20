// tts-player.js - Trình phát audio streaming VieNeu-TTS & Floating Mini-Player trên trang truyện
(function (global) {
    'use strict';

    const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
    const DEFAULT_SAMPLE_RATE = 48000;
    const EXPORT_SAMPLE_RATE = 24000;
    const EXPORT_MAX_CHUNK_CHARS = 210;
    const EXPORT_CONCURRENCY = 3;
    const COLAB_TIER_CONFIG = {
        T4: { tier: 'T4', workers: 6, maxChunkChars: 300 },
        L4: { tier: 'L4', workers: 8, maxChunkChars: 320 },
        A100: { tier: 'A100', workers: 12, maxChunkChars: 350 },
        auto: { tier: 'auto', workers: 6, maxChunkChars: 300, maxAutoWorkers: 12 }
    };
    const DEFAULT_DOWNLOAD_MINUTES = 30;
    const MAX_EXPORT_CHAPTERS = 30;

    function getColabGpuExportConfig(tier = 'T4', healthData = null) {
        const raw = String(tier || 'T4').trim().toUpperCase();
        const key = raw === 'AUTO' ? 'auto' : (COLAB_TIER_CONFIG[raw] ? raw : 'T4');
        const base = COLAB_TIER_CONFIG[key];
        let workers = base.workers;
        if (healthData && typeof healthData === 'object') {
            const reported = Number(healthData.export_max_streams || healthData.max_streams || healthData.workers);
            if (Number.isFinite(reported) && reported >= 1) {
                const cap = key === 'auto' ? (base.maxAutoWorkers || 12) : base.workers;
                workers = Math.max(1, Math.min(cap, Math.floor(reported)));
            }
        }
        return {
            tier: base.tier,
            workers,
            maxChunkChars: base.maxChunkChars
        };
    }
    const MAX_CHUNK_CHARS = 240;
    const FIRST_CHUNK_PREROLL_SEC = 0.04;
    const CONTINUATION_PREROLL_SEC = 0.015;
    const WSOLA_LEAD_PAD_SEC = 0.025;
    const PREFETCH_AHEAD_COUNT = 2;
    const MIN_PREFETCH_CHARS = 220;
    const MAX_PREFETCH_SEGMENTS = 3;
    const ANCHOR_PREFIX = 'Một. ';

    function formatTtsInputText(text) {
        const trimmed = (text || '').trim();
        if (!trimmed) return '';
        return trimmed.startsWith(ANCHOR_PREFIX) ? trimmed : `${ANCHOR_PREFIX}${trimmed}`;
    }

    /**
     * Bộ lọc cắt bỏ từ mồi "Một." ở đầu stream dựa vào khoảng lặng tự nhiên phía sau nó,
     * giúp âm tiết đầu thật sự của chunk luôn bắt đầu mượt mà không bị model nuốt phụ âm đầu.
     */
    function createAnchorTrimmer(sampleRate) {
        const sr = sampleRate || DEFAULT_SAMPLE_RATE;
        const hop = Math.max(160, Math.round(sr * 0.01)); // 10ms frame
        const maxScanFrames = 85; // tối đa 0.85s fail-safe
        let chunks = [];
        let totalSamples = 0;
        let done = false;
        let anchorStart = -1;
        let valleyStart = -1;
        let scannedFrames = 0;
        const rem = new Float32Array(hop);
        let remLen = 0;

        const sliceFromSample = (startSample) => {
            const safeStart = Math.max(0, Math.min(totalSamples, startSample));
            let result;
            if (chunks.length === 0 || safeStart >= totalSamples) {
                result = new Float32Array(0);
            } else if (chunks.length === 1) {
                result = safeStart === 0 ? chunks[0] : chunks[0].subarray(safeStart);
            } else {
                const outLen = totalSamples - safeStart;
                const merged = new Float32Array(outLen);
                let srcOffset = 0;
                let dstOffset = 0;
                for (let i = 0; i < chunks.length; i++) {
                    const c = chunks[i];
                    const end = srcOffset + c.length;
                    if (end > safeStart) {
                        const from = Math.max(0, safeStart - srcOffset);
                        const slice = from === 0 ? c : c.subarray(from);
                        merged.set(slice, dstOffset);
                        dstOffset += slice.length;
                    }
                    srcOffset = end;
                }
                result = merged;
            }
            chunks = [];
            totalSamples = 0;
            remLen = 0;
            return result;
        };

        const evalFrameRms = (buf, base) => {
            let sum = 0;
            for (let k = 0; k < hop; k++) {
                const v = buf[base + k];
                sum += v * v;
            }
            const rms = Math.sqrt(sum / hop);
            const f = scannedFrames;
            scannedFrames += 1;

            if (anchorStart === -1) {
                if (f < 55 && rms > 0.02) {
                    anchorStart = f;
                }
                return -1;
            }
            if (f < anchorStart + 8) return -1;
            if (rms < 0.012) {
                if (valleyStart === -1) valleyStart = f;
                return -1;
            }
            if (valleyStart !== -1 && (f - valleyStart) >= 7) {
                return Math.max(valleyStart + 2, f - 3);
            }
            valleyStart = -1;
            return -1;
        };

        return {
            push(rawChunk) {
                if (!rawChunk || rawChunk.length === 0) return null;
                if (done) return rawChunk;

                chunks.push(rawChunk);
                totalSamples += rawChunk.length;

                let pos = 0;
                if (remLen > 0) {
                    const take = Math.min(hop - remLen, rawChunk.length);
                    rem.set(rawChunk.subarray(0, take), remLen);
                    remLen += take;
                    pos += take;
                    if (remLen === hop) {
                        remLen = 0;
                        const cutFrame = evalFrameRms(rem, 0);
                        if (cutFrame !== -1) {
                            done = true;
                            return sliceFromSample(cutFrame * hop);
                        }
                        if (scannedFrames >= maxScanFrames) {
                            done = true;
                            const cut = (valleyStart !== -1 && (scannedFrames - valleyStart) >= 7)
                                ? (valleyStart + 2) * hop
                                : 0;
                            return sliceFromSample(cut);
                        }
                    }
                }

                while (pos + hop <= rawChunk.length) {
                    const cutFrame = evalFrameRms(rawChunk, pos);
                    pos += hop;
                    if (cutFrame !== -1) {
                        done = true;
                        return sliceFromSample(cutFrame * hop);
                    }
                    if (scannedFrames >= maxScanFrames) {
                        done = true;
                        const cut = (valleyStart !== -1 && (scannedFrames - valleyStart) >= 7)
                            ? (valleyStart + 2) * hop
                            : 0;
                        return sliceFromSample(cut);
                    }
                }

                if (pos < rawChunk.length) {
                    const left = rawChunk.length - pos;
                    rem.set(rawChunk.subarray(pos), 0);
                    remLen = left;
                }
                return null;
            },
            flush() {
                if (done || totalSamples === 0) return null;
                done = true;
                if (valleyStart !== -1 && (scannedFrames - valleyStart) >= 7) {
                    return sliceFromSample((valleyStart + 2) * hop);
                }
                return sliceFromSample(0);
            }
        };
    }

    function getIconDescriber() {
        return global.STV_IconDescriber || (typeof globalThis !== 'undefined' ? globalThis.STV_IconDescriber : null) || null;
    }

    function ensureSentenceEnding(text) {
        if (!text) return '';
        return /[.!?…;:"”’)\]]$/u.test(text) ? text : `${text}.`;
    }

    function appendPackedSegment(targetSegments, rawText, domEl, minLockedIndex = 0, iconOptions = null) {
        const describer = getIconDescriber();
        const effectiveRaw = (typeof rawText === 'string') ? rawText : '';

        let prep = null;
        let cleaned = '';
        if (describer) {
            prep = describer.prepareTextForTTS(effectiveRaw, iconOptions || { mode: 'local', style: 'tagged' });
            if (prep.needsAi && effectiveRaw.length > MAX_CHUNK_CHARS) {
                const rawSentences = effectiveRaw.split(/(?<=[.!?;。！？])\s+/).filter(Boolean);
                if (rawSentences.length > 1) {
                    let splitAdded = 0;
                    for (const s of rawSentences) {
                        splitAdded += appendPackedSegment(targetSegments, s, domEl, minLockedIndex, iconOptions);
                    }
                    return splitAdded;
                }
            }
            cleaned = cleanTextForSpeech(prep.text, { _skipIconDescribe: true });
        } else {
            cleaned = cleanTextForSpeech(effectiveRaw);
        }
        if (!cleaned) return 0;

        const parts = splitLongTextForTTS(cleaned);
        const isSinglePart = parts.length === 1;
        const needsAi = Boolean(prep && prep.needsAi && isSinglePart);
        let added = 0;
        for (const part of parts) {
            if (!needsAi && targetSegments.length > minLockedIndex) {
                const prev = targetSegments[targetSegments.length - 1];
                // Chỉ gộp các phần thuộc cùng 1 thẻ DOM và không trộn với đoạn chờ AI giải mã icon
                if (!prev.needsAiIconResolve && (!domEl || prev.domElement === domEl)) {
                    const prefix = ensureSentenceEnding(prev.text);
                    if (prefix.length + 1 + part.length <= MAX_CHUNK_CHARS) {
                        prev.text = `${prefix} ${part}`;
                        if (isSinglePart && prev.rawText !== undefined) {
                            prev.rawText = `${ensureSentenceEnding(prev.rawText)} ${effectiveRaw}`;
                        } else {
                            delete prev.rawText;
                        }
                        continue;
                    }
                }
            }
            const segObj = {
                text: part,
                domElement: domEl || null,
                domElements: domEl ? [domEl] : []
            };
            if (isSinglePart) {
                segObj.rawText = (prep && prep.aiText) ? prep.aiText : effectiveRaw;
            }
            if (needsAi) {
                segObj.needsAiIconResolve = true;
                segObj.aiRawText = (prep && prep.aiText) ? prep.aiText : effectiveRaw;
                segObj.iconTokens = (prep && prep.aiTokens) || prep.tokens || [];
                segObj.iconLang = prep.lang || 'vi';
                segObj.iconResolveState = 'pending';
                segObj.iconResolvePromise = null;
            }
            targetSegments.push(segObj);
            added += 1;
        }
        return added;
    }

    const SAMPLING_PROFILES = {
        balanced: { temperature: 0.4, top_k: 12, top_p: 0.85, repetition_penalty: 1.05, max_chars: 280 },
        strict: { temperature: 0.25, top_k: 8, top_p: 0.8, repetition_penalty: 1.05, max_chars: 280 },
        natural: { temperature: 0.8, top_k: 25, top_p: 0.95, repetition_penalty: 1.05, max_chars: 280 }
    };

    function getSamplingParams(profileName) {
        const key = (profileName && SAMPLING_PROFILES[profileName]) ? profileName : 'balanced';
        return { ...SAMPLING_PROFILES[key] };
    }

    function cleanTextForSpeech(raw, iconOptions = null) {
        if (!raw || typeof raw !== 'string') return '';
        const describer = getIconDescriber();
        let source = raw;
        if (describer && !(iconOptions && iconOptions._skipIconDescribe)) {
            const prep = describer.prepareTextForTTS(raw, iconOptions || { mode: 'local', style: 'tagged' });
            source = prep.text;
            if (!source) return '';
        }
        let text = source
            .normalize('NFC')
            .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
            .replace(/\u00A0/g, ' ')
            .replace(/[“”„‟]/g, '"')
            .replace(/[‘’‚‛]/g, "'")
            .replace(/…/g, '...')
            .replace(/[*=_~#`]{2,}/g, ' ')
            .replace(/[—–]{2,}/g, ', ')
            .replace(/\s+/g, ' ')
            .trim();

        // Bỏ qua dòng chỉ toàn dấu câu hoặc ký tự trang trí
        if (!text || !/[\p{L}\p{N}]/u.test(text)) {
            return '';
        }
        return text;
    }

    function splitLongTextForTTS(text, maxLen = MAX_CHUNK_CHARS) {
        if (!text || text.length <= maxLen) return text ? [text] : [];

        const sentences = text.split(/(?<=[.!?;。！？])\s+/);
        const chunks = [];
        let current = '';

        const pushChunk = (s) => {
            const trimmed = s.trim();
            if (trimmed && /[\p{L}\p{N}]/u.test(trimmed)) {
                chunks.push(trimmed);
            }
        };

        for (const sentence of sentences) {
            if (!sentence) continue;
            if ((current ? current.length + 1 : 0) + sentence.length <= maxLen) {
                current = current ? `${current} ${sentence}` : sentence;
                continue;
            }
            if (current) {
                pushChunk(current);
                current = '';
            }
            if (sentence.length <= maxLen) {
                current = sentence;
            } else {
                // Câu đơn vẫn quá dài -> cắt theo dấu phẩy hoặc khoảng trắng
                const subParts = sentence.split(/(?<=[,，、:])\s+/);
                for (const part of subParts) {
                    if ((current ? current.length + 1 : 0) + part.length <= maxLen) {
                        current = current ? `${current} ${part}` : part;
                    } else {
                        if (current) pushChunk(current);
                        if (part.length <= maxLen) {
                            current = part;
                        } else {
                            let rest = part;
                            while (rest.length > maxLen) {
                                let cut = rest.lastIndexOf(' ', maxLen);
                                if (cut < Math.floor(maxLen * 0.5)) cut = maxLen;
                                pushChunk(rest.slice(0, cut));
                                rest = rest.slice(cut).trim();
                            }
                            current = rest;
                        }
                    }
                }
            }
        }
        if (current) pushChunk(current);
        return chunks;
    }

    const IS_LITTLE_ENDIAN = new Uint8Array(new Int16Array([1]).buffer)[0] === 1;
    const INV_INT16_SCALE = 1 / 32768;

    function decodePcm16Base64ToFloat32(base64Str) {
        const binary = atob(base64Str);
        const evenLen = binary.length - (binary.length % 2);
        const sampleCount = evenLen / 2;
        const float32 = new Float32Array(sampleCount);
        const bytes = new Uint8Array(evenLen);
        for (let i = 0; i < evenLen; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        if (IS_LITTLE_ENDIAN) {
            const int16 = new Int16Array(bytes.buffer, 0, sampleCount);
            for (let i = 0; i < sampleCount; i++) {
                float32[i] = int16[i] * INV_INT16_SCALE;
            }
        } else {
            const view = new DataView(bytes.buffer);
            for (let i = 0; i < sampleCount; i++) {
                float32[i] = view.getInt16(i * 2, true) * INV_INT16_SCALE;
            }
        }
        return float32;
    }

    /**
     * WSOLA (Waveform Similarity Overlap-Add) time-stretcher.
     * Thay đổi tốc độ phát (0.8x - 2.0x) mà vẫn giữ nguyên cao độ giọng gốc.
     */
    class WSOLAProcessor {
        constructor(sampleRate, speed) {
            this.sampleRate = sampleRate || DEFAULT_SAMPLE_RATE;
            this.speed = Math.max(0.5, Math.min(2.5, Number(speed) || 1.0));
            const baseWin = Math.max(256, Math.round(this.sampleRate * 0.030));
            this.winLen = baseWin + (baseWin % 2);
            this.synHop = this.winLen / 2;
            this.searchRadius = Math.max(32, Math.round(this.sampleRate * 0.009));

            this.win = new Float32Array(this.winLen);
            for (let i = 0; i < this.winLen; i++) {
                this.win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.winLen));
            }

            this.inputBuf = new Float32Array(Math.max(4096, this.winLen * 4));
            this.inputLen = 0;
            this.inPos = 0;
            this.tailOverlap = new Float32Array(this.synHop);
            this.refSlice = new Float32Array(this.synHop);
            this.hasStarted = false;
            this.leadPadDone = false;
        }

        _appendInput(chunk) {
            if (!chunk || chunk.length === 0) return;
            const needed = this.inputLen + chunk.length;
            if (needed > this.inputBuf.length) {
                const nextCap = Math.max(this.inputBuf.length * 2, needed);
                const grown = new Float32Array(nextCap);
                if (this.inputLen > 0) {
                    grown.set(this.inputBuf.subarray(0, this.inputLen), 0);
                }
                this.inputBuf = grown;
            }
            this.inputBuf.set(chunk, this.inputLen);
            this.inputLen = needed;
        }

        _findBestMatch(targetPos) {
            const center = Math.round(targetPos);
            const maxAllowed = Math.max(0, this.inputLen - this.winLen);
            if (!this.hasStarted) return Math.max(0, Math.min(maxAllowed, center));

            const minStart = Math.max(0, center - this.searchRadius);
            const maxStart = Math.min(maxAllowed, center + this.searchRadius);
            if (maxStart <= minStart) return minStart;

            const len = this.synHop;
            const ref = this.refSlice;
            const buf = this.inputBuf;

            // Tìm vị trí lệch tối ưu có độ tương đồng pha cao nhất qua 3 mức coarse -> medium -> fine
            const scoreAt = (pos, stride) => {
                let cross = 0;
                let energy = 1e-9;
                for (let i = 0; i < len; i += stride) {
                    const s = buf[pos + i];
                    cross += s * ref[i];
                    energy += s * s;
                }
                return cross / Math.sqrt(energy);
            };

            const centerClamped = Math.max(minStart, Math.min(maxStart, center));
            const coarseStep = this.searchRadius >= 64 ? 8 : 2;
            const coarseStride = len >= 256 ? 4 : 2;

            let bestPos = centerClamped;
            let bestScore = scoreAt(centerClamped, coarseStride) * 1.02;

            for (let pos = minStart; pos <= maxStart; pos += coarseStep) {
                const score = scoreAt(pos, coarseStride);
                if (score > bestScore) {
                    bestScore = score;
                    bestPos = pos;
                }
            }

            if (coarseStep > 2) {
                const medMin = Math.max(minStart, bestPos - coarseStep);
                const medMax = Math.min(maxStart, bestPos + coarseStep);
                for (let pos = medMin; pos <= medMax; pos += 2) {
                    const score = scoreAt(pos, coarseStride);
                    if (score > bestScore) {
                        bestScore = score;
                        bestPos = pos;
                    }
                }
            }

            const fineMin = Math.max(minStart, bestPos - 1);
            const fineMax = Math.min(maxStart, bestPos + 1);
            bestScore = scoreAt(bestPos, 2);
            if (bestPos === centerClamped) bestScore *= 1.02;
            for (let pos = fineMin; pos <= fineMax; pos++) {
                if (pos === bestPos) continue;
                let score = scoreAt(pos, 2);
                if (pos === centerClamped) score *= 1.02;
                if (score > bestScore) {
                    bestScore = score;
                    bestPos = pos;
                }
            }

            return bestPos;
        }

        _synthStepInto(out, outOffset) {
            const bestPos = this._findBestMatch(this.inPos);
            const hop = this.synHop;
            const buf = this.inputBuf;
            const win = this.win;
            const tail = this.tailOverlap;
            const ref = this.refSlice;

            if (!this.hasStarted) {
                for (let i = 0; i < hop; i++) {
                    out[outOffset + i] = buf[bestPos + i];
                }
                this.hasStarted = true;
            } else {
                for (let i = 0; i < hop; i++) {
                    out[outOffset + i] = tail[i] + buf[bestPos + i] * win[i];
                }
            }

            for (let i = 0; i < hop; i++) {
                const sample = buf[bestPos + hop + i];
                tail[i] = sample * win[hop + i];
                ref[i] = sample;
            }

            this.inPos += hop * this.speed;
            return hop;
        }

        process(chunk) {
            if (!chunk || chunk.length === 0) return new Float32Array(0);
            if (Math.abs(this.speed - 1.0) < 0.001) return chunk;

            // Đệm im lặng trước chunk đầu tiên để WSOLA không xén vào phụ âm đầu câu ở tốc độ >= 1.2x
            if (!this.leadPadDone) {
                this.leadPadDone = true;
                const leadPadSamples = Math.round(this.sampleRate * WSOLA_LEAD_PAD_SEC);
                if (leadPadSamples > 0) {
                    this._appendInput(new Float32Array(leadPadSamples));
                }
            }

            this._appendInput(chunk);
            const estFrames = Math.max(1, Math.ceil((this.inputLen - this.inPos) / (this.synHop * this.speed)) + 2);
            let out = new Float32Array(estFrames * this.synHop);
            let outLen = 0;

            while (this.inputLen >= Math.round(this.inPos) + this.winLen + this.searchRadius) {
                if (outLen + this.synHop > out.length) {
                    const grown = new Float32Array(out.length * 2);
                    grown.set(out.subarray(0, outLen), 0);
                    out = grown;
                }
                outLen += this._synthStepInto(out, outLen);
            }

            const safeKeep = this.searchRadius + 16;
            const discard = Math.floor(this.inPos) - safeKeep;
            if (discard > this.searchRadius * 2) {
                const remain = this.inputLen - discard;
                if (remain > 0) {
                    this.inputBuf.copyWithin(0, discard, this.inputLen);
                }
                this.inputLen = Math.max(0, remain);
                this.inPos -= discard;
            }

            return outLen === 0 ? new Float32Array(0) : out.subarray(0, outLen);
        }

        flush() {
            if (Math.abs(this.speed - 1.0) < 0.001) return new Float32Array(0);

            const realEnd = this.inputLen;
            const estFrames = Math.max(1, Math.ceil(Math.max(0, realEnd - this.inPos) / (this.synHop * this.speed)) + 3);
            let out = new Float32Array(estFrames * this.synHop);
            let outLen = 0;

            if (realEnd > 0 && Math.round(this.inPos) < realEnd) {
                const padNeed = Math.max(0, Math.round(this.inPos) + this.winLen + this.searchRadius - realEnd);
                if (padNeed > 0) {
                    this._appendInput(new Float32Array(padNeed));
                }
                while (Math.round(this.inPos) < realEnd && this.inputLen >= Math.round(this.inPos) + this.winLen) {
                    if (outLen + this.synHop > out.length) {
                        const grown = new Float32Array(out.length * 2);
                        grown.set(out.subarray(0, outLen), 0);
                        out = grown;
                    }
                    outLen += this._synthStepInto(out, outLen);
                }
            }

            if (this.hasStarted) {
                if (outLen + this.tailOverlap.length > out.length) {
                    const grown = new Float32Array(outLen + this.tailOverlap.length);
                    grown.set(out.subarray(0, outLen), 0);
                    out = grown;
                }
                out.set(this.tailOverlap, outLen);
                outLen += this.tailOverlap.length;
            }

            this.inputLen = 0;
            this.inPos = 0;
            return outLen === 0 ? new Float32Array(0) : out.subarray(0, outLen);
        }
    }

    class ContinuousResampler {
        constructor(inRate, outRate) {
            this.inRate = inRate;
            this.outRate = outRate;
            this.step = inRate / outRate;
            this.prev = 0;
            this.phase = 0;
        }

        process(buf) {
            if (!buf || buf.length === 0 || this.inRate === this.outRate) return buf;
            const estOut = Math.ceil((buf.length - this.phase) / this.step) + 2;
            const out = new Float32Array(Math.max(0, estOut));
            let outIdx = 0;
            let phase = this.phase;
            const len = buf.length;

            while (phase < len - 1) {
                const i0 = Math.floor(phase);
                const frac = phase - i0;
                const s0 = i0 < 0 ? this.prev : buf[i0];
                const s1 = buf[i0 + 1];
                out[outIdx++] = s0 + (s1 - s0) * frac;
                phase += this.step;
            }

            this.prev = buf[len - 1];
            this.phase = phase - len;
            return out.subarray(0, outIdx);
        }
    }

    function float32ToInt16(float32Array) {
        if (!float32Array || float32Array.length === 0) return new Int16Array(0);
        const out = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const raw = float32Array[i];
            const v = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
            out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
        }
        return out;
    }

    function buildWavHeader(totalSamples, sampleRate = EXPORT_SAMPLE_RATE, numChannels = 1, bitsPerSample = 16) {
        const safeSamples = Math.max(0, Math.floor(Number(totalSamples) || 0));
        const safeRate = Math.max(8000, Math.floor(Number(sampleRate) || EXPORT_SAMPLE_RATE));
        const bytesPerSample = Math.floor(bitsPerSample / 8);
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = safeRate * blockAlign;
        const dataSize = safeSamples * blockAlign;
        const buffer = new ArrayBuffer(44);
        const view = new DataView(buffer);

        const writeAscii = (offset, str) => {
            for (let i = 0; i < str.length; i++) {
                view.setUint8(offset + i, str.charCodeAt(i));
            }
        };

        writeAscii(0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        writeAscii(8, 'WAVE');
        writeAscii(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, safeRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        writeAscii(36, 'data');
        view.setUint32(40, dataSize, true);
        return buffer;
    }

    function encodeWavFromInt16Chunks(int16Chunks, sampleRate = EXPORT_SAMPLE_RATE) {
        const chunks = Array.isArray(int16Chunks) ? int16Chunks : [];
        const blobParts = [];
        let totalSamples = 0;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (!chunk || chunk.length === 0) continue;
            const int16 = chunk instanceof Int16Array ? chunk : new Int16Array(chunk);
            totalSamples += int16.length;
            blobParts.push(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength));
        }
        const safeRate = Math.max(8000, Math.floor(Number(sampleRate) || EXPORT_SAMPLE_RATE));
        const header = buildWavHeader(totalSamples, safeRate, 1, 16);
        const blob = typeof Blob === 'function'
            ? new Blob([header, ...blobParts], { type: 'audio/wav' })
            : null;
        return {
            blob,
            header,
            totalSamples,
            byteLength: 44 + totalSamples * 2,
            sampleRate: safeRate
        };
    }

    function extractCleanTranslatedLines(fullText) {
        let text = String(fullText || '').replace(/\r/g, '');
        text = text.replace(/^```\w*\n?/gi, '').replace(/\n?```$/gi, '');
        const glossaryIdx = text.indexOf('[GLOSSARY]');
        if (glossaryIdx !== -1) {
            text = text.slice(0, glossaryIdx);
        }
        const transTag = '[TRANSLATION]';
        const transIdx = text.indexOf(transTag);
        if (transIdx !== -1) {
            text = text.slice(transIdx + transTag.length);
        }
        text = text.trim();
        if (!text) return [];
        return text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
    }

    function packSegmentsForExport(rawLinesOrTexts, maxLen = EXPORT_MAX_CHUNK_CHARS, iconOptions = null) {
        const limit = Math.max(64, Math.floor(Number(maxLen) || EXPORT_MAX_CHUNK_CHARS));
        const describer = getIconDescriber();
        const segments = [];
        const items = Array.isArray(rawLinesOrTexts) ? rawLinesOrTexts : [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const raw = typeof item === 'string' ? item : (item && (item.rawText || item.text));
            const effectiveRaw = (typeof raw === 'string') ? raw : '';

            let prep = null;
            let cleaned = '';
            if (describer) {
                prep = describer.prepareTextForTTS(effectiveRaw, iconOptions || { mode: 'local', style: 'tagged' });
                if (prep.needsAi && effectiveRaw.length > limit) {
                    const rawSentences = effectiveRaw.split(/(?<=[.!?;。！？])\s+/).filter(Boolean);
                    if (rawSentences.length > 1) {
                        const subPacked = packSegmentsForExport(rawSentences, limit, iconOptions);
                        segments.push(...subPacked);
                        continue;
                    }
                }
                cleaned = cleanTextForSpeech(prep.text, { _skipIconDescribe: true });
            } else {
                cleaned = cleanTextForSpeech(effectiveRaw);
            }
            if (!cleaned) continue;

            const parts = splitLongTextForTTS(cleaned, limit);
            const isSinglePart = parts.length === 1;
            const needsAi = Boolean(prep && prep.needsAi && isSinglePart);
            for (let j = 0; j < parts.length; j++) {
                const part = parts[j];
                if (!needsAi && segments.length > 0) {
                    const prev = segments[segments.length - 1];
                    if (!prev.needsAiIconResolve) {
                        const prefix = ensureSentenceEnding(prev.text);
                        if (prefix.length + 1 + part.length <= limit) {
                            prev.text = `${prefix} ${part}`;
                            if (isSinglePart && prev.rawText !== undefined) {
                                prev.rawText = `${ensureSentenceEnding(prev.rawText)} ${effectiveRaw}`;
                            } else {
                                delete prev.rawText;
                            }
                            continue;
                        }
                    }
                }
                const segObj = { text: part, domElement: null, domElements: [] };
                if (isSinglePart) {
                    segObj.rawText = (prep && prep.aiText) ? prep.aiText : effectiveRaw;
                }
                if (needsAi) {
                    segObj.needsAiIconResolve = true;
                    segObj.aiRawText = (prep && prep.aiText) ? prep.aiText : effectiveRaw;
                    segObj.iconTokens = (prep && prep.aiTokens) || prep.tokens || [];
                    segObj.iconLang = prep.lang || 'vi';
                    segObj.iconResolveState = 'pending';
                    segObj.iconResolvePromise = null;
                }
                segments.push(segObj);
            }
        }
        return segments;
    }

    // Export DSP helpers for testing and external consumption
    global.STV_TTSHelpers = {
        cleanTextForSpeech,
        splitLongTextForTTS,
        decodePcm16Base64ToFloat32,
        WSOLAProcessor,
        ContinuousResampler,
        createAnchorTrimmer,
        float32ToInt16,
        buildWavHeader,
        encodeWavFromInt16Chunks,
        extractCleanTranslatedLines,
        appendPackedSegment,
        packSegmentsForExport,
        COLAB_TIER_CONFIG,
        getColabGpuExportConfig
    };
    global.splitLongTextForTTS = splitLongTextForTTS;
    global.cleanTextForSpeech = cleanTextForSpeech;
    global.WSOLAProcessor = WSOLAProcessor;
    global.ContinuousResampler = ContinuousResampler;
    global.createAnchorTrimmer = createAnchorTrimmer;

    if (typeof document === 'undefined') {
        return;
    }

    // Tránh khởi tạo lại nhiều lần khi tiêm script lặp lại
    if (global.STV_TTSController) {
        return;
    }

    function injectTTSStyles() {
        if (!document.getElementById('stv-tts-highlight-style')) {
            const hlStyle = document.createElement('style');
            hlStyle.id = 'stv-tts-highlight-style';
            hlStyle.textContent = `
                .stv-tts-speaking {
                    background-color: rgba(255, 235, 59, 0.36) !important;
                    border-radius: 4px !important;
                    box-shadow: -3px 0 0 #ef6c00 !important;
                    transition: background-color 0.2s ease;
                }
            `;
            document.head.appendChild(hlStyle);
        }
    }

    const TTS_PLAYER_SHADOW_CSS = `
            :host { all: initial; }
            #stv-tts-player [hidden] { display: none !important; }
            #stv-tts-player {
                width: 310px;
                max-width: calc(100vw - 24px);
                background: #1e293b;
                color: #f8fafc;
                border-radius: 12px;
                box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
                border: 1px solid rgba(255, 255, 255, 0.12);
                padding: 10px 12px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px;
                line-height: 1.4;
                user-select: none;
            }
            #stv-tts-player .stv-tts-top {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin-bottom: 4px;
            }
            #stv-tts-player .stv-tts-title {
                font-weight: 700;
                font-size: 12px;
                color: #93c5fd;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            #stv-tts-player .stv-tts-counter {
                font-size: 11px;
                color: #cbd5e1;
                white-space: nowrap;
            }
            #stv-tts-player .stv-tts-close {
                background: none;
                border: none;
                color: #94a3b8;
                cursor: pointer;
                font-size: 14px;
                padding: 0 4px;
                line-height: 1;
            }
            #stv-tts-player .stv-tts-close:hover {
                color: #ffffff;
            }
            #stv-tts-player .stv-tts-preview {
                font-size: 12px;
                color: #e2e8f0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-bottom: 8px;
                min-height: 17px;
            }
            #stv-tts-player .stv-tts-controls {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
            }
            #stv-tts-player .stv-tts-btn-group {
                display: flex;
                align-items: center;
                gap: 4px;
            }
            #stv-tts-player button.stv-tts-btn {
                background: #334155;
                color: #f8fafc;
                border: none;
                border-radius: 6px;
                padding: 5px 9px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 600;
                transition: background 0.15s;
            }
            #stv-tts-player button.stv-tts-btn:hover:not(:disabled) {
                background: #475569;
            }
            #stv-tts-player button.stv-tts-btn.primary {
                background: #2563eb;
                min-width: 36px;
            }
            #stv-tts-player button.stv-tts-btn.primary:hover:not(:disabled) {
                background: #1d4ed8;
            }
            #stv-tts-player button.stv-tts-btn:disabled {
                opacity: 0.45;
                cursor: not-allowed;
            }
            #stv-tts-player .stv-tts-speed {
                display: flex;
                align-items: center;
                gap: 3px;
                font-size: 12px;
                color: #f8fafc;
            }
            #stv-tts-player .stv-tts-speed-val {
                min-width: 34px;
                text-align: center;
                font-weight: 700;
                color: #fbbf24;
            }
            #stv-tts-player .stv-tts-status {
                margin-top: 6px;
                font-size: 11px;
                color: #94a3b8;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
            }
            #stv-tts-player .stv-tts-status.error {
                color: #fca5a5;
            }
            #stv-tts-player .stv-tts-status-text {
                flex: 1;
                min-width: 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #stv-tts-player button.stv-tts-pill {
                flex-shrink: 0;
                background: #334155;
                color: #cbd5e1;
                border: none;
                border-radius: 999px;
                padding: 2px 8px;
                font-size: 10.5px;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.15s, color 0.15s;
            }
            #stv-tts-player button.stv-tts-pill.active {
                background: #0f766e;
                color: #ecfdf5;
            }
            #stv-tts-player button.stv-tts-pill:hover {
                filter: brightness(1.12);
            }
            #stv-tts-player button:focus-visible,
            #stv-tts-player select:focus-visible {
                outline: 2px solid #93c5fd;
                outline-offset: 2px;
            }
            #stv-tts-player .stv-tts-dl-bar {
                margin-top: 8px;
                padding-top: 8px;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            #stv-tts-player .stv-tts-dl-row {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
            }
            #stv-tts-player .stv-tts-dl-select {
                background: #0f172a;
                color: #f8fafc;
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 6px;
                padding: 4px 6px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                flex-shrink: 0;
            }
            #stv-tts-player .stv-tts-dl-btn {
                flex: 1;
                min-width: 90px;
                background: #0f766e;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #stv-tts-player .stv-tts-dl-btn:hover:not(:disabled) {
                background: #115e59;
            }
            #stv-tts-player .stv-tts-dl-next {
                flex-shrink: 0;
                background: #4f46e5;
                white-space: nowrap;
            }
            #stv-tts-player .stv-tts-dl-next:hover:not(:disabled) {
                background: #4338ca;
            }
            #stv-tts-player .stv-tts-dl-active {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            #stv-tts-player .stv-tts-dl-progress {
                width: 100%;
                height: 5px;
                background: #0f172a;
                border-radius: 999px;
                overflow: hidden;
            }
            #stv-tts-player .stv-tts-dl-progress-fill {
                height: 100%;
                width: 0%;
                background: linear-gradient(90deg, #14b8a6, #3b82f6);
                transition: width 0.2s ease;
            }
            #stv-tts-player .stv-tts-dl-active-row {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            #stv-tts-player .stv-tts-dl-active-row .stv-tts-btn {
                flex: 1;
                font-size: 12px;
                padding: 4px 8px;
            }
            #stv-tts-player .stv-tts-dl-save {
                background: #0f766e;
            }
            #stv-tts-player .stv-tts-dl-save:hover:not(:disabled) {
                background: #115e59;
            }
            #stv-tts-player .stv-tts-dl-cancel {
                background: #991b1b;
            }
            #stv-tts-player .stv-tts-dl-cancel:hover:not(:disabled) {
                background: #7f1d1d;
            }
        `;

    function getActiveIconOptions() {
        const loc = (global.STV_I18n && typeof global.STV_I18n.getLocale === 'function')
            ? global.STV_I18n.getLocale()
            : 'vi';
        return {
            mode: state.iconMode || 'auto',
            style: state.iconStyle || 'tagged',
            fallbackLocale: loc === 'en' ? 'en' : 'vi',
            learnedCache: state.iconLearnedCache || null,
            customIcons: state.iconCustomMap || null
        };
    }

    async function collectReadableSegments() {
        const segments = [];
        const consumedEls = new Set();
        const iconOpts = getActiveIconOptions();
        const pushElementText = (el, rawText) => {
            appendPackedSegment(segments, rawText, el, 0, iconOpts);
        };

        // 1. Ưu tiên đọc theo các dòng đã dịch xong (.stv-line, bỏ qua dòng đang gõ dở .stv-line-partial)
        const stvLines = document.querySelectorAll('.stv-line:not(.stv-line-partial)');
        if (stvLines.length > 0) {
            stvLines.forEach((el) => {
                consumedEls.add(el);
                pushElementText(el, el.innerText || el.textContent);
            });
            if (segments.length > 0) return { segments, consumedEls, usedStvLines: true };
        }

        // 2. Fallback cho trang tiếng Việt sẵn chưa qua bước dịch
        let contentBox = global.STV_activeContentBox || null;
        let extractedChunks = null;

        if (!contentBox && typeof global.STV_extractChapterTextChunks === 'function') {
            extractedChunks = await global.STV_extractChapterTextChunks();
            contentBox = global.STV_activeContentBox || null;
        }

        if (contentBox) {
            // Nếu vùng truyện có các thẻ <p> rõ ràng thì highlight từng <p>
            const pNodes = Array.from(contentBox.querySelectorAll('p'))
                .filter((p) => cleanTextForSpeech(p.innerText || p.textContent, iconOpts).length > 0);
            if (pNodes.length >= 2) {
                pNodes.forEach((p) => pushElementText(p, p.innerText || p.textContent));
                if (segments.length > 0) return { segments, consumedEls, usedStvLines: false };
            }

            // Nếu vùng truyện dùng <br> / text thô: tách dòng từ extractor hoặc innerText
            if (!extractedChunks && typeof global.STV_convertHtmlToTextChunks === 'function') {
                extractedChunks = global.STV_convertHtmlToTextChunks(contentBox.innerHTML);
            }
            const rawLines = extractedChunks || (contentBox.innerText || '').split('\n');
            for (const line of rawLines) {
                pushElementText(contentBox, line);
            }
            if (segments.length > 0) return { segments, consumedEls, usedStvLines: false };
        }

        return { segments, consumedEls, usedStvLines: false };
    }

    const state = {
        segments: [],
        currentIndex: 0,
        isPlaying: false,
        isPaused: false,
        waitingForMoreSegments: false,
        engine: 'ws_default', // 'ws_default' | 'webspeech' | 'vieneu'
        activeEngine: 'ws_default',
        wsEndpoint: '',
        wsVoice: 'vi-VN-HoaiMyNeural',
        wsAutoFallback: true,
        activeWs: null,
        wsFallbackNotified: false,
        speed: 1.0,
        voice: '',
        apiKey: '',
        stabilityProfile: 'balanced',
        serverUrl: DEFAULT_SERVER_URL,
        audioCtx: null,
        streamPlayer: null,
        streamToken: 0,
        activeUtterance: null,
        pendingWsDrained: false,
        activePort: null,
        prefetchPort: null,
        prefetchIndex: -1,
        prefetchQueue: new Map(), // Map<segIndex, { index, chunks, done, error, onEvent, port }>
        prefetchCache: null, // synced alias to next buffered entry for compatibility
        currentSession: null,
        runId: 0,
        liveTranslationRunId: null,
        consumedLineEls: new Set(),
        progressListenerBound: false,
        highlightedEls: [],
        playerHost: null,
        playerEl: null,
        altClickBound: false,
        autoNextChapter: true,
        preloadLeadSec: 60,
        nextChapterUrl: null,
        preloadTriggered: false,
        preloadDone: false,
        preloadRequestInFlight: false,
        preloadId: null,
        preloadState: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
        preloadRetryCount: 0,
        preloadUpperRetryLimit: 3,
        preloadTimer: null,
        preloadWatchPort: null,
        nextChapterTimer: null,
        wasTranslated: false,
        pendingWsReplay: false,
        autoplayBlocked: false,
        autoplayUnblockedAt: 0,
        autoplayResumeBound: false,
        downloadMinutes: DEFAULT_DOWNLOAD_MINUTES,
        downloadSource: 'current', // 'current' | 'colab_gpu'
        colabServerUrl: '',
        colabVoice: '',
        colabGpuTier: 'T4',
        iconMode: 'auto', // 'auto' | 'local' | 'off'
        iconStyle: 'tagged', // 'tagged' | 'natural'
        iconLearnedCache: {},
        iconCustomMap: {},
        aiIconsUnavailable: false,
        liveIconDebounceTimer: null,
        debugLog: false
    };

    const exportState = {
        active: false,
        runId: 0,
        leaseId: null,
        useColabGpu: false,
        effectiveEngine: 'ws_default',
        effectiveServerUrl: '',
        effectiveVoice: '',
        targetWorkers: EXPORT_CONCURRENCY,
        maxChunkChars: EXPORT_MAX_CHUNK_CHARS,
        aborted: false,
        savePartialRequested: false,
        targetMinutes: DEFAULT_DOWNLOAD_MINUTES,
        accumulatedSec: 0,
        chaptersCompleted: 0,
        currentChapter: 0,
        segIndex: 0,
        segTotal: 0,
        fetchingNext: false,
        waitingTranslation: false,
        nextOpenUrl: null,
        activePorts: new Set(),
        activeSockets: new Set(),
        activePreloadPort: null,
        abortRejects: new Set()
    };

    function ttsLog(...args) {
        if (!state.debugLog) return;
        try { console.log('[STV TTS]', ...args); } catch {}
    }

    function clearHighlight() {
        if (state.highlightedEls && state.highlightedEls.length > 0) {
            for (const el of state.highlightedEls) {
                el.classList.remove('stv-tts-speaking');
            }
            state.highlightedEls = [];
        }
    }

    function highlightSegment(index) {
        clearHighlight();
        const seg = state.segments[index];
        if (!seg) return;
        const candidates = Array.isArray(seg.domElements) && seg.domElements.length > 0
            ? seg.domElements
            : (seg.domElement ? [seg.domElement] : []);
        const valid = candidates.filter((el) => {
            if (!el || !document.contains(el)) return false;
            // Không highlight cả contentBox khổng lồ khi fallback không có thẻ <p>
            if (el === global.STV_activeContentBox && el.querySelectorAll('.stv-line').length === 0) {
                return false;
            }
            return true;
        });
        if (valid.length === 0) return;
        for (const el of valid) {
            el.classList.add('stv-tts-speaking');
        }
        state.highlightedEls = valid;
        const firstEl = valid[0];
        let shouldScroll = true;
        if (typeof firstEl.getBoundingClientRect === 'function' && typeof global.innerHeight === 'number' && global.innerHeight > 0) {
            const rect = firstEl.getBoundingClientRect();
            const vh = global.innerHeight;
            if (rect.top >= vh * 0.15 && rect.bottom <= vh * 0.85) {
                shouldScroll = false;
            }
        }
        if (shouldScroll && typeof firstEl.scrollIntoView === 'function') {
            firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    function createContinuousStreamPlayer(audioCtx) {
        const pendingOps = [];
        let ready = false;
        let disposed = false;
        let mode = 'init'; // 'worklet' | 'buffer'
        let node = null;
        let drainedHandler = null;
        let queuedEndTime = audioCtx.currentTime;
        let resampler = null;
        let resamplerInRate = 0;

        // Hàng đợi AudioBufferSourceNode dùng cho HTTP hoặc khi CSP chặn AudioWorklet (không dùng ScriptProcessorNode)
        const bufState = {
            gainNode: null,
            activeSources: new Set(),
            baseTime: 0,
            scheduledSamples: 0,
            flushToken: null
        };

        const emitDrained = (token) => {
            if (!disposed && typeof drainedHandler === 'function') {
                drainedHandler(token);
            }
        };

        const prepareSamples = (samples, inRate) => {
            const sr = inRate || audioCtx.sampleRate || DEFAULT_SAMPLE_RATE;
            let data = samples;
            if (sr !== audioCtx.sampleRate) {
                if (!resampler || resamplerInRate !== sr) {
                    resampler = new ContinuousResampler(sr, audioCtx.sampleRate);
                    resamplerInRate = sr;
                }
                data = resampler.process(samples);
            }
            if (!data || data.length === 0) return null;
            const copy = new Float32Array(data.length);
            for (let i = 0; i < data.length; i++) {
                const v = data[i];
                copy[i] = v > 0.995 ? 0.995 : (v < -0.995 ? -0.995 : v);
            }
            return copy;
        };

        const stopAllBufferSources = () => {
            for (const src of Array.from(bufState.activeSources)) {
                try { src.onended = null; } catch {}
                try { src.stop(); } catch {}
                try { src.disconnect(); } catch {}
            }
            bufState.activeSources.clear();
            bufState.baseTime = 0;
            bufState.scheduledSamples = 0;
            bufState.flushToken = null;
        };

        const applyOpToBufferQueue = (op) => {
            if (op.type === 'push' && op.samples && op.samples.length > 0) {
                const sr = audioCtx.sampleRate || DEFAULT_SAMPLE_RATE;
                const now = audioCtx.currentTime;
                const curEnd = bufState.baseTime + (bufState.scheduledSamples / sr);
                const samples = op.samples;

                if (bufState.baseTime === 0 || curEnd < now - 0.010) {
                    bufState.baseTime = now + 0.03;
                    bufState.scheduledSamples = 0;
                    const fadeLen = Math.min(samples.length, 64);
                    for (let i = 0; i < fadeLen; i++) {
                        samples[i] *= i / fadeLen;
                    }
                }

                const startAt = bufState.baseTime + (bufState.scheduledSamples / sr);
                bufState.scheduledSamples += samples.length;

                if (typeof audioCtx.createBuffer === 'function' && typeof audioCtx.createBufferSource === 'function') {
                    const ab = audioCtx.createBuffer(1, samples.length, sr);
                    ab.getChannelData(0).set(samples);
                    const src = audioCtx.createBufferSource();
                    src.buffer = ab;
                    src.connect(bufState.gainNode || audioCtx.destination);
                    bufState.activeSources.add(src);
                    src.onended = () => {
                        bufState.activeSources.delete(src);
                        if (bufState.flushToken !== null && bufState.activeSources.size === 0) {
                            const tok = bufState.flushToken;
                            bufState.flushToken = null;
                            emitDrained(tok);
                        }
                    };
                    src.start(startAt);
                }
            } else if (op.type === 'flush') {
                if (bufState.activeSources.size === 0) {
                    setTimeout(() => emitDrained(op.token), 0);
                } else {
                    bufState.flushToken = op.token;
                }
            } else if (op.type === 'clear') {
                stopAllBufferSources();
            }
        };

        const applyOpToWorklet = (op) => {
            if (!node) return;
            if (op.type === 'push') {
                node.port.postMessage({ type: 'push', samples: op.samples }, [op.samples.buffer]);
            } else {
                node.port.postMessage(op);
            }
        };

        const initBufferQueueFallback = (reason = '') => {
            if (disposed) return;
            mode = 'buffer';
            ready = true;
            ttsLog('Audio mode: BufferQueue fallback', reason ? `(${reason})` : '');
            if (typeof audioCtx.createGain === 'function') {
                try {
                    bufState.gainNode = audioCtx.createGain();
                    bufState.gainNode.connect(audioCtx.destination);
                } catch {
                    bufState.gainNode = null;
                }
            }
            for (const op of pendingOps.splice(0)) {
                applyOpToBufferQueue(op);
            }
        };

        const initWorklet = async () => {
            try {
                if (!audioCtx.audioWorklet || typeof global.AudioWorkletNode !== 'function' || !chrome?.runtime?.getURL) {
                    initBufferQueueFallback();
                    return;
                }
                const url = chrome.runtime.getURL('tts-worklet.js');
                await audioCtx.audioWorklet.addModule(url);
                if (disposed) return;

                const wn = new global.AudioWorkletNode(audioCtx, 'stv-pcm-player', {
                    numberOfInputs: 0,
                    numberOfOutputs: 1,
                    outputChannelCount: [1]
                });
                wn.port.onmessage = (ev) => {
                    if (!ev.data) return;
                    if (ev.data.type === 'drained') {
                        emitDrained(ev.data.token);
                    } else if (ev.data.type === 'underrun') {
                        ttsLog(`Worklet buffer underrun at segment #${state.currentIndex + 1}`);
                    }
                };
                wn.connect(audioCtx.destination);
                node = wn;
                mode = 'worklet';
                ready = true;
                ttsLog(`Audio mode: AudioWorklet (ctxRate=${audioCtx.sampleRate}Hz)`);
                for (const op of pendingOps.splice(0)) {
                    applyOpToWorklet(op);
                }
            } catch (err) {
                initBufferQueueFallback(err?.message || 'addModule failed');
            }
        };

        initWorklet();

        return {
            push(samples, sampleRate) {
                if (disposed) return;
                const copy = prepareSamples(samples, sampleRate);
                if (!copy || copy.length === 0) return;

                const now = audioCtx.currentTime;
                queuedEndTime = Math.max(now, queuedEndTime) + (copy.length / (audioCtx.sampleRate || DEFAULT_SAMPLE_RATE));

                const op = { type: 'push', samples: copy };
                if (!ready) {
                    pendingOps.push(op);
                } else if (mode === 'worklet') {
                    applyOpToWorklet(op);
                } else {
                    applyOpToBufferQueue(op);
                }
            },
            flush(token) {
                if (disposed) return;
                const op = { type: 'flush', token };
                if (!ready) {
                    pendingOps.push(op);
                } else if (mode === 'worklet') {
                    applyOpToWorklet(op);
                } else {
                    applyOpToBufferQueue(op);
                }
            },
            clear() {
                queuedEndTime = audioCtx.currentTime;
                resampler = null;
                resamplerInRate = 0;
                if (!ready) {
                    pendingOps.length = 0;
                    pendingOps.push({ type: 'clear' });
                } else if (mode === 'worklet') {
                    applyOpToWorklet({ type: 'clear' });
                } else {
                    applyOpToBufferQueue({ type: 'clear' });
                }
            },
            getQueuedSeconds() {
                return Math.max(0, queuedEndTime - audioCtx.currentTime);
            },
            setDrainedHandler(fn) {
                drainedHandler = fn;
            },
            dispose() {
                disposed = true;
                pendingOps.length = 0;
                drainedHandler = null;
                stopAllBufferSources();
                if (bufState.gainNode) {
                    try { bufState.gainNode.disconnect(); } catch {}
                    bufState.gainNode = null;
                }
                if (node) {
                    try {
                        if (mode === 'worklet') {
                            node.port.postMessage({ type: 'clear' });
                            node.port.onmessage = null;
                        }
                        node.disconnect();
                    } catch {
                        // ignore
                    }
                    node = null;
                }
            }
        };
    }

    function stopStreamPlayer(dispose = false) {
        if (!state.streamPlayer) return;
        state.streamPlayer.clear();
        state.streamPlayer.setDrainedHandler(null);
        if (dispose) {
            state.streamPlayer.dispose();
            state.streamPlayer = null;
        }
    }

    function ensureStreamPlayer(audioCtx) {
        if (!state.streamPlayer) {
            state.streamPlayer = createContinuousStreamPlayer(audioCtx);
        }
        return state.streamPlayer;
    }

    function canStartAudioContext() {
        if (typeof navigator !== 'undefined' && navigator.userActivation) {
            return Boolean(navigator.userActivation.isActive || navigator.userActivation.hasBeenActive);
        }
        return true;
    }

    function ensureAudioContext() {
        if (!state.audioCtx || state.audioCtx.state === 'closed') {
            const Ctx = global.AudioContext || global.webkitAudioContext;
            try {
                state.audioCtx = new Ctx({ sampleRate: DEFAULT_SAMPLE_RATE });
            } catch {
                state.audioCtx = new Ctx();
            }
        }
        if (state.audioCtx.state === 'suspended' && !state.isPaused && !state.autoplayBlocked && canStartAudioContext()) {
            state.audioCtx.resume().catch(() => {});
        }
        return state.audioCtx;
    }

    let autoplayGestureHandler = null;
    function clearAutoplayResumeGesture() {
        if (autoplayGestureHandler) {
            document.removeEventListener('pointerdown', autoplayGestureHandler, { capture: true });
            document.removeEventListener('keydown', autoplayGestureHandler, { capture: true });
            autoplayGestureHandler = null;
        }
        state.autoplayResumeBound = false;
    }

    function bindAutoplayResumeGesture() {
        if (state.autoplayResumeBound) return;
        state.autoplayResumeBound = true;
        const onUserGesture = () => {
            clearAutoplayResumeGesture();
            const wasBlocked = state.autoplayBlocked;
            state.autoplayBlocked = false;
            state.autoplayUnblockedAt = Date.now();
            if (state.isPlaying && !state.isPaused) {
                const ctx = ensureAudioContext();
                ensureStreamPlayer(ctx);
                ctx.resume().then(() => {
                    if (state.isPlaying && !state.isPaused && wasBlocked && !state.currentSession && !state.activePort && !state.activeWs) {
                        playSegment(state.currentIndex, state.runId);
                    } else {
                        updatePlayerUI();
                    }
                }).catch(() => {
                    updatePlayerUI();
                });
                updatePlayerUI();
            } else {
                updatePlayerUI();
            }
        };
        autoplayGestureHandler = onUserGesture;
        document.addEventListener('pointerdown', onUserGesture, { once: true, capture: true });
        document.addEventListener('keydown', onUserGesture, { once: true, capture: true });
    }

    async function ensureAudioContextReady() {
        if (state.activeEngine === 'webspeech') {
            state.autoplayBlocked = false;
            return null;
        }
        if (!canStartAudioContext() && (!state.audioCtx || state.audioCtx.state !== 'running')) {
            state.autoplayBlocked = true;
            bindAutoplayResumeGesture();
            return null;
        }
        const ctx = ensureAudioContext();
        ensureStreamPlayer(ctx);
        if (ctx.state === 'suspended' && !state.isPaused) {
            try {
                await Promise.race([
                    ctx.resume(),
                    new Promise((resolve) => setTimeout(resolve, 250))
                ]);
            } catch {
                // ignore
            }
        }
        if (ctx.state === 'suspended' && !state.isPaused) {
            state.autoplayBlocked = true;
            bindAutoplayResumeGesture();
        } else {
            state.autoplayBlocked = false;
        }
        return ctx;
    }

    function updatePlayerUI(statusText = '', isError = false) {
        const el = state.playerEl;
        if (!el) return;

        const titleEl = el.querySelector('.stv-tts-title');
        const counterEl = el.querySelector('.stv-tts-counter');
        const previewEl = el.querySelector('.stv-tts-preview');
        const playPauseBtn = el.querySelector('[data-act="toggle"]');
        const prevBtn = el.querySelector('[data-act="prev"]');
        const nextBtn = el.querySelector('[data-act="next"]');
        const speedValEl = el.querySelector('.stv-tts-speed-val');
        const statusEl = el.querySelector('.stv-tts-status-text');
        const statusBox = el.querySelector('.stv-tts-status');
        const autoNextBtn = el.querySelector('[data-act="autonext"]');

        const total = state.segments.length;
        const displayIdx = total > 0 ? Math.min(state.currentIndex + 1, total) : 0;
        const seg = state.segments[state.currentIndex];

        const engineLabel = state.activeEngine === 'vieneu'
            ? `VieNeu · ${state.voice || 'Default'}`
            : (state.activeEngine === 'webspeech' ? 'Web Speech' : `WS TTS · ${state.wsVoice || 'Default'}`);
        if (titleEl) titleEl.textContent = `🔊 ${engineLabel}`;
        if (counterEl) counterEl.textContent = `${displayIdx} / ${total}`;
        if (previewEl) previewEl.textContent = seg ? seg.text : 'Sẵn sàng';
        if (playPauseBtn) playPauseBtn.textContent = (state.isPlaying && !state.isPaused && !state.autoplayBlocked) ? '⏸' : '▶';
        if (prevBtn) prevBtn.disabled = state.currentIndex <= 0;
        if (nextBtn) nextBtn.disabled = state.currentIndex >= total - 1;
        if (speedValEl) speedValEl.textContent = `${state.speed.toFixed(1)}x`;

        if (autoNextBtn) {
            autoNextBtn.classList.toggle('active', Boolean(state.autoNextChapter));
            if (!state.autoNextChapter) {
                autoNextBtn.textContent = '⏭ Tự qua: Tắt';
                autoNextBtn.title = 'Bật tự động sang chương tiếp theo';
            } else if (!state.nextChapterUrl) {
                autoNextBtn.textContent = '⏭ Tự qua: --';
                autoNextBtn.title = 'Không tìm thấy link chương tiếp theo trên trang này';
            } else if (state.preloadState === 'ready') {
                autoNextBtn.textContent = '⏭ Sau: Sẵn';
                autoNextBtn.title = 'Chương tiếp theo đã tải & dịch sẵn sàng';
            } else if (state.preloadState === 'loading') {
                autoNextBtn.textContent = '⏭ Sau: ⏳';
                autoNextBtn.title = 'Đang tải trước chương tiếp theo...';
            } else if (state.preloadState === 'error') {
                autoNextBtn.textContent = '⏭ Sau: Lỗi';
                autoNextBtn.title = 'Tải trước chương sau gặp lỗi — sẽ tự thử lại';
            } else {
                autoNextBtn.textContent = '⏭ Tự qua: Bật';
                autoNextBtn.title = `Tự sang chương mới & tải trước ${state.preloadLeadSec}s`;
            }
        }

        if (statusEl) {
            if (exportState.active && !isError && !statusText) {
                const curMin = (exportState.accumulatedSec / 60).toFixed(1);
                if (exportState.waitingTranslation) {
                    statusEl.textContent = tTts('tts_dl_waiting_translation', 'Đang đợi chương hiện tại dịch xong để tải audio...');
                } else if (exportState.fetchingNext) {
                    statusEl.textContent = tTts('tts_dl_fetching_next', `Đã tạo ${curMin}/${exportState.targetMinutes}p · Đang tải & dịch chương ${exportState.currentChapter}...`)
                        .replace('{current}', curMin)
                        .replace('{target}', String(exportState.targetMinutes))
                        .replace('{chap}', String(exportState.currentChapter));
                } else {
                    statusEl.textContent = tTts('tts_dl_progress', `Đang tạo: ${curMin}/${exportState.targetMinutes} phút · Chương ${exportState.currentChapter} (${exportState.segIndex}/${exportState.segTotal})`)
                        .replace('{current}', curMin)
                        .replace('{target}', String(exportState.targetMinutes))
                        .replace('{chap}', String(exportState.currentChapter))
                        .replace('{seg}', String(exportState.segIndex))
                        .replace('{totalSeg}', String(exportState.segTotal));
                }
            } else if (state.autoplayBlocked && state.isPlaying && !state.isPaused && !isError) {
                statusEl.textContent = '🔇 Click trang hoặc ▶ để phát âm thanh';
            } else if (statusText) {
                statusEl.textContent = statusText;
            } else if (state.isPaused) {
                statusEl.textContent = 'Đang tạm dừng';
            } else if (state.isPlaying) {
                statusEl.textContent = 'Đang phát... (Alt+Click dòng để nhảy)';
            } else {
                statusEl.textContent = 'Đã dừng';
            }
        }
        if (statusBox) {
            statusBox.classList.toggle('error', Boolean(isError));
        }

        const dlSelect = el.querySelector('[data-act="dl-minutes"]');
        const dlSourceBtn = el.querySelector('[data-act="dl-source-toggle"]');
        const dlBtn = el.querySelector('[data-act="download"]');
        const dlIdleRow = el.querySelector('[data-role="dl-idle-row"]');
        const dlActiveBox = el.querySelector('[data-role="dl-active-box"]');
        const dlProgressFill = el.querySelector('[data-role="dl-progress-fill"]');
        const dlSaveNowBtn = el.querySelector('[data-act="dl-save-now"]');
        const dlCancelBtn = el.querySelector('[data-act="dl-cancel"]');
        const dlGotoNextBtn = el.querySelector('[data-act="dl-goto-next"]');

        if (dlSelect) {
            const minsStr = String(state.downloadMinutes || DEFAULT_DOWNLOAD_MINUTES);
            let customOpt = dlSelect.querySelector('option[data-custom="true"]');
            const optionList = dlSelect.options || (typeof dlSelect.querySelectorAll === 'function' ? dlSelect.querySelectorAll('option') : []);
            const hasPreset = Array.from(optionList).some((opt) => (
                !(opt.dataset && opt.dataset.custom) &&
                (typeof opt.getAttribute !== 'function' || opt.getAttribute('data-custom') !== 'true') &&
                (opt.value || (typeof opt.getAttribute === 'function' ? opt.getAttribute('value') : '')) === minsStr
            ));
            if (!hasPreset) {
                if (!customOpt) {
                    customOpt = document.createElement('option');
                    if (typeof customOpt.setAttribute === 'function') {
                        customOpt.setAttribute('data-custom', 'true');
                    } else if (customOpt.dataset) {
                        customOpt.dataset.custom = 'true';
                    }
                    dlSelect.appendChild(customOpt);
                }
                customOpt.value = minsStr;
                customOpt.textContent = `${minsStr}p`;
            } else if (customOpt) {
                customOpt.remove();
            }
            dlSelect.value = minsStr;
            dlSelect.disabled = exportState.active;
        }
        if (dlIdleRow) dlIdleRow.hidden = exportState.active;
        if (dlActiveBox) dlActiveBox.hidden = !exportState.active;
        if (dlSourceBtn) {
            const hasColab = Boolean((state.colabServerUrl || '').trim());
            const isColab = state.downloadSource === 'colab_gpu';
            dlSourceBtn.hidden = !hasColab && !isColab;
            dlSourceBtn.classList.toggle('active', isColab);
            dlSourceBtn.textContent = isColab ? '⚡ Colab' : '🖥 Local';
            dlSourceBtn.title = isColab ? 'Đang dùng Google Colab GPU để tải WAV' : 'Chuyển nhanh sang Google Colab GPU';
            dlSourceBtn.disabled = exportState.active;
        }
        if (dlBtn) {
            dlBtn.disabled = exportState.active;
            dlBtn.textContent = tTts('btn_tts_download', '⬇ Tải Audio (WAV)');
        }
        if (dlSaveNowBtn) dlSaveNowBtn.textContent = tTts('tts_dl_save_now', '💾 Lưu ngay');
        if (dlCancelBtn) dlCancelBtn.textContent = tTts('tts_dl_cancel', '✖ Hủy tải');
        if (dlProgressFill && exportState.active) {
            const targetSec = Math.max(60, (exportState.targetMinutes || DEFAULT_DOWNLOAD_MINUTES) * 60);
            const pct = Math.min(100, Math.max(2, Math.round((exportState.accumulatedSec / targetSec) * 100)));
            dlProgressFill.style.width = `${pct}%`;
        }
        if (dlGotoNextBtn) {
            dlGotoNextBtn.hidden = exportState.active || !exportState.nextOpenUrl;
            const openNextLabel = tTts('tts_dl_open_next', '↪ Mở chương kế tiếp');
            dlGotoNextBtn.textContent = openNextLabel;
            dlGotoNextBtn.title = openNextLabel;
        }
    }

    function ensurePlayerUI() {
        injectTTSStyles();
        if (state.playerEl && state.playerHost && document.contains(state.playerHost)) {
            return state.playerEl;
        }
        let host = document.getElementById('stv-tts-root');
        if (!host) {
            host = document.createElement('div');
            host.id = 'stv-tts-root';
            host.style.cssText = 'position:fixed;right:18px;bottom:66px;z-index:2147483640;';
            (document.body || document.documentElement).appendChild(host);
        }
        const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '';

        const style = document.createElement('style');
        style.textContent = TTS_PLAYER_SHADOW_CSS;

        const box = document.createElement('div');
        box.id = 'stv-tts-player';
        box.innerHTML = `
            <div class="stv-tts-top">
                <span class="stv-tts-title">🔊 STV TTS</span>
                <span class="stv-tts-counter">0 / 0</span>
                <button class="stv-tts-close" data-act="close" title="Close">✖</button>
            </div>
            <div class="stv-tts-preview">...</div>
            <div class="stv-tts-controls">
                <div class="stv-tts-btn-group">
                    <button class="stv-tts-btn" data-act="prev" title="Prev">⏮</button>
                    <button class="stv-tts-btn primary" data-act="toggle" title="Play / Pause">▶</button>
                    <button class="stv-tts-btn" data-act="stop" title="Stop">⏹</button>
                    <button class="stv-tts-btn" data-act="next" title="Next">⏭</button>
                </div>
                <div class="stv-tts-speed">
                    <button class="stv-tts-btn" data-act="slower" title="Slower">-</button>
                    <span class="stv-tts-speed-val">1.0x</span>
                    <button class="stv-tts-btn" data-act="faster" title="Faster">+</button>
                </div>
            </div>
            <div class="stv-tts-status">
                <span class="stv-tts-status-text">Ready</span>
                <button class="stv-tts-pill" data-act="autonext" title="Auto Next">⏭ Auto</button>
            </div>
            <div class="stv-tts-dl-bar">
                <div class="stv-tts-dl-row" data-role="dl-idle-row">
                    <select class="stv-tts-dl-select" data-act="dl-minutes" aria-label="Audio duration minutes">
                        <option value="10">10p</option>
                        <option value="15">15p</option>
                        <option value="30" selected>30p</option>
                        <option value="45">45p</option>
                        <option value="60">60p</option>
                        <option value="90">90p</option>
                        <option value="120">120p</option>
                    </select>
                    <button type="button" class="stv-tts-pill" data-act="dl-source-toggle" hidden>🖥 Local</button>
                    <button type="button" class="stv-tts-btn stv-tts-dl-btn" data-act="download">⬇ Tải WAV</button>
                    <button type="button" class="stv-tts-btn stv-tts-dl-next" data-act="dl-goto-next" hidden>↪ Chương kế</button>
                </div>
                <div class="stv-tts-dl-active" data-role="dl-active-box" hidden>
                    <div class="stv-tts-dl-progress">
                        <div class="stv-tts-dl-progress-fill" data-role="dl-progress-fill"></div>
                    </div>
                    <div class="stv-tts-dl-active-row">
                        <button type="button" class="stv-tts-btn stv-tts-dl-save" data-act="dl-save-now">💾 Lưu ngay</button>
                        <button type="button" class="stv-tts-btn stv-tts-dl-cancel" data-act="dl-cancel">✖ Hủy tải</button>
                    </div>
                </div>
            </div>
        `;

        const dlSelect = box.querySelector('[data-act="dl-minutes"]');
        if (dlSelect) {
            dlSelect.addEventListener('change', (e) => {
                const mins = Math.max(1, Math.min(240, parseInt(e.target.value, 10) || DEFAULT_DOWNLOAD_MINUTES));
                state.downloadMinutes = mins;
                if (isExtensionAlive()) {
                    chrome.runtime.sendMessage({
                        action: 'set_runtime_setting',
                        key: 'ttsDownloadMinutes',
                        value: mins
                    }, () => { void chrome.runtime.lastError; });
                }
            });
        }

        box.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'toggle') togglePauseResume();
            else if (act === 'stop') stopPlayback(false);
            else if (act === 'close') stopPlayback(true);
            else if (act === 'prev') jumpToSegment(state.currentIndex - 1);
            else if (act === 'next') jumpToSegment(state.currentIndex + 1);
            else if (act === 'slower') changeSpeed(-0.1);
            else if (act === 'faster') changeSpeed(0.1);
            else if (act === 'autonext') toggleAutoNext();
            else if (act === 'dl-source-toggle') {
                state.downloadSource = state.downloadSource === 'colab_gpu' ? 'current' : 'colab_gpu';
                if (isExtensionAlive()) {
                    chrome.runtime.sendMessage({
                        action: 'set_runtime_setting',
                        key: 'ttsDownloadSource',
                        value: state.downloadSource
                    }, () => { void chrome.runtime.lastError; });
                }
                updatePlayerUI();
            }
            else if (act === 'download') void startTTSDownload({ downloadMinutes: state.downloadMinutes });
            else if (act === 'dl-save-now') requestSavePartialDownload();
            else if (act === 'dl-cancel') cancelTTSDownload();
            else if (act === 'dl-goto-next') openNextExportChapter();
        });

        shadow.append(style, box);
        state.playerHost = host;
        state.playerEl = box;
        return box;
    }

    function bindAltClickJump() {
        if (state.altClickBound) return;
        state.altClickBound = true;
        document.addEventListener('click', (e) => {
            if (!e.altKey || !state.playerEl || state.segments.length === 0) return;
            const lineEl = e.target.closest('.stv-line');
            if (!lineEl) return;
            const idx = state.segments.findIndex((s) => (
                s.domElement === lineEl || (Array.isArray(s.domElements) && s.domElements.includes(lineEl))
            ));
            if (idx !== -1) {
                e.preventDefault();
                jumpToSegment(idx);
            }
        });
    }

    function syncPrefetchCacheAlias() {
        if (state.prefetchQueue.size === 0) {
            state.prefetchCache = null;
            return;
        }
        const nextEntry = state.prefetchQueue.get(state.currentIndex + 1);
        if (nextEntry) {
            state.prefetchCache = nextEntry;
            return;
        }
        const firstKey = state.prefetchQueue.keys().next().value;
        state.prefetchCache = state.prefetchQueue.get(firstKey) || null;
    }

    function abortPrefetchPort() {
        if (state.prefetchPort) {
            try {
                state.prefetchPort.postMessage({ type: 'abort' });
                state.prefetchPort.disconnect();
            } catch {
                // ignore
            }
            state.prefetchPort = null;
        }
        if (state.prefetchIndex >= 0) {
            const entry = state.prefetchQueue.get(state.prefetchIndex);
            if (entry && !entry.done && !entry.onEvent) {
                entry.aborted = true;
                state.prefetchQueue.delete(state.prefetchIndex);
            }
            state.prefetchIndex = -1;
        }
        syncPrefetchCacheAlias();
    }

    function abortPorts() {
        if (state.activeWs) {
            try { state.activeWs.close(); } catch {}
            state.activeWs = null;
        }
        state.pendingWsDrained = false;
        state.activeUtterance = null;
        if (typeof global.speechSynthesis !== 'undefined' && typeof global.speechSynthesis.cancel === 'function') {
            try {
                if (global.speechSynthesis.paused && typeof global.speechSynthesis.resume === 'function') {
                    global.speechSynthesis.resume();
                }
                global.speechSynthesis.cancel();
            } catch {}
        }
        if (state.activePort) {
            try {
                state.activePort.postMessage({ type: 'abort' });
                state.activePort.disconnect();
            } catch {
                // ignore
            }
            state.activePort = null;
        }
        abortPrefetchPort();
        state.prefetchQueue.clear();
        state.prefetchIndex = -1;
        state.prefetchCache = null;
    }

    function isExtensionAlive() {
        try {
            return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
        } catch {
            return false;
        }
    }

    function safeConnectTtsPort() {
        if (!isExtensionAlive()) return null;
        try {
            return chrome.runtime.connect({ name: 'stv-tts-stream' });
        } catch {
            return null;
        }
    }

    function pumpPrefetchQueue(runId) {
        for (const idx of Array.from(state.prefetchQueue.keys())) {
            if (idx < state.currentIndex) {
                state.prefetchQueue.delete(idx);
            }
        }
        syncPrefetchCacheAlias();

        if (runId !== state.runId || !state.isPlaying || state.isPaused || state.activeEngine !== 'vieneu') return;
        // Chỉ chạy 1 stream tới VieNeu server tại mỗi thời điểm để tránh tranh chấp CPU lock
        if (state.activePort !== null || state.prefetchPort !== null) return;

        const maxIdx = Math.min(state.segments.length - 1, state.currentIndex + MAX_PREFETCH_SEGMENTS);
        let aheadChars = 0;
        for (let i = state.currentIndex + 1; i <= maxIdx; i++) {
            const countAhead = i - state.currentIndex;
            if (countAhead > PREFETCH_AHEAD_COUNT && aheadChars >= MIN_PREFETCH_CHARS) {
                break;
            }
            const seg = state.segments[i];
            if (seg && seg.iconResolveState === 'resolving' && seg.iconResolvePromise) {
                if (!seg._prefetchWaitBound) {
                    seg._prefetchWaitBound = true;
                    Promise.race([
                        seg.iconResolvePromise,
                        new Promise((resolve) => setTimeout(resolve, 2500))
                    ]).then(() => {
                        if (seg.iconResolveState === 'resolving') {
                            seg.iconResolveState = 'timed_out';
                        }
                        if (runId === state.runId && state.isPlaying && !state.isPaused) {
                            pumpPrefetchQueue(runId);
                        }
                    });
                }
                return;
            }
            aheadChars += (seg && seg.text) ? seg.text.length : 0;

            const existing = state.prefetchQueue.get(i);
            if (existing && !existing.error) continue;
            if (existing && existing.error && (existing.retries || 0) >= 2) {
                continue;
            }
            startPrefetch(i, runId);
            return;
        }
    }

    function startPrefetch(targetIndex, runId) {
        if (targetIndex < 0 || targetIndex >= state.segments.length) return;
        const existing = state.prefetchQueue.get(targetIndex);
        if (existing && !existing.error) return;
        const prevRetries = (existing && typeof existing.retries === 'number') ? existing.retries : 0;

        if (state.prefetchPort) {
            if (state.prefetchIndex === targetIndex) return;
            abortPrefetchPort();
        }

        const port = safeConnectTtsPort();
        if (!port) return;

        const seg = state.segments[targetIndex];
        const entry = {
            index: targetIndex,
            chunks: [],
            trimmedChunks: [],
            sampleRate: DEFAULT_SAMPLE_RATE,
            anchorTrimmer: null,
            anchorRate: null,
            firstFadeApplied: false,
            done: false,
            aborted: false,
            error: null,
            retries: prevRetries,
            onEvent: null,
            port
        };
        state.prefetchQueue.set(targetIndex, entry);
        state.prefetchPort = port;
        state.prefetchIndex = targetIndex;
        syncPrefetchCacheAlias();

        const pushTrimmedPrefetchAudio = (trimmed, sr) => {
            if (!trimmed || trimmed.length === 0) return;
            if (!entry.firstFadeApplied) {
                entry.firstFadeApplied = true;
                const fadeLen = Math.min(trimmed.length, Math.round(sr * 0.005));
                for (let i = 0; i < fadeLen; i++) trimmed[i] *= i / fadeLen;
            }
            entry.trimmedChunks.push(trimmed);
        };

        port.onMessage.addListener((msg) => {
            if (runId !== state.runId || entry.aborted) {
                try { port.disconnect(); } catch {}
                return;
            }
            if (entry.onEvent) {
                entry.onEvent(msg);
                return;
            }
            if (msg.type === 'chunk') {
                const sr = msg.sampleRate || entry.sampleRate || DEFAULT_SAMPLE_RATE;
                entry.sampleRate = sr;
                if (!entry.anchorTrimmer || entry.anchorRate !== sr) {
                    entry.anchorRate = sr;
                    entry.anchorTrimmer = createAnchorTrimmer(sr);
                }
                const rawChunk = decodePcm16Base64ToFloat32(msg.audio);
                if (rawChunk.length > 0) {
                    const trimmed = entry.anchorTrimmer.push(rawChunk);
                    pushTrimmedPrefetchAudio(trimmed, sr);
                }
            } else if (msg.type === 'done') {
                if (entry.anchorTrimmer) {
                    const rest = entry.anchorTrimmer.flush();
                    pushTrimmedPrefetchAudio(rest, entry.sampleRate);
                    entry.anchorTrimmer = null;
                }
                entry.done = true;
                entry.port = null;
                if (state.prefetchPort === port) {
                    state.prefetchPort = null;
                    state.prefetchIndex = -1;
                }
                try { port.disconnect(); } catch {}
                ttsLog(`Prefetch #${targetIndex + 1} ready (${entry.trimmedChunks.length} chunks)`);
                pumpPrefetchQueue(runId);
            } else if (msg.type === 'error') {
                entry.error = msg.error;
                entry.done = true;
                entry.retries += 1;
                entry.chunks = [];
                entry.trimmedChunks = [];
                entry.anchorTrimmer = null;
                entry.port = null;
                syncPrefetchCacheAlias();
                if (state.prefetchPort === port) {
                    state.prefetchPort = null;
                    state.prefetchIndex = -1;
                }
                try { port.disconnect(); } catch {}
                if (!state.isPaused) {
                    pumpPrefetchQueue(runId);
                }
            }
        });

        port.onDisconnect.addListener(() => {
            void chrome?.runtime?.lastError;
            if (state.prefetchPort === port) {
                state.prefetchPort = null;
                state.prefetchIndex = -1;
            }
            if (state.activePort === port) state.activePort = null;
            entry.port = null;
            if (runId !== state.runId || entry.done || entry.aborted) return;
            entry.error = entry.error || 'Background connection closed.';
            entry.done = true;
            if (entry.onEvent) {
                entry.onEvent({ type: 'error', error: entry.error });
            } else {
                entry.retries += 1;
                entry.chunks = [];
                entry.trimmedChunks = [];
                entry.anchorTrimmer = null;
                syncPrefetchCacheAlias();
                if (!state.isPaused) {
                    pumpPrefetchQueue(runId);
                }
            }
        });

        try {
            port.postMessage({
                type: 'start',
                text: formatTtsInputText(seg.text),
                voice: state.voice,
                serverUrl: state.serverUrl,
                apiKey: state.apiKey,
                sampleRate: DEFAULT_SAMPLE_RATE,
                sampling: getSamplingParams(state.stabilityProfile)
            });
        } catch {
            entry.aborted = true;
            state.prefetchQueue.delete(targetIndex);
            syncPrefetchCacheAlias();
            if (state.prefetchPort === port) {
                state.prefetchPort = null;
                state.prefetchIndex = -1;
            }
            try { port.disconnect(); } catch {}
        }
    }

    function estimateRemainingPlaybackSeconds(fromIndex) {
        let totalChars = 0;
        const start = Math.max(0, fromIndex);
        for (let i = start; i < state.segments.length; i++) {
            const txt = state.segments[i] && state.segments[i].text;
            if (txt) totalChars += txt.length;
        }
        const charsPerSec = 17.5 * Math.max(0.5, state.speed || 1.0);
        return totalChars / charsPerSec;
    }

    function clearPreloadTimer() {
        if (state.preloadTimer) {
            clearTimeout(state.preloadTimer);
            state.preloadTimer = null;
        }
    }

    function disconnectPreloadWatchPort() {
        const port = state.preloadWatchPort;
        if (port) {
            state.preloadWatchPort = null;
            try { port.disconnect(); } catch {}
        }
    }

    function getEffectivePreloadLeadSec() {
        // Dịch AI (đặc biệt model suy luận) thường mất 60-90s/chương nên luôn tải sớm >=90s
        return state.wasTranslated ? Math.max(state.preloadLeadSec, 90) : state.preloadLeadSec;
    }

    function cancelPreload() {
        clearPreloadTimer();
        disconnectPreloadWatchPort();
        state.preloadRetryCount = 0;
        state.preloadRequestInFlight = false;
        if (!state.preloadTriggered && !state.preloadDone && state.preloadState === 'idle') return;
        state.preloadTriggered = false;
        state.preloadDone = false;
        state.preloadId = null;
        state.preloadState = 'idle';
        try {
            chrome.runtime.sendMessage({
                action: 'cancel_chapter_preload',
                url: state.nextChapterUrl || ''
            }, () => {
                void chrome.runtime.lastError;
            });
        } catch {
            // ignore
        }
    }

    function refreshNextChapterUrl() {
        const doc = typeof document !== 'undefined' ? document : (global?.document || null);
        if (!doc || typeof global.STV_findNextChapterUrl !== 'function') return state.nextChapterUrl;
        const currentHref = (global.location && global.location.href) || '';
        const found = global.STV_findNextChapterUrl(doc, currentHref);
        if (found && found !== state.nextChapterUrl) {
            state.nextChapterUrl = found;
            updatePlayerUI();
        }
        return state.nextChapterUrl;
    }

    function maybeTriggerNextChapterPreload(options = {}) {
        const { forceVerify = false } = options || {};
        refreshNextChapterUrl();
        clearPreloadTimer();
        if (!state.autoNextChapter || !state.nextChapterUrl) return;
        if (!state.isPlaying || state.isPaused) return;
        const transState = global.STV_translationState;
        if (state.liveTranslationRunId && transState && transState.active && transState.runId === state.liveTranslationRunId) {
            return;
        }

        const wasDone = state.preloadDone;
        if (state.preloadState === 'error' || (state.preloadTriggered && !state.preloadDone && !state.preloadWatchPort && !state.preloadRequestInFlight)) {
            state.preloadTriggered = false;
            state.preloadDone = false;
        } else if (forceVerify && state.preloadTriggered && state.preloadDone) {
            state.preloadTriggered = false;
            state.preloadDone = false;
        }
        if (state.preloadTriggered) return;

        const shouldVerifyNow = Boolean(forceVerify && wasDone);
        const effectiveLeadSec = getEffectivePreloadLeadSec();
        const remainingSegments = state.segments.length - state.currentIndex;
        const estRemainingSec = estimateRemainingPlaybackSeconds(state.currentIndex);
        if (!shouldVerifyNow && estRemainingSec > effectiveLeadSec && remainingSegments > 1) {
            if (state.preloadState !== 'idle') {
                state.preloadState = 'idle';
                updatePlayerUI();
            }
            const delayMs = Math.max(250, Math.round((estRemainingSec - effectiveLeadSec) * 1000));
            const capturedRun = state.runId;
            state.preloadTimer = setTimeout(() => {
                state.preloadTimer = null;
                if (state.runId === capturedRun && state.isPlaying && !state.isPaused) {
                    maybeTriggerNextChapterPreload();
                }
            }, delayMs);
            return;
        }

        const targetUrl = state.nextChapterUrl;
        const capturedRun = state.runId;
        state.preloadTriggered = true;
        state.preloadDone = false;
        state.preloadRequestInFlight = true;
        if (state.preloadState !== 'ready' || !shouldVerifyNow) {
            state.preloadState = 'loading';
            updatePlayerUI();
        }

        const schedulePreloadRetry = () => {
            if (state.runId !== capturedRun || !state.isPlaying || state.isPaused || !state.autoNextChapter || state.nextChapterUrl !== targetUrl) {
                return;
            }
            if (state.preloadRetryCount >= state.preloadUpperRetryLimit) {
                return;
            }
            state.preloadRetryCount += 1;
            const retryDelay = 1500 * state.preloadRetryCount;
            clearPreloadTimer();
            state.preloadTimer = setTimeout(() => {
                state.preloadTimer = null;
                if (state.runId === capturedRun && state.isPlaying && !state.isPaused) {
                    maybeTriggerNextChapterPreload();
                }
            }, retryDelay);
        };

        try {
            chrome.runtime.sendMessage({
                action: 'start_chapter_preload',
                url: targetUrl,
                mode: state.wasTranslated ? 'translate' : 'tts_only'
            }, (resp) => {
                state.preloadRequestInFlight = false;
                if (!state.preloadTriggered || state.runId !== capturedRun || state.nextChapterUrl !== targetUrl) {
                    return;
                }
                if (chrome.runtime.lastError || !resp || !resp.ok) {
                    state.preloadState = 'error';
                    state.preloadTriggered = false;
                    state.preloadDone = false;
                    updatePlayerUI();
                    schedulePreloadRetry();
                    return;
                }
                state.preloadId = resp.preloadId || null;
                if (resp.status === 'ready') {
                    state.preloadState = 'ready';
                    state.preloadDone = true;
                    state.preloadRetryCount = 0;
                    updatePlayerUI();
                    return;
                }

                state.preloadState = 'loading';
                updatePlayerUI();

                // Giữ Port stv-preload-stream mở để MV3 Service Worker không sleep giữa chừng và cập nhật ngay khi sẵn sàng
                if (resp.preloadId && typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.connect === 'function') {
                    disconnectPreloadWatchPort();
                    try {
                        const watchPort = chrome.runtime.connect({ name: 'stv-preload-stream' });
                        state.preloadWatchPort = watchPort;
                        let streamCompleted = false;
                        let streamErrored = false;

                        watchPort.onMessage.addListener((msg) => {
                            if (!msg || state.preloadWatchPort !== watchPort || !state.preloadTriggered || state.runId !== capturedRun) {
                                return;
                            }
                            if (msg.type === 'error') {
                                streamErrored = true;
                                state.preloadState = 'error';
                                state.preloadTriggered = false;
                                state.preloadDone = false;
                                disconnectPreloadWatchPort();
                                updatePlayerUI();
                                schedulePreloadRetry();
                                return;
                            }

                            if (msg.done) {
                                streamCompleted = true;
                                state.preloadDone = true;
                                state.preloadState = 'ready';
                                state.preloadRetryCount = 0;
                                updatePlayerUI();
                                disconnectPreloadWatchPort();
                            }
                        });

                        watchPort.onDisconnect.addListener(() => {
                            void chrome?.runtime?.lastError;
                            const wasActiveWatch = state.preloadWatchPort === watchPort;
                            if (wasActiveWatch) {
                                state.preloadWatchPort = null;
                            }
                            if (!wasActiveWatch || streamCompleted || streamErrored) return;
                            if (state.preloadTriggered && state.runId === capturedRun) {
                                state.preloadTriggered = false;
                                state.preloadDone = false;
                                state.preloadState = state.isPaused ? 'idle' : 'error';
                                updatePlayerUI();
                                if (!state.isPaused) {
                                    schedulePreloadRetry();
                                }
                            }
                        });

                        watchPort.postMessage({ type: 'subscribe', preloadId: resp.preloadId });
                    } catch {
                        // ignore port watch failure
                    }
                }
            });
        } catch {
            state.preloadRequestInFlight = false;
            state.preloadState = 'error';
            state.preloadTriggered = false;
            state.preloadDone = false;
            updatePlayerUI();
            schedulePreloadRetry();
        }
    }

    function toggleAutoNext() {
        state.autoNextChapter = !state.autoNextChapter;
        chrome.runtime.sendMessage({
            action: 'set_runtime_setting',
            key: 'ttsAutoNextChapter',
            value: state.autoNextChapter
        }, () => { void chrome.runtime.lastError; });
        if (!state.autoNextChapter) {
            cancelPreload();
        } else {
            maybeTriggerNextChapterPreload();
        }
        updatePlayerUI();
    }

    function finishChapterPlayback() {
        state.waitingForMoreSegments = false;
        state.isPlaying = false;
        state.isPaused = false;
        state.autoplayBlocked = false;
        state.currentSession = null;
        abortPorts();
        disconnectPreloadWatchPort();
        stopStreamPlayer(true);
        clearHighlight();
        refreshNextChapterUrl();

        if (state.autoNextChapter && state.nextChapterUrl) {
            updatePlayerUI('⏭ Đang chuyển sang chương tiếp theo...');
            const canRendererNavigate = Boolean(global.location && typeof global.location.assign === 'function');
            try {
                chrome.runtime.sendMessage({
                    action: 'navigate_next_chapter',
                    url: state.nextChapterUrl,
                    mode: state.wasTranslated ? 'translate' : 'tts_only',
                    rendererNavigate: canRendererNavigate
                }, (resp) => {
                    if (chrome.runtime.lastError || !resp || !resp.ok) {
                        const errMsg = resp?.error || chrome.runtime.lastError?.message || 'Không rõ lỗi';
                        updatePlayerUI('Lỗi chuyển chương: ' + errMsg, true);
                        return;
                    }
                    if (resp.rendererNavigate && resp.targetUrl && global.location && typeof global.location.assign === 'function') {
                        try {
                            global.location.assign(resp.targetUrl);
                        } catch {
                            chrome.runtime.sendMessage({
                                action: 'navigate_next_chapter',
                                url: resp.targetUrl,
                                mode: state.wasTranslated ? 'translate' : 'tts_only',
                                rendererNavigate: false
                            }, () => { void chrome.runtime.lastError; });
                        }
                    }
                });
            } catch (err) {
                updatePlayerUI('Lỗi chuyển chương: ' + (err?.message || err), true);
            }
            return;
        }

        updatePlayerUI('Đã đọc hết chương!');
    }

    function tTts(key, fallback) {
        if (global.STV_I18n && typeof global.STV_I18n.t === 'function') {
            return global.STV_I18n.t(key);
        }
        return fallback || key;
    }

    function notifyTtsToast(msg, type = 'warning') {
        if (typeof global.STV_showToast === 'function') {
            global.STV_showToast(msg, type, 4500);
        }
    }

    function fallbackToWebSpeech(index, runId, reason) {
        if (runId !== state.runId) return;
        state.activeEngine = 'webspeech';
        if (!state.wsFallbackNotified) {
            state.wsFallbackNotified = true;
            notifyTtsToast(tTts('tts_fallback_notice', 'WebSocket TTS unavailable — switched to Web Speech API.'), 'warning');
        }
        updatePlayerUI();
        playSegmentWebSpeech(index, runId);
    }

    function playSegmentWebSpeech(index, runId) {
        if (runId !== state.runId) return;
        const synth = global.speechSynthesis;
        const Utterance = global.SpeechSynthesisUtterance;
        if (!synth || typeof Utterance !== 'function') {
            handleSegmentError(tTts('tts_webspeech_unavailable', 'Web Speech API is not supported.'), runId);
            return;
        }

        const seg = state.segments[index];
        if (!seg) return;

        try { synth.cancel(); } catch {}

        const utter = new Utterance(seg.text);
        utter.rate = Math.max(0.5, Math.min(2.0, state.speed || 1.0));

        const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
        const preferred = voices.find((v) => state.voice && v.name === state.voice)
            || voices.find((v) => /^vi/i.test(v.lang))
            || voices.find((v) => /^en/i.test(v.lang))
            || voices[0];
        if (preferred) {
            utter.voice = preferred;
            utter.lang = preferred.lang;
        } else {
            utter.lang = 'vi-VN';
        }

        let settled = false;
        state.activeUtterance = utter;
        utter.onend = () => {
            if (state.activeUtterance === utter) state.activeUtterance = null;
            if (settled || runId !== state.runId || state.isPaused) return;
            settled = true;
            playSegment(index + 1, runId);
        };
        utter.onerror = (ev) => {
            if (state.activeUtterance === utter) state.activeUtterance = null;
            if (settled || runId !== state.runId) return;
            settled = true;
            const errType = ev && ev.error;
            if (errType === 'canceled' || errType === 'interrupted') return;
            handleSegmentError(`Web Speech error: ${errType || 'unknown'}`, runId);
        };

        updatePlayerUI();
        synth.speak(utter);
    }

    function playSegmentWebSocket(index, runId) {
        if (runId !== state.runId) return;
        const seg = state.segments[index];
        if (!seg) return;

        const wsUrl = (state.wsEndpoint || '').trim();
        const isOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
        const canUseWs = Boolean(wsUrl && /^wss?:\/\//i.test(wsUrl) && typeof global.WebSocket === 'function' && !isOffline);

        if (!canUseWs) {
            if (state.wsAutoFallback) {
                fallbackToWebSpeech(index, runId, isOffline ? 'offline' : 'no_ws_endpoint');
            } else {
                handleSegmentError('WebSocket TTS endpoint not configured or offline.', runId);
            }
            return;
        }

        const audioCtx = ensureAudioContext();
        const streamPlayer = ensureStreamPlayer(audioCtx);
        streamPlayer.clear();
        state.streamToken += 1;
        const segmentToken = state.streamToken;

        let settled = false;
        let receivedAudio = false;
        let ws;
        try {
            ws = new global.WebSocket(wsUrl);
            ws.binaryType = 'arraybuffer';
        } catch (err) {
            if (state.wsAutoFallback) {
                fallbackToWebSpeech(index, runId, err?.message || 'ws_init_error');
            } else {
                handleSegmentError(err?.message || 'WebSocket connection failed', runId);
            }
            return;
        }
        state.activeWs = ws;

        const connectTimer = setTimeout(() => {
            if (!receivedAudio && !settled && runId === state.runId) {
                settled = true;
                try { ws.close(); } catch {}
                if (state.activeWs === ws) state.activeWs = null;
                if (state.isPaused) {
                    state.pendingWsReplay = true;
                    return;
                }
                if (state.wsAutoFallback) {
                    fallbackToWebSpeech(index, runId, 'ws_timeout');
                } else {
                    handleSegmentError('WebSocket TTS connection timeout.', runId);
                }
            }
        }, 3000);

        state.pendingWsDrained = false;
        streamPlayer.setDrainedHandler((tok) => {
            if (tok !== segmentToken || runId !== state.runId) return;
            if (state.isPaused) {
                state.pendingWsDrained = true;
                return;
            }
            playSegment(index + 1, runId);
        });

        ws.onopen = () => {
            if (runId !== state.runId) {
                try { ws.close(); } catch {}
                return;
            }
            try {
                ws.send(JSON.stringify({
                    type: 'tts.synthesize',
                    text: seg.text,
                    voice: state.wsVoice || state.voice || 'vi-VN-HoaiMyNeural',
                    rate: state.speed || 1.0,
                    sample_rate: DEFAULT_SAMPLE_RATE
                }));
            } catch {
                clearTimeout(connectTimer);
                if (!settled && state.wsAutoFallback) {
                    settled = true;
                    fallbackToWebSpeech(index, runId, 'ws_send_error');
                }
            }
        };

        ws.onmessage = (ev) => {
            if (runId !== state.runId || settled) return;
            if (ev.data instanceof ArrayBuffer) {
                const evenLen = ev.data.byteLength - (ev.data.byteLength % 2);
                if (evenLen <= 0) return;
                receivedAudio = true;
                clearTimeout(connectTimer);
                const view = new Int16Array(ev.data, 0, evenLen / 2);
                const f32 = new Float32Array(view.length);
                for (let i = 0; i < view.length; i++) f32[i] = view[i] / 32768;
                streamPlayer.push(f32, DEFAULT_SAMPLE_RATE);
                updatePlayerUI();
                return;
            }
            try {
                const msg = JSON.parse(String(ev.data || '{}'));
                if (msg.error) {
                    throw new Error(msg.error);
                }
                if (msg.audio) {
                    receivedAudio = true;
                    clearTimeout(connectTimer);
                    const f32 = decodePcm16Base64ToFloat32(msg.audio);
                    streamPlayer.push(f32, msg.sampleRate || DEFAULT_SAMPLE_RATE);
                    updatePlayerUI();
                }
                if (msg.done || msg.type === 'done') {
                    settled = true;
                    clearTimeout(connectTimer);
                    try { ws.close(); } catch {}
                    if (state.activeWs === ws) state.activeWs = null;
                    if (receivedAudio) {
                        streamPlayer.flush(segmentToken);
                    } else {
                        playSegment(index + 1, runId);
                    }
                }
            } catch (err) {
                settled = true;
                clearTimeout(connectTimer);
                try { ws.close(); } catch {}
                if (state.activeWs === ws) state.activeWs = null;
                if (state.isPaused) {
                    state.pendingWsReplay = true;
                    return;
                }
                if (state.wsAutoFallback) {
                    fallbackToWebSpeech(index, runId, err?.message || 'ws_msg_error');
                } else {
                    handleSegmentError(err?.message || 'WebSocket TTS error', runId);
                }
            }
        };

        ws.onerror = () => {
            if (settled || runId !== state.runId) return;
            settled = true;
            clearTimeout(connectTimer);
            if (state.activeWs === ws) state.activeWs = null;
            if (state.isPaused) {
                state.pendingWsReplay = true;
                return;
            }
            if (state.wsAutoFallback) {
                fallbackToWebSpeech(index, runId, 'ws_error');
            } else {
                handleSegmentError('WebSocket TTS connection failed.', runId);
            }
        };

        ws.onclose = () => {
            clearTimeout(connectTimer);
            if (state.activeWs === ws) state.activeWs = null;
            if (!settled && runId === state.runId) {
                settled = true;
                stopStreamPlayer(false);
                if (state.isPaused) {
                    state.pendingWsReplay = true;
                    return;
                }
                if (state.wsAutoFallback) {
                    fallbackToWebSpeech(index, runId, 'WebSocket closed unexpectedly');
                } else {
                    handleSegmentError('WebSocket TTS closed unexpectedly.', runId);
                }
            }
        };
    }

    function scheduleAiIconResolution(segments, runId, { isExport = false, timeoutMs = 6000 } = {}) {
        if (!Array.isArray(segments) || segments.length === 0) return Promise.resolve();
        const describer = getIconDescriber();
        const pendingIndices = [];
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (seg && seg.needsAiIconResolve && seg.iconResolveState === 'pending') {
                pendingIndices.push(i);
            }
        }
        if (pendingIndices.length === 0) return Promise.resolve();

        if (!describer || state.iconMode !== 'auto' || state.aiIconsUnavailable || !isExtensionAlive() || typeof chrome?.runtime?.sendMessage !== 'function') {
            for (const idx of pendingIndices) {
                segments[idx].iconResolveState = 'fallback';
            }
            return Promise.resolve();
        }

        const isRunStillActive = () => (isExport
            ? (exportState.runId === runId && !exportState.aborted && !exportState.savePartialRequested)
            : (state.runId === runId));

        const batches = [];
        for (let offset = 0; offset < pendingIndices.length; offset += 12) {
            batches.push(pendingIndices.slice(offset, offset + 12));
        }

        const batchPromises = batches.map((batchIdxList) => {
            const items = batchIdxList.map((idx) => {
                const seg = segments[idx];
                const prevSeg = idx > 0 ? segments[idx - 1] : null;
                const nextSeg = idx + 1 < segments.length ? segments[idx + 1] : null;
                return {
                    id: idx,
                    prev: prevSeg ? (prevSeg.rawText || prevSeg.text || '') : '',
                    text: seg.aiRawText || seg.rawText || seg.text || '',
                    fallbackText: seg.text || '',
                    next: nextSeg ? (nextSeg.rawText || nextSeg.text || '') : '',
                    icons: Array.isArray(seg.iconTokens) ? seg.iconTokens.map((t) => t.raw) : []
                };
            });
            const batchLang = segments[batchIdxList[0]]?.iconLang || 'vi';

            const batchPromise = new Promise((resolve) => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    for (const idx of batchIdxList) {
                        const s = segments[idx];
                        if (s && s.iconResolveState === 'resolving') {
                            s.iconResolveState = 'fallback';
                        }
                    }
                    resolve();
                };

                const timer = setTimeout(finish, timeoutMs);

                try {
                    chrome.runtime.sendMessage({
                        action: 'resolve_tts_icons',
                        style: state.iconStyle || 'tagged',
                        lang: batchLang,
                        items
                    }, (resp) => {
                        if (settled) return;
                        void chrome?.runtime?.lastError;
                        if (!isRunStillActive()) {
                            finish();
                            return;
                        }
                        if (resp && resp.reason === 'no_api_key') {
                            state.aiIconsUnavailable = true;
                            finish();
                            return;
                        }
                        if (resp && resp.ok && Array.isArray(resp.results)) {
                            for (const resItem of resp.results) {
                                const seg = segments[resItem.id];
                                if (!seg || !batchIdxList.includes(resItem.id)) continue;
                                const cleanedSpoken = cleanTextForSpeech(
                                    describer.sanitizeAiSpokenText(resItem.spoken, seg.aiRawText || seg.rawText || seg.text, seg.text, {
                                        iconCount: (seg.iconTokens && seg.iconTokens.length) || 1
                                    }),
                                    { _skipIconDescribe: true }
                                );
                                if (cleanedSpoken) {
                                    seg.text = cleanedSpoken;
                                    seg.iconResolveState = 'done';
                                }
                            }
                            if (resp.cacheUpdates && typeof resp.cacheUpdates === 'object') {
                                state.iconLearnedCache = { ...(state.iconLearnedCache || {}), ...resp.cacheUpdates };
                            }
                            if (!isExport && state.playerEl && batchIdxList.includes(state.currentIndex)) {
                                updatePlayerUI();
                            }
                        }
                        finish();
                    });
                } catch {
                    finish();
                }
            });

            for (const idx of batchIdxList) {
                segments[idx].iconResolveState = 'resolving';
                segments[idx].iconResolvePromise = batchPromise;
            }
            return batchPromise;
        });

        return Promise.all(batchPromises);
    }

    function playSegment(index, runId, { seamless = false } = {}) {
        if (runId !== state.runId) return;
        if (index < 0 || index >= state.segments.length) {
            const transState = global.STV_translationState;
            if (index >= 0 && state.liveTranslationRunId && transState && transState.active && transState.runId === state.liveTranslationRunId) {
                state.currentIndex = index;
                state.isPlaying = true;
                state.isPaused = false;
                state.waitingForMoreSegments = true;
                state.currentSession = null;
                stopStreamPlayer(false);
                clearHighlight();
                updatePlayerUI('Đang đợi AI dịch tiếp...');
                return;
            }
            finishChapterPlayback();
            return;
        }

        state.waitingForMoreSegments = false;
        state.pendingWsReplay = false;
        state.currentIndex = index;
        state.isPlaying = true;
        state.isPaused = false;
        state.currentSession = null;

        const seg = state.segments[index];
        if (seg && seg.iconResolveState === 'resolving' && seg.iconResolvePromise) {
            highlightSegment(index);
            maybeTriggerNextChapterPreload();
            updatePlayerUI(tTts('tts_status_resolving_icons', 'Đang phân tích biểu cảm...'));
            Promise.race([
                seg.iconResolvePromise,
                new Promise((resolve) => setTimeout(resolve, 2500))
            ]).then(() => {
                if (runId !== state.runId || !state.isPlaying || state.isPaused) return;
                if (seg.iconResolveState === 'resolving') {
                    seg.iconResolveState = 'timed_out';
                }
                playSegment(index, runId, { seamless });
            });
            return;
        }

        highlightSegment(index);
        maybeTriggerNextChapterPreload();

        if (state.activeEngine === 'webspeech') {
            playSegmentWebSpeech(index, runId);
            return;
        }
        if (state.activeEngine === 'ws_default') {
            updatePlayerUI('Đang kết nối WebSocket TTS...');
            playSegmentWebSocket(index, runId);
            return;
        }

        const audioCtx = ensureAudioContext();
        const streamPlayer = ensureStreamPlayer(audioCtx);
        if (!seamless) {
            streamPlayer.clear();
        }
        state.streamToken += 1;
        const segmentToken = state.streamToken;

        const prevSeg = index > 0 ? state.segments[index - 1] : null;
        const isSameLineContinuation = Boolean(
            seamless && prevSeg && seg.domElement && prevSeg.domElement === seg.domElement
        );
        const initialPrerollSec = isSameLineContinuation
            ? CONTINUATION_PREROLL_SEC
            : (seamless ? 0.025 : FIRST_CHUNK_PREROLL_SEC);
        const targetPrebufferSec = state.speed <= 1.05
            ? 0.22
            : Math.min(1.10, 0.25 + (state.speed - 1.0) * 1.0);

        const session = {
            index,
            runId,
            audioCtx,
            streamPlayer,
            streamToken: segmentToken,
            sampleRate: DEFAULT_SAMPLE_RATE,
            wsolaRate: null,
            initialPrerollSec,
            targetPrebufferSec,
            pendingPrebuffer: [],
            pendingPrebufferSamples: 0,
            prebufferFlushed: false,
            preRollScheduled: false,
            rawChunks: [],
            totalRawSamples: 0,
            baseSourceSample: 0,
            pausedRawSample: null,
            startCtxTime: null,
            speedAtRunStart: state.speed,
            wsola: null,
            anchorTrimmer: null,
            anchorRate: null,
            streamDone: false,
            interruptedWhilePaused: false,
            finishedHandled: false,
            feedGen: 0,
            feedTimer: null,
            cancelAsyncFeed() {
                this.feedGen += 1;
                if (this.feedTimer) {
                    clearTimeout(this.feedTimer);
                    this.feedTimer = null;
                }
            },
            ensureAnchorTrimmer(sr) {
                const effectiveSr = sr || this.sampleRate || DEFAULT_SAMPLE_RATE;
                if (!this.anchorTrimmer || this.anchorRate !== effectiveSr) {
                    this.sampleRate = effectiveSr;
                    this.anchorRate = effectiveSr;
                    this.anchorTrimmer = createAnchorTrimmer(effectiveSr);
                }
                return this.anchorTrimmer;
            },
            ensureWsola(sr) {
                const effectiveSr = sr || this.sampleRate || DEFAULT_SAMPLE_RATE;
                if (this.wsolaRate !== effectiveSr) {
                    this.sampleRate = effectiveSr;
                    this.wsolaRate = effectiveSr;
                    this.speedAtRunStart = state.speed;
                    this.wsola = Math.abs(state.speed - 1.0) < 0.001
                        ? null
                        : new WSOLAProcessor(effectiveSr, state.speed);
                }
                return this.wsola;
            },
            advanceToNext() {
                if (this.finishedHandled || this.runId !== state.runId || state.currentSession !== this) return;
                this.finishedHandled = true;
                this.cancelAsyncFeed();
                state.currentSession = null;
                playSegment(this.index + 1, this.runId, { seamless: true });
            },
            _pushToStreamPlayer(processedFloat32) {
                if (!processedFloat32 || processedFloat32.length === 0) return;
                // Chèn khoảng lặng đầu câu (pre-roll) trước khi phát âm tiết đầu tiên
                if (!this.preRollScheduled) {
                    this.preRollScheduled = true;
                    const preSamples = Math.round(this.sampleRate * this.initialPrerollSec);
                    if (preSamples > 0) {
                        this.streamPlayer.push(new Float32Array(preSamples), this.sampleRate);
                    }
                }
                if (this.startCtxTime === null) {
                    this.startCtxTime = this.audioCtx.currentTime + this.streamPlayer.getQueuedSeconds();
                }
                this.streamPlayer.push(processedFloat32, this.sampleRate);
            },
            flushPrebuffer() {
                if (this.prebufferFlushed) return;
                this.prebufferFlushed = true;
                const queued = this.pendingPrebuffer;
                this.pendingPrebuffer = [];
                this.pendingPrebufferSamples = 0;
                for (let i = 0; i < queued.length; i++) {
                    this._pushToStreamPlayer(queued[i]);
                }
            },
            scheduleProcessed(processedFloat32) {
                if (!processedFloat32 || processedFloat32.length === 0) return;
                if (!this.prebufferFlushed && !this.streamDone) {
                    this.pendingPrebuffer.push(processedFloat32);
                    this.pendingPrebufferSamples += processedFloat32.length;
                    if (this.pendingPrebufferSamples >= Math.round(this.sampleRate * this.targetPrebufferSec)) {
                        this.flushPrebuffer();
                    }
                    return;
                }
                this.flushPrebuffer();
                this._pushToStreamPlayer(processedFloat32);
            },
            _acceptTrimmedRaw(raw, sampleRate) {
                if (!raw || raw.length === 0) return;
                this.rawChunks.push(raw);
                this.totalRawSamples += raw.length;
                if (state.isPaused) return;
                const wsola = this.ensureWsola(sampleRate);
                const processed = wsola ? wsola.process(raw) : raw;
                this.scheduleProcessed(processed);
            },
            pushPcmBase64(base64Audio, sampleRate) {
                const rawChunk = decodePcm16Base64ToFloat32(base64Audio);
                if (rawChunk.length === 0) return;
                const trimmed = this.ensureAnchorTrimmer(sampleRate).push(rawChunk);
                if (trimmed && trimmed.length > 0) {
                    if (this.totalRawSamples === 0) {
                        const sr = sampleRate || this.sampleRate || DEFAULT_SAMPLE_RATE;
                        const fadeLen = Math.min(trimmed.length, Math.round(sr * 0.005));
                        for (let i = 0; i < fadeLen; i++) trimmed[i] *= i / fadeLen;
                    }
                    this._acceptTrimmedRaw(trimmed, sampleRate);
                }
            },
            finishStream() {
                this.streamDone = true;
                if (this.anchorTrimmer) {
                    const rest = this.anchorTrimmer.flush();
                    if (rest && rest.length > 0) {
                        if (this.totalRawSamples === 0) {
                            const sr = this.sampleRate || DEFAULT_SAMPLE_RATE;
                            const fadeLen = Math.min(rest.length, Math.round(sr * 0.005));
                            for (let i = 0; i < fadeLen; i++) rest[i] *= i / fadeLen;
                        }
                        this._acceptTrimmedRaw(rest, this.sampleRate);
                    }
                }
                if (state.isPaused) return;
                if (this.wsola) {
                    this.scheduleProcessed(this.wsola.flush());
                }
                this.flushPrebuffer();
                if (!this.preRollScheduled) {
                    this.advanceToNext();
                    return;
                }
                this.streamPlayer.flush(this.streamToken);
            }
        };
        state.currentSession = session;
        streamPlayer.setDrainedHandler((tok) => {
            if (tok === session.streamToken && session.runId === state.runId && state.currentSession === session) {
                session.advanceToNext();
            }
        });

        // Dùng buffer đã pre-fetch từ hàng đợi nếu khớp chỉ số
        const cached = state.prefetchQueue.get(index);
        if (cached) {
            state.prefetchQueue.delete(index);
            syncPrefetchCacheAlias();
        }
        if (cached && !cached.error) {
            if (cached.done) {
                const cachedChunks = cached.trimmedChunks || [];
                const sr = cached.sampleRate || DEFAULT_SAMPLE_RATE;
                ttsLog(`Seg #${index + 1} cache HIT (${cachedChunks.length} chunks)`);
                session.sampleRate = sr;
                session.streamDone = true;
                for (let i = 0; i < cachedChunks.length; i++) {
                    const c = cachedChunks[i];
                    if (c && c.length > 0) {
                        session.rawChunks.push(c);
                        session.totalRawSamples += c.length;
                    }
                }
                updatePlayerUI();
                pumpPrefetchQueue(runId);

                if (state.isPaused) return;
                if (session.totalRawSamples === 0) {
                    session.advanceToNext();
                    return;
                }

                const wsola = session.ensureWsola(sr);
                const syncThresholdSamples = Math.round(sr * 1.5);
                if (!wsola || session.totalRawSamples <= syncThresholdSamples) {
                    for (let i = 0; i < session.rawChunks.length; i++) {
                        const raw = session.rawChunks[i];
                        const processed = wsola ? wsola.process(raw) : raw;
                        session.scheduleProcessed(processed);
                    }
                    if (wsola) {
                        session.scheduleProcessed(wsola.flush());
                    }
                    session.flushPrebuffer();
                    if (!session.preRollScheduled) {
                        session.advanceToNext();
                        return;
                    }
                    session.streamPlayer.flush(session.streamToken);
                    return;
                }

                // Phát dần từng lát ~1.5s cho đoạn dài có WSOLA để không gây giật luồng UI
                const myFeedGen = ++session.feedGen;
                const initialSyncSamples = Math.round(sr * 0.8);
                const sliceSamples = Math.round(sr * 1.5);
                let chunkIdx = 0;

                const feedChunksUpTo = (limitSamples) => {
                    let processedSamples = 0;
                    while (chunkIdx < session.rawChunks.length && processedSamples < limitSamples) {
                        const raw = session.rawChunks[chunkIdx++];
                        processedSamples += raw.length;
                        const processed = wsola.process(raw);
                        if (processed && processed.length > 0) {
                            session._pushToStreamPlayer(processed);
                        }
                    }
                };

                session.prebufferFlushed = true;
                feedChunksUpTo(initialSyncSamples);

                const finishAsyncFeed = () => {
                    if (session.feedGen !== myFeedGen || session.runId !== state.runId || state.currentSession !== session || state.isPaused) {
                        return;
                    }
                    const flushed = wsola.flush();
                    if (flushed && flushed.length > 0) {
                        session._pushToStreamPlayer(flushed);
                    }
                    if (!session.preRollScheduled) {
                        session.advanceToNext();
                        return;
                    }
                    session.streamPlayer.flush(session.streamToken);
                };

                if (chunkIdx >= session.rawChunks.length) {
                    finishAsyncFeed();
                    return;
                }

                const pumpNextSlice = () => {
                    session.feedTimer = null;
                    if (session.feedGen !== myFeedGen || session.runId !== state.runId || state.currentSession !== session || state.isPaused) {
                        return;
                    }
                    feedChunksUpTo(sliceSamples);
                    if (chunkIdx >= session.rawChunks.length) {
                        finishAsyncFeed();
                    } else {
                        session.feedTimer = setTimeout(pumpNextSlice, 0);
                    }
                };
                session.feedTimer = setTimeout(pumpNextSlice, 0);
                return;
            }

            // Pre-fetch đang stream dở: xả các chunk đã có rồi tiếp quản prefetchPort
            const promotedPort = (state.prefetchPort && state.prefetchIndex === index) ? state.prefetchPort : cached.port;
            if (promotedPort) {
                if (state.prefetchPort === promotedPort) {
                    state.prefetchPort = null;
                    state.prefetchIndex = -1;
                }
                state.activePort = promotedPort;
                const cachedChunks = cached.trimmedChunks || [];
                const cachedSr = cached.sampleRate || DEFAULT_SAMPLE_RATE;
                ttsLog(`Seg #${index + 1} promoted live prefetch (${cachedChunks.length} chunks buffered)`);
                for (const c of cachedChunks) {
                    session._acceptTrimmedRaw(c, cachedSr);
                }
                if (cached.anchorTrimmer) {
                    session.sampleRate = cachedSr;
                    session.anchorTrimmer = cached.anchorTrimmer;
                    session.anchorRate = cached.anchorRate || cachedSr;
                    cached.anchorTrimmer = null;
                }
                updatePlayerUI();

                cached.onEvent = (msg) => {
                    if (runId !== state.runId) return;
                    if (msg.type === 'chunk') {
                        session.pushPcmBase64(msg.audio, msg.sampleRate);
                    } else if (msg.type === 'done') {
                        cached.done = true;
                        if (state.activePort === promotedPort) state.activePort = null;
                        try { promotedPort.disconnect(); } catch {}
                        session.finishStream();
                        pumpPrefetchQueue(runId);
                    } else if (msg.type === 'error') {
                        cached.done = true;
                        if (state.activePort === promotedPort) state.activePort = null;
                        if (state.isPaused && !session.streamDone) {
                            session.interruptedWhilePaused = true;
                            return;
                        }
                        handleSegmentError(msg.error, runId);
                    }
                };
                return;
            }
        }

        // Nếu prefetchPort đang chạy cho một segment sau -> hủy để nhường CPU slot ngay cho segment hiện tại
        if (state.prefetchPort) {
            abortPrefetchPort();
        }

        updatePlayerUI('Đang tạo giọng nói...');

        // Stream mới trực tiếp từ background.js
        const port = safeConnectTtsPort();
        if (!port) {
            handleSegmentError('Extension vừa được cập nhật — hãy tải lại trang (F5).', runId);
            return;
        }
        state.activePort = port;
        let receivedFirstChunk = false;
        let portCompleted = false;
        const segStartedAt = Date.now();
        let chunkCount = 0;

        port.onMessage.addListener((msg) => {
            if (runId !== state.runId) return;
            if (msg.type === 'chunk') {
                chunkCount += 1;
                if (!receivedFirstChunk) {
                    receivedFirstChunk = true;
                    ttsLog(`Seg #${index + 1} first chunk in ${Date.now() - segStartedAt}ms (sr=${msg.sampleRate || DEFAULT_SAMPLE_RATE})`);
                    updatePlayerUI();
                }
                session.pushPcmBase64(msg.audio, msg.sampleRate);
            } else if (msg.type === 'done') {
                portCompleted = true;
                ttsLog(`Seg #${index + 1} stream done (${chunkCount} chunks, ${Date.now() - segStartedAt}ms)`);
                if (state.activePort === port) state.activePort = null;
                try { port.disconnect(); } catch {}
                session.finishStream();
                pumpPrefetchQueue(runId);
            } else if (msg.type === 'error') {
                portCompleted = true;
                ttsLog(`Seg #${index + 1} error:`, msg.error);
                if (state.activePort === port) state.activePort = null;
                if (state.isPaused && !session.streamDone) {
                    session.interruptedWhilePaused = true;
                    return;
                }
                handleSegmentError(msg.error, runId);
            }
        });

        port.onDisconnect.addListener(() => {
            void chrome?.runtime?.lastError;
            if (state.activePort === port) state.activePort = null;
            if (!portCompleted && runId === state.runId) {
                if (state.isPaused && !session.streamDone) {
                    session.interruptedWhilePaused = true;
                    return;
                }
                handleSegmentError('Kết nối VieNeu TTS bị ngắt (Service Worker khởi động lại).', runId);
            }
        });

        try {
            port.postMessage({
                type: 'start',
                text: formatTtsInputText(seg.text),
                voice: state.voice,
                serverUrl: state.serverUrl,
                apiKey: state.apiKey,
                sampleRate: DEFAULT_SAMPLE_RATE,
                sampling: getSamplingParams(state.stabilityProfile)
            });
        } catch {
            handleSegmentError('Extension vừa được cập nhật — hãy tải lại trang (F5).', runId);
        }
    }

    function handleSegmentError(errMsg, runId) {
        if (runId !== state.runId) return;
        state.waitingForMoreSegments = false;
        state.isPlaying = false;
        state.isPaused = false;
        if (state.currentSession && typeof state.currentSession.cancelAsyncFeed === 'function') {
            state.currentSession.cancelAsyncFeed();
        }
        state.currentSession = null;
        abortPorts();
        stopStreamPlayer(true);
        updatePlayerUI(errMsg || 'Lỗi phát âm thanh VieNeu', true);
    }

    function estimatePlayedRawSample(session, rewindOutSec = 0) {
        const sr = session.sampleRate || DEFAULT_SAMPLE_RATE;
        let playedInputSamples = session.baseSourceSample;
        if (session.startCtxTime !== null) {
            const elapsedOutSec = Math.max(0, session.audioCtx.currentTime - session.startCtxTime);
            const effectiveOutSec = Math.max(0, elapsedOutSec - Math.max(0, rewindOutSec));
            playedInputSamples += Math.floor(effectiveOutSec * session.speedAtRunStart * sr);
        }
        return Math.max(0, Math.min(session.totalRawSamples, playedInputSamples));
    }

    function rerenderSessionFromSample(session, startRawSample, { resetPreRoll = false } = {}) {
        if (typeof session.cancelAsyncFeed === 'function') {
            session.cancelAsyncFeed();
        }
        const sr = session.sampleRate || DEFAULT_SAMPLE_RATE;
        const clampedStart = Math.max(0, Math.min(session.totalRawSamples, startRawSample));

        session.streamPlayer.clear();
        state.streamToken += 1;
        session.streamToken = state.streamToken;

        if (clampedStart >= session.totalRawSamples && session.streamDone) {
            session.advanceToNext();
            return;
        }

        const remLen = session.totalRawSamples - clampedStart;
        const remaining = new Float32Array(remLen);
        let srcOffset = 0;
        let dstOffset = 0;
        for (const chunk of session.rawChunks) {
            const chunkEnd = srcOffset + chunk.length;
            if (chunkEnd > clampedStart) {
                const startInChunk = Math.max(0, clampedStart - srcOffset);
                const slice = chunk.subarray(startInChunk);
                remaining.set(slice, dstOffset);
                dstOffset += slice.length;
            }
            srcOffset = chunkEnd;
        }

        // Fade-in ~5ms tránh tiếng tách khi nối lại từ điểm cắt
        const fadeSamples = Math.min(remaining.length, Math.round(sr * 0.005));
        for (let i = 0; i < fadeSamples; i++) {
            remaining[i] *= i / fadeSamples;
        }

        session.baseSourceSample = clampedStart;
        session.startCtxTime = null;
        session.prebufferFlushed = true;
        session.pendingPrebuffer = [];
        session.pendingPrebufferSamples = 0;
        if (resetPreRoll) {
            session.preRollScheduled = false;
        }
        session.speedAtRunStart = state.speed;
        session.wsolaRate = sr;
        session.wsola = Math.abs(state.speed - 1.0) < 0.001
            ? null
            : new WSOLAProcessor(sr, state.speed);

        if (remaining.length > 0) {
            const processed = session.wsola ? session.wsola.process(remaining) : remaining;
            session.scheduleProcessed(processed);
        }
        if (session.streamDone) {
            if (session.wsola) {
                session.scheduleProcessed(session.wsola.flush());
            }
            if (!session.preRollScheduled) {
                session.advanceToNext();
                return;
            }
            session.streamPlayer.flush(session.streamToken);
        }
    }

    function togglePauseResume() {
        if (!state.segments.length) return;
        if (state.autoplayUnblockedAt && (Date.now() - state.autoplayUnblockedAt < 400)) {
            state.autoplayUnblockedAt = 0;
            return;
        }
        if (state.autoplayBlocked) {
            clearAutoplayResumeGesture();
            state.autoplayBlocked = false;
            state.isPaused = false;
            state.isPlaying = true;
            const capturedRunId = state.runId;
            if (state.activeEngine === 'webspeech') {
                playSegment(state.currentIndex, capturedRunId);
                return;
            }
            const ctx = ensureAudioContext();
            ensureStreamPlayer(ctx);
            ctx.resume().then(() => {
                if (state.isPlaying && !state.isPaused && state.runId === capturedRunId && !state.currentSession && !state.activePort && !state.activeWs) {
                    playSegment(state.currentIndex, capturedRunId);
                }
            }).catch(() => {
                updatePlayerUI();
            });
            updatePlayerUI();
            return;
        }
        if (!state.isPlaying) {
            state.runId += 1;
            playSegment(state.currentIndex, state.runId);
            return;
        }
        if (state.activeEngine === 'webspeech' && global.speechSynthesis) {
            if (state.isPaused) {
                state.isPaused = false;
                const needsReplay = !state.activeUtterance || (!global.speechSynthesis.speaking && !global.speechSynthesis.pending);
                if (needsReplay) {
                    updatePlayerUI();
                    playSegment(state.currentIndex, state.runId);
                } else {
                    try { global.speechSynthesis.resume(); } catch {}
                    updatePlayerUI();
                }
                maybeTriggerNextChapterPreload({ forceVerify: true });
            } else {
                state.isPaused = true;
                clearPreloadTimer();
                try { global.speechSynthesis.pause(); } catch {}
                updatePlayerUI();
            }
            return;
        }
        const ctx = state.audioCtx;
        if (!ctx) return;

        if (state.isPaused) {
            state.isPaused = false;
            const capturedRunId = state.runId;
            const capturedSession = state.currentSession;
            ctx.resume().then(() => {
                if (state.isPaused || !state.isPlaying || state.runId !== capturedRunId) return;
                for (const [qIdx, qEntry] of Array.from(state.prefetchQueue.entries())) {
                    if (qEntry && qEntry.error) {
                        state.prefetchQueue.delete(qIdx);
                    }
                }
                syncPrefetchCacheAlias();

                if (state.pendingWsDrained) {
                    state.pendingWsDrained = false;
                    playSegment(state.currentIndex + 1, capturedRunId);
                    maybeTriggerNextChapterPreload({ forceVerify: true });
                    return;
                }
                if (state.waitingForMoreSegments) {
                    if (state.currentIndex < state.segments.length) {
                        state.waitingForMoreSegments = false;
                        playSegment(state.currentIndex, capturedRunId);
                        maybeTriggerNextChapterPreload({ forceVerify: true });
                        return;
                    }
                    const transState = global.STV_translationState;
                    if (!transState || !transState.active || (state.liveTranslationRunId && transState.runId !== state.liveTranslationRunId)) {
                        finishChapterPlayback();
                        return;
                    }
                    updatePlayerUI('Đang đợi AI dịch tiếp...');
                    maybeTriggerNextChapterPreload({ forceVerify: true });
                    return;
                }
                if (state.pendingWsReplay) {
                    state.pendingWsReplay = false;
                    playSegment(state.currentIndex, capturedRunId);
                    maybeTriggerNextChapterPreload({ forceVerify: true });
                    return;
                }
                if (capturedSession && state.currentSession === capturedSession) {
                    const resumeFrom = Number.isFinite(capturedSession.pausedRawSample)
                        ? capturedSession.pausedRawSample
                        : capturedSession.baseSourceSample;
                    if (capturedSession.interruptedWhilePaused || (!capturedSession.streamDone && !state.activePort)) {
                        if (capturedSession.totalRawSamples === 0 || resumeFrom >= capturedSession.totalRawSamples) {
                            playSegment(state.currentIndex, capturedRunId);
                            maybeTriggerNextChapterPreload({ forceVerify: true });
                            return;
                        }
                        capturedSession.streamDone = true;
                        capturedSession.interruptedWhilePaused = false;
                    }
                    capturedSession.pausedRawSample = null;
                    if (capturedSession.totalRawSamples > 0 || capturedSession.streamDone) {
                        rerenderSessionFromSample(capturedSession, resumeFrom, { resetPreRoll: true });
                    }
                } else if (!capturedSession && !state.activePort && !state.activeWs && state.currentIndex < state.segments.length) {
                    playSegment(state.currentIndex, capturedRunId);
                    maybeTriggerNextChapterPreload({ forceVerify: true });
                    return;
                }
                updatePlayerUI();
                pumpPrefetchQueue(capturedRunId);
                maybeTriggerNextChapterPreload({ forceVerify: true });
            });
        } else {
            state.isPaused = true;
            clearPreloadTimer();
            const session = state.currentSession;
            if (session && session.runId === state.runId) {
                if (typeof session.cancelAsyncFeed === 'function') {
                    session.cancelAsyncFeed();
                }
                const hwLatency = Math.min(0.35, Math.max(0, (ctx.baseLatency || 0) + (ctx.outputLatency || 0)));
                const rewindOutSec = Math.min(0.60, hwLatency + 0.30);
                if (!Number.isFinite(session.pausedRawSample)) {
                    session.pausedRawSample = estimatePlayedRawSample(session, rewindOutSec);
                }
                session.streamPlayer.clear();
                state.streamToken += 1;
                session.streamToken = state.streamToken;
                session.startCtxTime = null;
            }
            ctx.suspend().then(() => updatePlayerUI());
        }
    }

    function stopPlayback(removeUI = false) {
        state.runId += 1;
        state.waitingForMoreSegments = false;
        state.pendingWsReplay = false;
        state.isPlaying = false;
        state.isPaused = false;
        clearAutoplayResumeGesture();
        state.autoplayBlocked = false;
        state.autoplayUnblockedAt = 0;
        if (state.currentSession && typeof state.currentSession.cancelAsyncFeed === 'function') {
            state.currentSession.cancelAsyncFeed();
        }
        state.currentSession = null;
        abortPorts();
        cancelPreload();
        if (state.nextChapterTimer) {
            clearTimeout(state.nextChapterTimer);
            state.nextChapterTimer = null;
        }
        if (state.liveIconDebounceTimer) {
            clearTimeout(state.liveIconDebounceTimer);
            state.liveIconDebounceTimer = null;
        }
        stopStreamPlayer(true);
        if (state.audioCtx && state.audioCtx.state === 'suspended' && canStartAudioContext()) {
            state.audioCtx.resume().catch(() => {});
        }
        clearHighlight();
        if (removeUI) {
            if (exportState.active) {
                cancelTTSDownload();
            }
            if (state.playerHost) {
                state.playerHost.remove();
                state.playerHost = null;
                state.playerEl = null;
            } else if (state.playerEl) {
                state.playerEl.remove();
                state.playerEl = null;
            }
        } else {
            updatePlayerUI('Đã dừng');
        }
    }

    function jumpToSegment(targetIdx) {
        if (!state.segments.length) return;
        const clamped = Math.max(0, Math.min(targetIdx, state.segments.length - 1));
        state.runId += 1;
        state.waitingForMoreSegments = false;
        if (state.currentSession && typeof state.currentSession.cancelAsyncFeed === 'function') {
            state.currentSession.cancelAsyncFeed();
        }
        state.currentSession = null;
        clearPreloadTimer();
        if (state.autoplayBlocked && canStartAudioContext()) {
            clearAutoplayResumeGesture();
            state.autoplayBlocked = false;
        }
        abortPorts();
        stopStreamPlayer(false);
        if (state.audioCtx && state.audioCtx.state === 'suspended' && !state.autoplayBlocked && canStartAudioContext()) {
            state.audioCtx.resume().catch(() => {});
        }
        playSegment(clamped, state.runId);
    }

    function changeSpeed(delta) {
        const next = Math.round(Math.max(0.8, Math.min(2.0, state.speed + delta)) * 10) / 10;
        if (next === state.speed) return;
        state.speed = next;
        chrome.runtime.sendMessage({
            action: 'set_runtime_setting',
            key: 'ttsSpeed',
            value: next
        }, () => { void chrome.runtime.lastError; });
        updatePlayerUI();

        // Áp dụng tốc độ mới ngay trên đoạn đang phát bằng cách render lại phần audio chưa phát
        const session = state.currentSession;
        if (!state.isPaused && session && session.runId === state.runId && state.isPlaying && session.totalRawSamples > 0) {
            const playedInputSamples = estimatePlayedRawSample(session, 0);
            rerenderSessionFromSample(session, playedInputSamples, { resetPreRoll: false });
        }
    }

    function syncLiveTranslationSegments() {
        if (!state.playerEl || !state.liveTranslationRunId) return;
        const transState = global.STV_translationState;
        if (transState && transState.runId && transState.runId !== state.liveTranslationRunId) {
            return;
        }

        let added = 0;
        const lockedFloor = Math.max(0, state.currentIndex + 2);
        const iconOpts = getActiveIconOptions();
        const finalizedLines = document.querySelectorAll('.stv-line:not(.stv-line-partial)');
        finalizedLines.forEach((el) => {
            if (state.consumedLineEls.has(el)) return;
            state.consumedLineEls.add(el);
            added += appendPackedSegment(state.segments, el.innerText || el.textContent, el, lockedFloor, iconOpts);
        });

        if (added > 0) {
            const hasPendingIcons = state.segments.some((s) => s.needsAiIconResolve && s.iconResolveState === 'pending');
            if (hasPendingIcons) {
                if (state.liveIconDebounceTimer) {
                    clearTimeout(state.liveIconDebounceTimer);
                    state.liveIconDebounceTimer = null;
                }
                const capturedRun = state.runId;
                if (state.waitingForMoreSegments || (transState && !transState.active)) {
                    scheduleAiIconResolution(state.segments, capturedRun);
                } else {
                    state.liveIconDebounceTimer = setTimeout(() => {
                        state.liveIconDebounceTimer = null;
                        if (state.runId === capturedRun && state.isPlaying) {
                            scheduleAiIconResolution(state.segments, capturedRun);
                        }
                    }, 350);
                }
            }
            updatePlayerUI();
            if (state.waitingForMoreSegments && state.isPlaying && !state.isPaused && state.currentIndex < state.segments.length) {
                state.waitingForMoreSegments = false;
                playSegment(state.currentIndex, state.runId);
                return;
            }
            if (state.isPlaying && !state.isPaused && state.activePort === null && state.prefetchPort === null && state.currentIndex + 1 < state.segments.length) {
                pumpPrefetchQueue(state.runId);
            }
        }

        if (transState && !transState.active) {
            if (state.waitingForMoreSegments && state.currentIndex >= state.segments.length) {
                finishChapterPlayback();
                return;
            }
            maybeTriggerNextChapterPreload();
        }
    }

    function bindTranslationProgress() {
        if (state.progressListenerBound) return;
        state.progressListenerBound = true;
        global.addEventListener('stv-translation-progress', () => {
            syncLiveTranslationSegments();
        });
    }

    async function loadAndApplyRuntimeConfig(options = {}) {
        let config = {};
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            config = await new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'get_tts_runtime_config' }, (resp) => {
                    if (chrome.runtime.lastError || !resp || !resp.ok) {
                        resolve({});
                        return;
                    }
                    resolve(resp.data || {});
                });
            });
        }

        if (config.stv_locale && global.STV_I18n && typeof global.STV_I18n.setLocale === 'function') {
            global.STV_I18n.setLocale(config.stv_locale);
        }

        state.debugLog = Boolean(options.debugLog !== undefined ? options.debugLog : config.stvDebugLog);
        const engineCandidate = options.engine || config.ttsEngine || 'ws_default';
        state.engine = ['ws_default', 'webspeech', 'vieneu'].includes(engineCandidate) ? engineCandidate : 'ws_default';
        state.activeEngine = state.engine;
        state.wsFallbackNotified = false;
        state.wsEndpoint = (options.wsEndpoint !== undefined ? options.wsEndpoint : (config.ttsWsEndpoint || 'wss://tts.stv-novel.local/v1/tts')).trim();
        state.wsVoice = (options.wsVoice !== undefined ? options.wsVoice : (config.ttsWsVoice || 'vi-VN-HoaiMyNeural')).trim();
        state.wsAutoFallback = options.wsAutoFallback !== undefined
            ? Boolean(options.wsAutoFallback)
            : (config.ttsWsAutoFallback !== false);

        state.serverUrl = (options.serverUrl || config.ttsEndpoint || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '');
        state.voice = (options.voice !== undefined ? options.voice : (config.ttsVoice || '')).trim();
        state.apiKey = (options.apiKey !== undefined ? options.apiKey : (config.ttsApiKey || '')).trim();
        const profileCandidate = options.stabilityProfile !== undefined
            ? options.stabilityProfile
            : (config.ttsStabilityProfile || 'balanced');
        state.stabilityProfile = SAMPLING_PROFILES[profileCandidate] ? profileCandidate : 'balanced';
        const parsedSpeed = parseFloat(options.speed || config.ttsSpeed || '1.0');
        state.speed = Number.isFinite(parsedSpeed) ? Math.max(0.8, Math.min(2.0, parsedSpeed)) : 1.0;

        state.autoNextChapter = options.autoNextChapter !== undefined
            ? Boolean(options.autoNextChapter)
            : (config.ttsAutoNextChapter !== false);
        const parsedLead = parseInt(options.preloadLeadSec !== undefined ? options.preloadLeadSec : config.ttsPreloadSeconds, 10);
        state.preloadLeadSec = Number.isFinite(parsedLead) ? Math.max(5, Math.min(300, parsedLead)) : 60;
        const parsedDlMins = parseInt(options.downloadMinutes !== undefined ? options.downloadMinutes : config.ttsDownloadMinutes, 10);
        state.downloadMinutes = Number.isFinite(parsedDlMins) ? Math.max(1, Math.min(240, parsedDlMins)) : DEFAULT_DOWNLOAD_MINUTES;

        const dlSourceCand = options.downloadSource !== undefined ? options.downloadSource : config.ttsDownloadSource;
        state.downloadSource = dlSourceCand === 'colab_gpu' ? 'colab_gpu' : 'current';
        state.colabServerUrl = (options.colabServerUrl !== undefined ? options.colabServerUrl : (config.ttsColabUrl || '')).trim().replace(/\/+$/, '');
        state.colabVoice = (options.colabVoice !== undefined ? options.colabVoice : (config.ttsColabVoice || '')).trim();
        const gpuTierCand = String(options.colabGpuTier !== undefined ? options.colabGpuTier : (config.ttsColabGpu || 'T4')).trim();
        state.colabGpuTier = ['T4', 'L4', 'A100', 'auto'].includes(gpuTierCand) ? gpuTierCand : 'T4';

        const modeCand = options.iconMode !== undefined ? options.iconMode : config.ttsIconMode;
        state.iconMode = ['auto', 'local', 'off'].includes(modeCand) ? modeCand : 'auto';
        const styleCand = options.iconStyle !== undefined ? options.iconStyle : config.ttsIconStyle;
        state.iconStyle = styleCand === 'natural' ? 'natural' : 'tagged';
        state.iconLearnedCache = (config.ttsIconLearnedCache && typeof config.ttsIconLearnedCache === 'object')
            ? { ...config.ttsIconLearnedCache }
            : {};
        const customSrc = options.customIcons !== undefined ? options.customIcons : config.ttsCustomIcons;
        const describer = getIconDescriber();
        state.iconCustomMap = (describer && typeof describer.normalizeCustomIconsMap === 'function')
            ? describer.normalizeCustomIconsMap(customSrc)
            : ((customSrc && typeof customSrc === 'object' && !Array.isArray(customSrc)) ? { ...customSrc } : {});
        state.aiIconsUnavailable = false;

        return config;
    }

    function abortActiveExportNetwork() {
        for (const port of Array.from(exportState.activePorts)) {
            try { port.postMessage({ type: 'abort' }); } catch {}
            try { port.disconnect(); } catch {}
        }
        exportState.activePorts.clear();
        for (const ws of Array.from(exportState.activeSockets)) {
            try { ws.close(); } catch {}
        }
        exportState.activeSockets.clear();
        if (exportState.activePreloadPort) {
            try { exportState.activePreloadPort.disconnect(); } catch {}
            exportState.activePreloadPort = null;
        }
        const rejects = Array.from(exportState.abortRejects);
        exportState.abortRejects.clear();
        for (const rejectFn of rejects) {
            if (typeof rejectFn === 'function') {
                rejectFn(new Error(exportState.savePartialRequested ? 'EXPORT_SAVE_PARTIAL' : 'EXPORT_ABORTED'));
            }
        }
    }

    function cancelTTSDownload() {
        if (!exportState.active) return;
        exportState.aborted = true;
        exportState.savePartialRequested = false;
        abortActiveExportNetwork();
        if (isExtensionAlive()) {
            try {
                chrome.runtime.sendMessage({ action: 'cancel_chapter_preload' }, () => {
                    void chrome.runtime.lastError;
                });
            } catch {}
        }
    }

    function requestSavePartialDownload() {
        if (!exportState.active) return;
        exportState.savePartialRequested = true;
        abortActiveExportNetwork();
    }

    function openNextExportChapter() {
        if (!exportState.nextOpenUrl) return;
        try {
            const base = (global.location && global.location.href) || '';
            const resolved = new URL(exportState.nextOpenUrl, base);
            if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
                global.location.assign(resolved.href);
            }
        } catch {
            // ignore invalid url
        }
    }

    function triggerWavFileDownload(blob, filename) {
        if (!blob || typeof document === 'undefined') return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(() => {
            try { a.remove(); } catch {}
            try { URL.revokeObjectURL(url); } catch {}
        }, 30000);
    }

    function estimateSegmentsDurationSec(segments, speed = 1.0) {
        let chars = 0;
        if (Array.isArray(segments)) {
            for (let i = 0; i < segments.length; i++) {
                const txt = segments[i] && segments[i].text;
                if (txt) chars += txt.length;
            }
        }
        return chars / (14 * Math.max(0.5, Number(speed) || 1.0));
    }

    async function ensureMultiStreamVieNeuReady(leaseId) {
        const activeExportEngine = exportState.useColabGpu ? 'vieneu' : state.engine;
        const targetServerUrl = exportState.useColabGpu ? exportState.effectiveServerUrl : state.serverUrl;
        if (activeExportEngine !== 'vieneu' || !isExtensionAlive()) {
            return EXPORT_CONCURRENCY;
        }

        if (exportState.useColabGpu) {
            const health = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: 'vieneu_check_health',
                    serverUrl: targetServerUrl,
                    apiKey: state.apiKey,
                    isColab: true
                }, (resp) => {
                    if (chrome.runtime.lastError || !resp || !resp.ok) {
                        resolve(null);
                        return;
                    }
                    resolve(resp.data || {});
                });
            });
            const colabCfg = getColabGpuExportConfig(state.colabGpuTier, health);
            exportState.targetWorkers = colabCfg.workers;
            exportState.maxChunkChars = colabCfg.maxChunkChars;
            const gpuLabel = (health && health.gpu_name) ? health.gpu_name : colabCfg.tier;
            updatePlayerUI(
                tTts('tts_dl_scaling_colab', `Đang kết nối Colab GPU (${gpuLabel} · ${colabCfg.workers} luồng song song)...`)
                    .replace('{gpu}', String(gpuLabel))
                    .replace('{workers}', String(colabCfg.workers))
            );
            const scaled = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: 'vieneu_set_worker_mode',
                    serverUrl: targetServerUrl,
                    apiKey: state.apiKey,
                    mode: 'export',
                    leaseId,
                    workers: colabCfg.workers,
                    gpuTier: colabCfg.tier
                }, (resp) => {
                    if (chrome.runtime.lastError || !resp || !resp.ok) {
                        resolve(null);
                        return;
                    }
                    resolve(resp.data || {});
                });
            });
            if (scaled) {
                const streams = Number(scaled.max_streams || scaled.active_workers || colabCfg.workers);
                return Math.max(1, Math.min(12, streams));
            }
            if (health) {
                const curStreams = Number(health.max_streams || colabCfg.workers);
                if (colabCfg.tier === 'auto') {
                    return Math.max(1, Math.min(12, curStreams));
                }
                return Math.max(1, Math.min(colabCfg.workers, curStreams));
            }
            return colabCfg.workers;
        }

        updatePlayerUI(tTts('tts_dl_scaling_workers', 'Đang bật 3 worker VieNeu để tải nhanh hơn...'));
        const scaled = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: 'vieneu_set_worker_mode',
                serverUrl: targetServerUrl,
                apiKey: state.apiKey,
                mode: 'export',
                leaseId,
                workers: EXPORT_CONCURRENCY
            }, (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.ok) {
                    resolve(null);
                    return;
                }
                resolve(resp.data || {});
            });
        });
        if (scaled) {
            const streams = Number(scaled.max_streams || scaled.active_workers || 1);
            return Math.max(1, Math.min(EXPORT_CONCURRENCY, streams));
        }

        const health = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: 'vieneu_check_health',
                serverUrl: targetServerUrl
            }, (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.ok) {
                    resolve(null);
                    return;
                }
                resolve(resp.data || {});
            });
        });
        if (!health) return 1;
        const curStreams = Number(health.max_streams || 1);
        return Math.max(1, Math.min(EXPORT_CONCURRENCY, curStreams));
    }

    function releaseExportWorkers(leaseId) {
        const activeExportEngine = exportState.useColabGpu ? 'vieneu' : (exportState.effectiveEngine || state.engine);
        const targetServerUrl = exportState.useColabGpu ? exportState.effectiveServerUrl : state.serverUrl;
        if (!leaseId || activeExportEngine !== 'vieneu' || !isExtensionAlive()) return;
        if (exportState.leaseId === leaseId) {
            exportState.leaseId = null;
        }
        try {
            chrome.runtime.sendMessage({
                action: 'vieneu_set_worker_mode',
                serverUrl: targetServerUrl,
                apiKey: state.apiKey,
                mode: 'listen',
                leaseId
            }, () => { void chrome?.runtime?.lastError; });
        } catch {
            // ignore
        }
    }

    function waitForActiveTranslation(exportRunId) {
        const transState = global.STV_translationState;
        if (!transState || !transState.active) return Promise.resolve();
        return new Promise((resolve, reject) => {
            if (exportState.runId !== exportRunId || exportState.aborted || exportState.savePartialRequested) {
                reject(new Error(exportState.savePartialRequested ? 'EXPORT_SAVE_PARTIAL' : 'EXPORT_ABORTED'));
                return;
            }
            const onProgress = (ev) => {
                const active = ev?.detail?.active;
                if (active === false || !(global.STV_translationState && global.STV_translationState.active)) {
                    cleanup();
                    resolve();
                }
            };
            const cleanup = () => {
                global.removeEventListener('stv-translation-progress', onProgress);
                exportState.abortRejects.delete(abortHandler);
            };
            const abortHandler = (err) => {
                cleanup();
                reject(err);
            };
            exportState.abortRejects.add(abortHandler);
            global.addEventListener('stv-translation-progress', onProgress);
        });
    }

    function fetchAndTranslateChapterForExport(targetUrl, mode, exportRunId) {
        return new Promise((resolve, reject) => {
            if (exportState.runId !== exportRunId || exportState.aborted || exportState.savePartialRequested) {
                reject(new Error(exportState.savePartialRequested ? 'EXPORT_SAVE_PARTIAL' : 'EXPORT_ABORTED'));
                return;
            }
            chrome.runtime.sendMessage({
                action: 'start_chapter_preload',
                url: targetUrl,
                mode
            }, (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.ok) {
                    reject(new Error(resp?.error || chrome.runtime.lastError?.message || 'Preload failed'));
                    return;
                }
                if (exportState.runId !== exportRunId || exportState.aborted || exportState.savePartialRequested) {
                    reject(new Error(exportState.savePartialRequested ? 'EXPORT_SAVE_PARTIAL' : 'EXPORT_ABORTED'));
                    return;
                }

                let port;
                try {
                    port = chrome.runtime.connect({ name: 'stv-preload-stream' });
                } catch (err) {
                    reject(err);
                    return;
                }
                exportState.activePreloadPort = port;
                let settled = false;
                let accFullText = '';

                const cleanup = () => {
                    clearTimeout(timer);
                    if (exportState.activePreloadPort === port) {
                        exportState.activePreloadPort = null;
                    }
                    exportState.abortRejects.delete(abortHandler);
                    try { port.disconnect(); } catch {}
                };

                const finishOk = (msg) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve({
                        fullText: msg.fullText !== undefined ? msg.fullText : accFullText,
                        origChunks: Array.isArray(msg.origChunks) ? msg.origChunks : [],
                        nextUrl: msg.nextUrl || null
                    });
                };

                const finishErr = (err) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(err instanceof Error ? err : new Error(String(err || 'Preload stream error')));
                };

                const abortHandler = (err) => finishErr(err);
                exportState.abortRejects.add(abortHandler);

                const timer = setTimeout(() => {
                    finishErr(new Error('Timeout tải/dịch chương tiếp theo'));
                }, 180000);

                port.onMessage.addListener((msg) => {
                    if (!msg || settled) return;
                    if (exportState.runId !== exportRunId || exportState.aborted || exportState.savePartialRequested) {
                        finishErr(new Error(exportState.savePartialRequested ? 'EXPORT_SAVE_PARTIAL' : 'EXPORT_ABORTED'));
                        return;
                    }
                    if (msg.type === 'snapshot') {
                        accFullText = msg.fullText || '';
                        if (msg.done) finishOk(msg);
                    } else if (msg.type === 'delta') {
                        if (typeof msg.delta === 'string') accFullText += msg.delta;
                        if (msg.fullText !== undefined && msg.done) accFullText = msg.fullText;
                        if (msg.done) finishOk(msg);
                    } else if (msg.type === 'error') {
                        finishErr(new Error(msg.error || 'Preload failed'));
                    }
                });

                port.onDisconnect.addListener(() => {
                    void chrome?.runtime?.lastError;
                    if (!settled) {
                        finishErr(new Error('Mất kết nối background khi tải chương tiếp theo'));
                    }
                });

                try {
                    port.postMessage({ type: 'subscribe', preloadId: resp.preloadId });
                } catch (err) {
                    finishErr(err);
                }
            });
        });
    }

    function synthesizeSegmentForExport(segText, exportRunId) {
        return new Promise((resolve, reject) => {
            if (exportState.runId !== exportRunId || exportState.aborted || exportState.savePartialRequested) {
                reject(new Error(exportState.savePartialRequested ? 'EXPORT_SAVE_PARTIAL' : 'EXPORT_ABORTED'));
                return;
            }

            const chunks = [];
            let totalSamples = 0;
            let firstOutputEmitted = false;
            let resampler = null;
            let resamplerRate = 0;

            const pushStretchedFloat32 = (samples, sr) => {
                if (!samples || samples.length === 0) return;
                const effectiveSr = sr || EXPORT_SAMPLE_RATE;
                let data = samples;
                if (!firstOutputEmitted) {
                    firstOutputEmitted = true;
                    const copy = new Float32Array(data);
                    const fadeLen = Math.min(copy.length, Math.round(effectiveSr * 0.005));
                    for (let i = 0; i < fadeLen; i++) copy[i] *= i / fadeLen;
                    data = copy;
                }
                if (effectiveSr !== EXPORT_SAMPLE_RATE) {
                    if (!resampler || resamplerRate !== effectiveSr) {
                        resampler = new ContinuousResampler(effectiveSr, EXPORT_SAMPLE_RATE);
                        resamplerRate = effectiveSr;
                    }
                    data = resampler.process(data);
                }
                if (!data || data.length === 0) return;
                const int16 = float32ToInt16(data);
                if (int16.length > 0) {
                    chunks.push(int16);
                    totalSamples += int16.length;
                }
            };

            const activeExportEngine = exportState.useColabGpu ? 'vieneu' : state.engine;
            if (activeExportEngine === 'ws_default') {
                const wsUrl = (state.wsEndpoint || '').trim();
                const isOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
                if (!wsUrl || !/^wss?:\/\//i.test(wsUrl) || typeof global.WebSocket !== 'function' || isOffline) {
                    reject(new Error('WebSocket TTS chưa sẵn sàng để xuất file WAV. Hãy chọn VieNeu Local Server hoặc cấu hình WebSocket TTS hợp lệ.'));
                    return;
                }

                let ws;
                let settled = false;
                let timer = null;

                const cleanup = () => {
                    if (timer) clearTimeout(timer);
                    exportState.activeSockets.delete(ws);
                    exportState.abortRejects.delete(abortHandler);
                };
                const finishErr = (err) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    try { ws?.close(); } catch {}
                    reject(err instanceof Error ? err : new Error(String(err)));
                };
                const finishOk = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    try { ws?.close(); } catch {}
                    resolve({ chunks, totalSamples });
                };
                const abortHandler = (err) => finishErr(err);
                exportState.abortRejects.add(abortHandler);

                try {
                    ws = new global.WebSocket(wsUrl);
                    ws.binaryType = 'arraybuffer';
                } catch (err) {
                    finishErr(err);
                    return;
                }
                exportState.activeSockets.add(ws);

                const resetTimeout = () => {
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => finishErr(new Error('WebSocket TTS timeout khi tải audio.')), 30000);
                };
                resetTimeout();

                ws.onopen = () => {
                    if (settled || exportState.runId !== exportRunId) return;
                    try {
                        ws.send(JSON.stringify({
                            type: 'tts.synthesize',
                            text: segText,
                            voice: state.wsVoice || state.voice || 'vi-VN-HoaiMyNeural',
                            rate: state.speed || 1.0,
                            sample_rate: DEFAULT_SAMPLE_RATE
                        }));
                    } catch (err) {
                        finishErr(err);
                    }
                };

                ws.onmessage = (ev) => {
                    if (settled || exportState.runId !== exportRunId) return;
                    resetTimeout();
                    if (ev.data instanceof ArrayBuffer) {
                        const evenLen = ev.data.byteLength - (ev.data.byteLength % 2);
                        if (evenLen <= 0) return;
                        const view = new Int16Array(ev.data, 0, evenLen / 2);
                        const f32 = new Float32Array(view.length);
                        for (let i = 0; i < view.length; i++) f32[i] = view[i] / 32768;
                        pushStretchedFloat32(f32, DEFAULT_SAMPLE_RATE);
                        return;
                    }
                    try {
                        const msg = JSON.parse(String(ev.data || '{}'));
                        if (msg.error) throw new Error(msg.error);
                        if (msg.audio) {
                            const f32 = decodePcm16Base64ToFloat32(msg.audio);
                            pushStretchedFloat32(f32, msg.sampleRate || DEFAULT_SAMPLE_RATE);
                        }
                        if (msg.done || msg.type === 'done') {
                            finishOk();
                        }
                    } catch (err) {
                        finishErr(err);
                    }
                };

                ws.onerror = () => finishErr(new Error('Không kết nối được WebSocket TTS để xuất file WAV. Hãy chuyển sang VieNeu Local Server.'));
                ws.onclose = () => {
                    if (!settled) {
                        finishErr(new Error('Kết nối WebSocket TTS bị đóng khi đang tải audio.'));
                    }
                };
                return;
            }

            // VieNeu Local Server high-throughput 24kHz synthesis
            const port = safeConnectTtsPort();
            if (!port) {
                reject(new Error('Extension vừa được cập nhật — hãy tải lại trang (F5).'));
                return;
            }
            exportState.activePorts.add(port);

            let settled = false;
            let anchorTrimmer = null;
            let anchorRate = 0;
            let wsola = null;
            let wsolaRate = 0;
            let lastSr = EXPORT_SAMPLE_RATE;

            const pushTrimmedRaw = (raw, sr) => {
                if (!raw || raw.length === 0) return;
                const effectiveSr = sr || lastSr || EXPORT_SAMPLE_RATE;
                lastSr = effectiveSr;
                if (wsolaRate !== effectiveSr) {
                    wsolaRate = effectiveSr;
                    wsola = Math.abs(state.speed - 1.0) < 0.001
                        ? null
                        : new WSOLAProcessor(effectiveSr, state.speed);
                }
                const processed = wsola ? wsola.process(raw) : raw;
                pushStretchedFloat32(processed, effectiveSr);
            };

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                exportState.activePorts.delete(port);
                exportState.abortRejects.delete(abortHandler);
                try { port.disconnect(); } catch {}
            };

            const finishErr = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err instanceof Error ? err : new Error(String(err)));
            };

            const finishOk = () => {
                if (settled) return;
                settled = true;
                if (anchorTrimmer) {
                    const rest = anchorTrimmer.flush();
                    if (rest && rest.length > 0) pushTrimmedRaw(rest, lastSr);
                }
                if (wsola) {
                    const flushed = wsola.flush();
                    if (flushed && flushed.length > 0) pushStretchedFloat32(flushed, lastSr);
                }
                cleanup();
                resolve({ chunks, totalSamples });
            };

            const abortHandler = (err) => finishErr(err);
            exportState.abortRejects.add(abortHandler);

            let timer = setTimeout(() => {
                finishErr(new Error('VieNeu TTS timeout khi tạo audio.'));
            }, 90000);
            const resetTimer = () => {
                clearTimeout(timer);
                timer = setTimeout(() => finishErr(new Error('VieNeu TTS timeout khi tạo audio.')), 90000);
            };

            port.onMessage.addListener((msg) => {
                if (settled || !msg) return;
                if (exportState.runId !== exportRunId || exportState.aborted || exportState.savePartialRequested) {
                    finishErr(new Error(exportState.savePartialRequested ? 'EXPORT_SAVE_PARTIAL' : 'EXPORT_ABORTED'));
                    return;
                }
                resetTimer();
                if (msg.type === 'chunk') {
                    const sr = msg.sampleRate || EXPORT_SAMPLE_RATE;
                    lastSr = sr;
                    if (!anchorTrimmer || anchorRate !== sr) {
                        anchorRate = sr;
                        anchorTrimmer = createAnchorTrimmer(sr);
                    }
                    const rawChunk = decodePcm16Base64ToFloat32(msg.audio);
                    if (rawChunk.length > 0) {
                        const trimmed = anchorTrimmer.push(rawChunk);
                        if (trimmed && trimmed.length > 0) {
                            pushTrimmedRaw(trimmed, sr);
                        }
                    }
                } else if (msg.type === 'done') {
                    finishOk();
                } else if (msg.type === 'error') {
                    finishErr(new Error(msg.error || 'Lỗi VieNeu TTS'));
                }
            });

            port.onDisconnect.addListener(() => {
                void chrome?.runtime?.lastError;
                if (!settled) {
                    finishErr(new Error('Kết nối VieNeu TTS bị ngắt khi đang tạo audio.'));
                }
            });

            try {
                const targetServerUrl = exportState.useColabGpu ? exportState.effectiveServerUrl : state.serverUrl;
                const targetVoice = exportState.useColabGpu ? exportState.effectiveVoice : state.voice;
                const maxChars = exportState.useColabGpu
                    ? Math.min(512, Math.max(360, (exportState.maxChunkChars || 300) + 60))
                    : 360;
                const sampling = { ...getSamplingParams(state.stabilityProfile), max_chars: maxChars };
                port.postMessage({
                    type: 'start',
                    text: formatTtsInputText(segText),
                    voice: targetVoice,
                    serverUrl: targetServerUrl,
                    apiKey: state.apiKey,
                    sampleRate: EXPORT_SAMPLE_RATE,
                    sampling
                });
            } catch (err) {
                finishErr(err);
            }
        });
    }

    async function startTTSDownload(options = {}) {
        if (exportState.active) {
            return { ok: false, error: 'already_exporting' };
        }

        const wasLiveActive = state.isPlaying || state.isPaused;
        const resumeIdx = wasLiveActive ? state.currentIndex : 0;
        if (wasLiveActive) {
            stopPlayback(false);
        }

        exportState.runId += 1;
        const myRunId = exportState.runId;
        const exportLeaseId = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        exportState.active = true;
        exportState.leaseId = exportLeaseId;
        exportState.aborted = false;
        exportState.savePartialRequested = false;
        exportState.accumulatedSec = 0;
        exportState.chaptersCompleted = 0;
        exportState.currentChapter = 1;
        exportState.segIndex = 0;
        exportState.segTotal = 0;
        exportState.fetchingNext = false;
        exportState.waitingTranslation = false;
        exportState.nextOpenUrl = null;
        exportState.activePorts.clear();
        exportState.activeSockets.clear();
        exportState.activePreloadPort = null;
        exportState.abortRejects.clear();

        try {
            await loadAndApplyRuntimeConfig(options);
            if (exportState.runId !== myRunId || exportState.aborted) {
                throw new Error('EXPORT_ABORTED');
            }

            exportState.targetMinutes = Math.max(1, Math.min(240, Number(options.downloadMinutes || state.downloadMinutes) || DEFAULT_DOWNLOAD_MINUTES));
            state.downloadMinutes = exportState.targetMinutes;

            const requestedSource = options.downloadSource || state.downloadSource || 'current';
            const resolvedColabUrl = (options.colabServerUrl !== undefined ? options.colabServerUrl : state.colabServerUrl || '').trim().replace(/\/+$/, '');
            const resolvedColabVoice = (options.colabVoice !== undefined ? options.colabVoice : state.colabVoice || '').trim();
            const resolvedColabTier = options.colabGpuTier || state.colabGpuTier || 'T4';

            ensurePlayerUI();
            bindAltClickJump();
            bindTranslationProgress();

            if (requestedSource === 'colab_gpu') {
                if (!resolvedColabUrl || !/^https?:\/\//i.test(resolvedColabUrl)) {
                    exportState.active = false;
                    const colabErrMsg = tTts('tts_colab_err_url_missing', 'Hãy dán link Google Colab Tunnel (https://....trycloudflare.com) trước khi tải.');
                    updatePlayerUI(colabErrMsg, true);
                    notifyTtsToast(colabErrMsg, 'warning');
                    return { ok: false, error: 'colab_url_missing' };
                }
                const colabCfg = getColabGpuExportConfig(resolvedColabTier);
                exportState.useColabGpu = true;
                exportState.effectiveEngine = 'vieneu';
                exportState.effectiveServerUrl = resolvedColabUrl;
                exportState.effectiveVoice = resolvedColabVoice;
                exportState.targetWorkers = Number(options.colabWorkers) || colabCfg.workers;
                exportState.maxChunkChars = Number(options.colabMaxChunkChars) || colabCfg.maxChunkChars;
            } else {
                exportState.useColabGpu = false;
                exportState.effectiveEngine = state.engine;
                exportState.effectiveServerUrl = state.serverUrl;
                exportState.effectiveVoice = state.voice;
                exportState.targetWorkers = EXPORT_CONCURRENCY;
                exportState.maxChunkChars = EXPORT_MAX_CHUNK_CHARS;
                if (state.engine === 'webspeech') {
                    exportState.active = false;
                    const msg = tTts('tts_dl_webspeech_unsupported', 'Web Speech API không hỗ trợ xuất file WAV. Hãy chọn WebSocket TTS hoặc VieNeu.');
                    updatePlayerUI(msg, true);
                    notifyTtsToast(msg, 'warning');
                    return { ok: false, error: 'webspeech_unsupported' };
                }
            }

            updatePlayerUI(tTts('tts_dl_starting', `Đang chuẩn bị tạo audio (${exportState.targetMinutes} phút)...`).replace('{minutes}', String(exportState.targetMinutes)));

            if (global.STV_translationState && global.STV_translationState.active) {
                exportState.waitingTranslation = true;
                updatePlayerUI();
                await waitForActiveTranslation(myRunId);
                exportState.waitingTranslation = false;
            }

            const collected = await collectReadableSegments();
            if (collected.segments.length === 0) {
                exportState.active = false;
                const errMsg = tTts('tts_no_content', 'Không tìm thấy nội dung truyện. Hãy Dịch hoặc Chọn vùng trước.');
                updatePlayerUI(errMsg, true);
                return { ok: false, error: 'no_segments' };
            }

            state.segments = collected.segments;
            state.consumedLineEls = collected.consumedEls;
            state.wasTranslated = Boolean(
                collected.usedStvLines ||
                (global.STV_activeContentBox && global.STV_activeContentBox.querySelector('.stv-line'))
            );
            const currentDoc = (typeof document !== 'undefined') ? document : (global?.document || null);
            let nextUrl = (typeof global.STV_findNextChapterUrl === 'function' && currentDoc)
                ? global.STV_findNextChapterUrl(currentDoc, (global.location && global.location.href) || '')
                : null;
            state.nextChapterUrl = nextUrl;

            const effectiveConcurrency = await ensureMultiStreamVieNeuReady(exportLeaseId);
            if (exportState.runId !== myRunId || exportState.aborted) {
                throw new Error('EXPORT_ABORTED');
            }

            const startSliceIdx = (!options.startFromBeginning && resumeIdx > 0 && resumeIdx < collected.segments.length)
                ? resumeIdx
                : 0;
            const exportIconOpts = getActiveIconOptions();
            let chapterSegments = packSegmentsForExport(collected.segments.slice(startSliceIdx), exportState.maxChunkChars, exportIconOpts);
            if (chapterSegments.length === 0) {
                chapterSegments = collected.segments.slice(startSliceIdx);
            }

            const pcmInt16Chunks = [];
            let totalSamples24k = 0;
            const interSegSilence = new Int16Array(Math.round(EXPORT_SAMPLE_RATE * 0.03));
            const interChapSilence = new Int16Array(Math.round(EXPORT_SAMPLE_RATE * 0.8));
            const targetSeconds = exportState.targetMinutes * 60;
            const preloadMode = state.wasTranslated ? 'translate' : 'tts_only';
            let earlyStopReason = '';

            try {
                while (chapterSegments.length > 0 && exportState.chaptersCompleted < MAX_EXPORT_CHAPTERS) {
                    if (exportState.aborted || exportState.savePartialRequested || exportState.runId !== myRunId) break;

                    if (state.iconMode === 'auto') {
                        await scheduleAiIconResolution(chapterSegments, myRunId, { isExport: true, timeoutMs: 8000 });
                        if (exportState.aborted || exportState.savePartialRequested || exportState.runId !== myRunId) break;
                    }

                    const N = chapterSegments.length;
                    exportState.currentChapter = exportState.chaptersCompleted + 1;
                    exportState.segTotal = N;
                    exportState.segIndex = 0;
                    exportState.fetchingNext = false;

                    // Start preloading & translating the next chapter in parallel if this chapter won't finish target duration
                    let nextChapterPromise = null;
                    const estChapSec = estimateSegmentsDurationSec(chapterSegments, state.speed);
                    if (nextUrl && (exportState.accumulatedSec + estChapSec < targetSeconds * 1.15) && exportState.chaptersCompleted + 1 < MAX_EXPORT_CHAPTERS) {
                        nextChapterPromise = fetchAndTranslateChapterForExport(nextUrl, preloadMode, myRunId)
                            .then((data) => ({ ok: true, data }), (err) => ({ ok: false, err }));
                    }

                    const results = new Array(N);
                    let nextAssignIdx = 0;
                    let nextCommitIdx = 0;
                    let completedCount = 0;
                    let firstWorkerErr = null;

                    const commitReadySegments = () => {
                        while (nextCommitIdx < N && results[nextCommitIdx]) {
                            const segRes = results[nextCommitIdx];
                            results[nextCommitIdx] = null;
                            for (let k = 0; k < segRes.chunks.length; k++) {
                                pcmInt16Chunks.push(segRes.chunks[k]);
                            }
                            totalSamples24k += segRes.totalSamples;
                            if (nextCommitIdx < N - 1) {
                                pcmInt16Chunks.push(interSegSilence);
                                totalSamples24k += interSegSilence.length;
                            }
                            nextCommitIdx += 1;
                            exportState.accumulatedSec = totalSamples24k / EXPORT_SAMPLE_RATE;
                        }
                    };

                    const workerCount = Math.min(effectiveConcurrency, N);
                    const runWorker = async () => {
                        while (true) {
                            if (exportState.aborted || exportState.savePartialRequested || exportState.runId !== myRunId || firstWorkerErr) {
                                return;
                            }
                            const idx = nextAssignIdx++;
                            if (idx >= N) return;

                            exportState.segIndex = Math.min(N, Math.max(exportState.segIndex, idx + 1));
                            updatePlayerUI();

                            try {
                                const segRes = await synthesizeSegmentForExport(chapterSegments[idx].text, myRunId);
                                if (exportState.aborted || exportState.savePartialRequested || exportState.runId !== myRunId) {
                                    return;
                                }
                                results[idx] = segRes;
                                completedCount += 1;
                                commitReadySegments();
                                exportState.segIndex = Math.min(N, completedCount);
                                updatePlayerUI();
                            } catch (err) {
                                if (!firstWorkerErr) firstWorkerErr = err;
                                if (err?.message !== 'EXPORT_SAVE_PARTIAL' && err?.message !== 'EXPORT_ABORTED') {
                                    abortActiveExportNetwork();
                                }
                                return;
                            }
                        }
                    };

                    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
                    commitReadySegments();

                    if (firstWorkerErr) {
                        throw firstWorkerErr;
                    }
                    if (exportState.aborted || exportState.savePartialRequested || exportState.runId !== myRunId) {
                        break;
                    }

                    exportState.chaptersCompleted += 1;
                    exportState.accumulatedSec = totalSamples24k / EXPORT_SAMPLE_RATE;

                    if (exportState.accumulatedSec >= targetSeconds || exportState.chaptersCompleted >= MAX_EXPORT_CHAPTERS) {
                        break;
                    }
                    if (!nextUrl) {
                        earlyStopReason = 'Không tìm thấy link "Chương sau" cho chương kế tiếp.';
                        break;
                    }

                    let nextData = null;
                    if (nextChapterPromise) {
                        exportState.fetchingNext = true;
                        exportState.currentChapter = exportState.chaptersCompleted + 1;
                        updatePlayerUI();
                        const preloaded = await nextChapterPromise;
                        if (preloaded.ok) {
                            nextData = preloaded.data;
                        } else {
                            const fetchErr = preloaded.err;
                            if (exportState.aborted || exportState.savePartialRequested || fetchErr?.message === 'EXPORT_ABORTED' || fetchErr?.message === 'EXPORT_SAVE_PARTIAL') {
                                throw fetchErr;
                            }
                            earlyStopReason = fetchErr?.message || String(fetchErr || 'Lỗi tải/dịch chương kế tiếp');
                            console.warn(`[STV TTS Export] Dừng nối chương tại chương ${exportState.chaptersCompleted}:`, earlyStopReason);
                            break;
                        }
                    } else {
                        exportState.fetchingNext = true;
                        exportState.currentChapter = exportState.chaptersCompleted + 1;
                        updatePlayerUI();
                        try {
                            nextData = await fetchAndTranslateChapterForExport(nextUrl, preloadMode, myRunId);
                        } catch (fetchErr) {
                            if (exportState.aborted || exportState.savePartialRequested || fetchErr?.message === 'EXPORT_ABORTED' || fetchErr?.message === 'EXPORT_SAVE_PARTIAL') {
                                throw fetchErr;
                            }
                            earlyStopReason = fetchErr?.message || String(fetchErr || 'Lỗi tải/dịch chương kế tiếp');
                            console.warn(`[STV TTS Export] Dừng nối chương tại chương ${exportState.chaptersCompleted}:`, earlyStopReason);
                            break;
                        }
                    }

                    const lines = state.wasTranslated
                        ? extractCleanTranslatedLines(nextData.fullText)
                        : (Array.isArray(nextData.origChunks) ? nextData.origChunks : []);
                    const nextSegs = packSegmentsForExport(lines, exportState.maxChunkChars, exportIconOpts);
                    if (nextSegs.length === 0) {
                        earlyStopReason = 'Chương tiếp theo không có nội dung hợp lệ sau khi trích xuất/dịch.';
                        break;
                    }

                    pcmInt16Chunks.push(interChapSilence);
                    totalSamples24k += interChapSilence.length;
                    chapterSegments = nextSegs;
                    nextUrl = nextData.nextUrl || null;
                }
            } catch (loopErr) {
                if (loopErr?.message !== 'EXPORT_SAVE_PARTIAL') {
                    throw loopErr;
                }
            }

            if (exportState.aborted) {
                throw new Error('EXPORT_ABORTED');
            }

            if (totalSamples24k <= 0) {
                exportState.active = false;
                const noAudioMsg = tTts('tts_dl_no_audio', 'Chưa có dữ liệu âm thanh để lưu.');
                updatePlayerUI(noAudioMsg, true);
                return { ok: false, error: 'no_audio' };
            }

            const wav = encodeWavFromInt16Chunks(pcmInt16Chunks, EXPORT_SAMPLE_RATE);
            const actualMinNum = Math.max(1, Math.round(totalSamples24k / (EXPORT_SAMPLE_RATE * 60)));
            const exactMinLabel = (totalSamples24k / (EXPORT_SAMPLE_RATE * 60)).toFixed(1).replace(/\.0$/, '');
            const savedChapters = Math.max(1, exportState.chaptersCompleted || (totalSamples24k > 0 ? 1 : 0));
            const filename = `stv-audio-${actualMinNum}p-${savedChapters}ch.wav`;
            triggerWavFileDownload(wav.blob, filename);

            exportState.active = false;
            exportState.nextOpenUrl = nextUrl || null;
            if (earlyStopReason && !exportState.savePartialRequested) {
                const warnMsg = `Đã tải ${exactMinLabel}p (${savedChapters} ch.) · Dừng sớm: ${earlyStopReason}`;
                updatePlayerUI(warnMsg, true);
                notifyTtsToast(warnMsg, 'warning');
            } else {
                const doneMsg = tTts('tts_dl_done', `Đã tải xong ${exactMinLabel} phút (${savedChapters} chương)!`)
                    .replace('{minutes}', exactMinLabel)
                    .replace('{chapters}', String(savedChapters));
                updatePlayerUI(doneMsg);
                notifyTtsToast(doneMsg, 'success');
            }
            return { ok: true, filename, chapters: savedChapters, minutes: Number(exactMinLabel), byteLength: wav.byteLength };
        } catch (err) {
            exportState.active = false;
            exportState.waitingTranslation = false;
            exportState.fetchingNext = false;
            if (err?.message === 'EXPORT_ABORTED' && exportState.aborted) {
                const cancelMsg = tTts('tts_dl_cancelled', 'Đã hủy tải audio.');
                updatePlayerUI(cancelMsg);
                return { ok: false, cancelled: true };
            }
            const errMsg = err?.message || 'Lỗi tạo file audio WAV';
            updatePlayerUI(errMsg, true);
            notifyTtsToast(errMsg, 'error');
            return { ok: false, error: errMsg };
        } finally {
            releaseExportWorkers(exportLeaseId);
            if (exportState.runId === myRunId) {
                exportState.active = false;
                exportState.leaseId = null;
                exportState.useColabGpu = false;
                exportState.effectiveEngine = 'ws_default';
                exportState.effectiveServerUrl = '';
                exportState.effectiveVoice = '';
                exportState.targetWorkers = EXPORT_CONCURRENCY;
                exportState.maxChunkChars = EXPORT_MAX_CHUNK_CHARS;
                exportState.waitingTranslation = false;
                exportState.fetchingNext = false;
                exportState.abortRejects.clear();
            }
        }
    }

    async function startTTS(options = {}) {
        if (exportState.active) {
            cancelTTSDownload();
        }
        await loadAndApplyRuntimeConfig(options);
        ttsLog('startTTS', {
            engine: state.engine,
            voice: state.voice,
            speed: state.speed,
            stability: state.stabilityProfile,
            sampling: getSamplingParams(state.stabilityProfile)
        });

        ensurePlayerUI();
        bindAltClickJump();
        bindTranslationProgress();

        const collected = await collectReadableSegments();
        if (collected.segments.length === 0) {
            updatePlayerUI('Không tìm thấy văn bản truyện để đọc. Hãy Chọn Vùng Dịch hoặc Dịch chương trước.', true);
            return { ok: false, error: 'no_segments' };
        }

        state.runId += 1;
        state.waitingForMoreSegments = false;
        state.pendingWsReplay = false;
        state.autoplayBlocked = false;
        state.currentSession = null;
        clearPreloadTimer();
        disconnectPreloadWatchPort();
        state.preloadTriggered = false;
        state.preloadDone = false;
        state.preloadRequestInFlight = false;
        state.preloadId = null;
        state.preloadRetryCount = 0;
        state.preloadState = 'idle';
        abortPorts();
        stopStreamPlayer(false);
        state.segments = collected.segments;
        state.consumedLineEls = collected.consumedEls;
        state.wasTranslated = Boolean(
            collected.usedStvLines ||
            (global.STV_activeContentBox && global.STV_activeContentBox.querySelector('.stv-line'))
        );
        const currentDoc = (typeof document !== 'undefined') ? document : (global?.document || null);
        state.nextChapterUrl = (typeof global.STV_findNextChapterUrl === 'function' && currentDoc)
            ? global.STV_findNextChapterUrl(currentDoc, (global.location && global.location.href) || '')
            : null;
        if (!state.nextChapterUrl) {
            const capturedRun = state.runId;
            if (state.nextChapterTimer) clearTimeout(state.nextChapterTimer);
            state.nextChapterTimer = setTimeout(() => {
                state.nextChapterTimer = null;
                if (state.runId === capturedRun) {
                    refreshNextChapterUrl();
                }
            }, 1200);
        }
        state.liveTranslationRunId = (collected.usedStvLines && global.STV_translationState && global.STV_translationState.active)
            ? global.STV_translationState.runId
            : null;
        state.currentIndex = Math.max(0, Math.min(options.startIndex || 0, collected.segments.length - 1));

        // Bắt đầu giải mã các kaomoji phức tạp bằng AI theo ngữ cảnh ở chế độ ngầm (không chặn các câu không có icon)
        scheduleAiIconResolution(state.segments, state.runId);

        await ensureAudioContextReady();
        if (state.autoplayBlocked) {
            state.isPlaying = true;
            state.isPaused = false;
            highlightSegment(state.currentIndex);
            maybeTriggerNextChapterPreload();
            updatePlayerUI();
            return { ok: true, totalSegments: collected.segments.length, autoplayBlocked: true };
        }
        playSegment(state.currentIndex, state.runId);
        return { ok: true, totalSegments: collected.segments.length };
    }

    if (typeof global.addEventListener === 'function') {
        global.addEventListener('pagehide', () => {
            if (exportState.active && exportState.leaseId) {
                releaseExportWorkers(exportState.leaseId);
            }
            abortPorts();
            disconnectPreloadWatchPort();
        });
    }

    global.STV_TTSController = {
        start: startTTS,
        startDownload: startTTSDownload,
        cancelDownload: cancelTTSDownload,
        savePartialDownload: requestSavePartialDownload,
        stop: stopPlayback,
        togglePauseResume,
        toggleAutoNext,
        jumpToSegment,
        maybeTriggerNextChapterPreload,
        getState: () => ({
            isPlaying: state.isPlaying,
            isPaused: state.isPaused,
            autoplayBlocked: state.autoplayBlocked,
            currentIndex: state.currentIndex,
            total: state.segments.length,
            engine: state.engine,
            activeEngine: state.activeEngine,
            voice: state.voice,
            speed: state.speed,
            autoNextChapter: state.autoNextChapter,
            preloadLeadSec: state.preloadLeadSec,
            nextChapterUrl: state.nextChapterUrl,
            preloadState: state.preloadState,
            downloadMinutes: state.downloadMinutes,
            downloadSource: state.downloadSource,
            colabGpuTier: state.colabGpuTier,
            iconMode: state.iconMode,
            iconStyle: state.iconStyle,
            exportActive: exportState.active,
            nextOpenUrl: exportState.nextOpenUrl
        })
    };

    global.STV_startTTS = startTTS;
    global.STV_startTTSDownload = startTTSDownload;
    global.STV_stopTTS = () => stopPlayback(false);
    global.STV_getTTSState = global.STV_TTSController.getState;
})(typeof window !== 'undefined' ? window : globalThis);
