// tts-worklet.js - AudioWorkletProcessor phát PCM liên tục không tiếng tick giữa các chunk

class STVPcmStreamProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.chunks = [];
        this.headIdx = 0;
        this.headOffset = 0;
        this.totalSamples = 0;
        this.flushToken = null;
        this.lastSample = 0;
        this.wasUnderrun = false;
        this.fadeInLeft = 0;
        this.buffering = true;
        const sr = (typeof sampleRate === 'number' && sampleRate > 0) ? sampleRate : 48000;
        this.initialBufferSamples = Math.round(sr * 0.05);
        this.recoveryBufferSamples = Math.round(sr * 0.04);
        this.minBufferSamples = this.initialBufferSamples;

        this.port.onmessage = (e) => {
            const msg = e.data;
            if (!msg) return;

            if (msg.type === 'push' && msg.samples && msg.samples.length > 0) {
                if (this.wasUnderrun && this.totalSamples === 0) {
                    this.fadeInLeft = 64;
                }
                this.wasUnderrun = false;
                this.chunks.push(msg.samples);
                this.totalSamples += msg.samples.length;
                if (this.buffering && this.totalSamples >= this.minBufferSamples) {
                    this.buffering = false;
                }
            } else if (msg.type === 'flush') {
                this.flushToken = msg.token;
                this.buffering = false;
            } else if (msg.type === 'clear') {
                this.chunks = [];
                this.headIdx = 0;
                this.headOffset = 0;
                this.totalSamples = 0;
                this.flushToken = null;
                this.wasUnderrun = Math.abs(this.lastSample) > 1e-4;
                this.fadeInLeft = 0;
                this.minBufferSamples = this.initialBufferSamples;
                this.buffering = true;
            }
        };
    }

    process(_inputs, outputs) {
        const out = outputs[0] && outputs[0][0];
        if (!out) return true;

        let outPos = 0;
        const need = out.length;

        if (this.buffering && this.flushToken === null) {
            if (this.totalSamples < this.minBufferSamples) {
                for (let i = 0; i < need; i++) {
                    this.lastSample = Math.abs(this.lastSample) > 1e-5 ? this.lastSample * 0.96 : 0;
                    out[i] = this.lastSample;
                }
                return true;
            }
            this.buffering = false;
        }

        while (outPos < need && this.totalSamples > 0) {
            const cur = this.chunks[this.headIdx];
            const avail = cur.length - this.headOffset;
            const take = Math.min(need - outPos, avail);

            for (let i = 0; i < take; i++) {
                let s = cur[this.headOffset + i];
                if (this.fadeInLeft > 0) {
                    s *= (64 - this.fadeInLeft) / 64;
                    this.fadeInLeft -= 1;
                }
                out[outPos + i] = s;
                this.lastSample = s;
            }

            outPos += take;
            this.headOffset += take;
            this.totalSamples -= take;

            if (this.headOffset >= cur.length) {
                this.headIdx += 1;
                this.headOffset = 0;
            }
        }

        if (this.headIdx >= 32) {
            this.chunks = this.chunks.slice(this.headIdx);
            this.headIdx = 0;
        }

        if (outPos < need) {
            // Suy giảm mượt thay vì cắt ngang về 0 để triệt tiếng tick khi hụt buffer hoặc ngắt câu
            for (let i = outPos; i < need; i++) {
                this.lastSample = Math.abs(this.lastSample) > 1e-5 ? this.lastSample * 0.96 : 0;
                out[i] = this.lastSample;
            }

            if (this.flushToken !== null) {
                const token = this.flushToken;
                this.flushToken = null;
                this.wasUnderrun = false;
                this.minBufferSamples = this.initialBufferSamples;
                this.buffering = true;
                this.port.postMessage({ type: 'drained', token });
            } else if (outPos > 0) {
                this.wasUnderrun = true;
                this.minBufferSamples = this.recoveryBufferSamples;
                this.buffering = true;
                this.port.postMessage({ type: 'underrun' });
            }
        }

        return true;
    }
}

registerProcessor('stv-pcm-player', STVPcmStreamProcessor);
