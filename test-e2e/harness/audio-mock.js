/**
 * test-e2e/harness/audio-mock.js
 * High-fidelity AudioContext and Web Speech API Mocks for Node.js v24.
 */

export class MockAudioContext {
    constructor(options = {}) {
        this.sampleRate = options.sampleRate || 48000;
        this.state = options.state || 'running';
        this.currentTime = 0;
        this.destination = {
            connect: () => {},
            disconnect: () => {}
        };
        this._addedModules = [];
        this.audioWorklet = {
            addModule: async (url) => {
                this._addedModules.push(url);
                return true;
            }
        };
    }

    async resume() {
        this.state = 'running';
    }

    async suspend() {
        this.state = 'suspended';
    }

    async close() {
        this.state = 'closed';
    }

    createGain() {
        return {
            gain: { value: 1.0, setValueAtTime: () => {} },
            connect: () => {},
            disconnect: () => {}
        };
    }

    createBuffer(channels, length, sampleRate) {
        return {
            numberOfChannels: channels,
            length,
            sampleRate,
            duration: length / sampleRate,
            getChannelData: () => new Float32Array(length)
        };
    }

    createBufferSource() {
        return {
            buffer: null,
            playbackRate: { value: 1.0 },
            connect: () => {},
            disconnect: () => {},
            start: () => {},
            stop: () => {},
            onended: null
        };
    }

    decodeAudioData(arrayBuffer) {
        return Promise.resolve(this.createBuffer(1, 4800, this.sampleRate));
    }
}

export class MockAudioWorkletNode {
    constructor(context, name) {
        this.context = context;
        this.name = name;
        this.messages = [];
        this.port = {
            postMessage: (msg) => {
                this.messages.push(msg);
                if (msg && msg.type === 'flush' && this.port.onmessage) {
                    queueMicrotask(() => {
                        this.port.onmessage({ data: { type: 'drained', token: msg.token } });
                    });
                }
            },
            onmessage: null
        };
    }

    connect() {}
    disconnect() {}
}

export class MockSpeechSynthesisUtterance {
    constructor(text = '') {
        this.text = String(text != null ? text : '');
        this.lang = 'vi-VN';
        this.voice = null;
        this.rate = 1.0;
        this.pitch = 1.0;
        this.volume = 1.0;
        this.onstart = null;
        this.onend = null;
        this.onerror = null;
        this.onpause = null;
        this.onresume = null;
    }
}

export class MockSpeechSynthesis {
    constructor() {
        this.speaking = false;
        this.paused = false;
        this.pending = false;
        this.queue = [];
        this.history = [];
        this.heartbeatCount = 0;
        this._voices = [
            { name: 'Google Tiếng Việt', lang: 'vi-VN', default: true },
            { name: 'Microsoft An - Vietnamese', lang: 'vi-VN', default: false },
            { name: 'Google US English', lang: 'en-US', default: false },
            { name: 'Microsoft Zira - English', lang: 'en-US', default: false }
        ];
    }

    getVoices() {
        return [...this._voices];
    }

    speak(utterance) {
        if (!utterance) return;
        this.queue.push(utterance);
        this.history.push(utterance);
        this.speaking = true;
        this.pending = this.queue.length > 1;

        queueMicrotask(() => {
            if (this.queue[0] === utterance && typeof utterance.onstart === 'function') {
                utterance.onstart({ type: 'start', utterance });
            }
        });
    }

    cancel() {
        const remaining = [...this.queue];
        this.queue = [];
        this.speaking = false;
        this.paused = false;
        this.pending = false;
        for (const u of remaining) {
            if (typeof u.onerror === 'function') {
                u.onerror({ type: 'error', error: 'canceled', utterance: u });
            }
        }
    }

    pause() {
        this.paused = true;
        this.heartbeatCount += 1;
        const cur = this.queue[0];
        if (cur && typeof cur.onpause === 'function') {
            cur.onpause({ type: 'pause', utterance: cur });
        }
    }

    resume() {
        this.paused = false;
        const cur = this.queue[0];
        if (cur && typeof cur.onresume === 'function') {
            cur.onresume({ type: 'resume', utterance: cur });
        }
    }

    simulateCompleteCurrent() {
        const cur = this.queue.shift();
        if (cur) {
            if (typeof cur.onend === 'function') {
                cur.onend({ type: 'end', utterance: cur });
            }
        }
        if (this.queue.length === 0) {
            this.speaking = false;
            this.pending = false;
        } else {
            const next = this.queue[0];
            if (next && typeof next.onstart === 'function') {
                next.onstart({ type: 'start', utterance: next });
            }
        }
    }

    simulateErrorCurrent(errorName = 'audio-busy') {
        const cur = this.queue.shift();
        if (cur) {
            if (typeof cur.onerror === 'function') {
                cur.onerror({ type: 'error', error: errorName, utterance: cur });
            }
        }
        if (this.queue.length === 0) {
            this.speaking = false;
            this.pending = false;
        }
    }
}
