// apu.js
// NES Audio Processing Unit (APU) - cycle-accurate skeleton
// Supports frame counter, pulse/triangle/noise/DMC stubs, IRQs

export default class APU {
    constructor(cpu, memory) {
        this.cpu = cpu;
        this.memory = memory;

        // === Web Audio API ===
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.sampleRate = this.ctx.sampleRate;
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.3;
        this.masterGain.connect(this.ctx.destination);

        // === Channels ===
        this.pulse1 = new PulseChannel(this.ctx);
        this.pulse2 = new PulseChannel(this.ctx);
        this.triangle = new TriangleChannel(this.ctx);
        this.noise = new NoiseChannel(this.ctx);
        this.dmc = new DMCChannel(this.ctx, memory);

        this.pulse1.output.connect(this.masterGain);
        this.pulse2.output.connect(this.masterGain);
        this.triangle.output.connect(this.masterGain);
        this.noise.output.connect(this.masterGain);
        this.dmc.output.connect(this.masterGain);

        // === Frame counter ===
        this.cycles = 0;
        this.frameStep = 0;
        this.frameCounterMode = 0; // 0 = 4-step, 1 = 5-step
        this.frameIRQ = false;
    }

    step() {
        this.cycles++;

        // NTSC frame sequencer: 7457 CPU cycles per step
        if (this.cycles % 7457 === 0) {
            this.stepFrameCounter();
        }

        // Tick DMC each cycle
        this.dmc.step();
    }

    stepFrameCounter() {
        if (this.frameCounterMode === 0) {
            // 4-step sequence, generates IRQ
            this.frameStep = (this.frameStep + 1) % 4;
            if (this.frameStep === 3) {
                this.frameIRQ = true;
            }
        } else {
            // 5-step sequence, no IRQ
            this.frameStep = (this.frameStep + 1) % 5;
        }

        // TODO: also tick envelopes, length counters, sweep units
    }

    // === Register interface (CPU writes) ===
    write(addr, value) {
        if (addr >= 0x4000 && addr <= 0x4003) this.pulse1.write(addr, value);
        else if (addr >= 0x4004 && addr <= 0x4007) this.pulse2.write(addr, value);
        else if (addr >= 0x4008 && addr <= 0x400B) this.triangle.write(addr, value);
        else if (addr >= 0x400C && addr <= 0x400F) this.noise.write(addr, value);
        else if (addr >= 0x4010 && addr <= 0x4013) this.dmc.write(addr, value);
        else if (addr === 0x4015) {
            this.setChannelEnable(value);
        } else if (addr === 0x4017) {
            this.frameCounterMode = (value >> 7) & 1;
            if (value & 0x40) {
                this.frameIRQ = false; // disable frame IRQ
            }
        }
    }

    // === Register interface (CPU reads) ===
    read(addr) {
        if (addr === 0x4015) {
            let status =
                (this.pulse1.enabled ? 1 : 0) |
                (this.pulse2.enabled ? 2 : 0) |
                (this.triangle.enabled ? 4 : 0) |
                (this.noise.enabled ? 8 : 0) |
                (this.dmc.enabled ? 16 : 0);
            this.frameIRQ = false; // reading clears frame IRQ
            return status;
        }
        return 0;
    }

    setChannelEnable(value) {
        this.pulse1.setEnabled(value & 1);
        this.pulse2.setEnabled(value & 2);
        this.triangle.setEnabled(value & 4);
        this.noise.setEnabled(value & 8);
        this.dmc.setEnabled(value & 16);
    }

    // CPU checks this every cycle
    getIRQ() {
        return this.frameIRQ || this.dmc.dmcIRQ;
    }
}

/* ========================
   Channel Implementations
   ======================== */

// --- Pulse channel (simplified stub) ---
class PulseChannel {
    constructor(ctx) {
        this.ctx = ctx;
        this.osc = ctx.createOscillator();
        this.gain = ctx.createGain();
        this.osc.type = "square"; // Approximate NES pulse
        this.gain.gain.value = 0;
        this.osc.connect(this.gain);
        this.osc.start();
        this.output = this.gain;
        this.enabled = false;
    }
    write(addr, value) {
        // TODO: duty cycle, sweep, envelope
    }
    setEnabled(on) {
        this.enabled = !!on;
        this.gain.gain.value = this.enabled ? 0.2 : 0;
    }
}

// --- Triangle channel (simplified stub) ---
class TriangleChannel {
    constructor(ctx) {
        this.ctx = ctx;
        this.osc = ctx.createOscillator();
        this.gain = ctx.createGain();
        this.osc.type = "triangle";
        this.gain.gain.value = 0;
        this.osc.connect(this.gain);
        this.osc.start();
        this.output = this.gain;
        this.enabled = false;
    }
    write(addr, value) {
        // TODO: linear counter, length counter
    }
    setEnabled(on) {
        this.enabled = !!on;
        this.gain.gain.value = this.enabled ? 0.2 : 0;
    }
}

// --- Noise channel (simplified stub) ---
class NoiseChannel {
    constructor(ctx) {
        this.ctx = ctx;
        this.bufferSize = 2 * ctx.sampleRate;
        const noiseBuffer = ctx.createBuffer(1, this.bufferSize, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < this.bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        this.noise = ctx.createBufferSource();
        this.noise.buffer = noiseBuffer;
        this.noise.loop = true;
        this.gain = ctx.createGain();
        this.gain.gain.value = 0;
        this.noise.connect(this.gain);
        this.noise.start();
        this.output = this.gain;
        this.enabled = false;
    }
    write(addr, value) {
        // TODO: implement period, envelope
    }
    setEnabled(on) {
        this.enabled = !!on;
        this.gain.gain.value = this.enabled ? 0.2 : 0;
    }
}

// --- DMC channel (with DMA + IRQ) ---
class DMCChannel {
    constructor(ctx, memory) {
        this.ctx = ctx;
        this.memory = memory;
        this.gain = ctx.createGain();
        this.gain.gain.value = 0;
        this.output = this.gain;
        this.enabled = false;
        this.dmcIRQ = false;

        // DMC state
        this.sampleAddress = 0xC000;
        this.sampleLength = 1;
        this.currentLength = 0;
        this.shiftRegister = 0;
        this.bitsRemaining = 0;
        this.bufferEmpty = true;
        this.outputLevel = 64;
    }

    write(addr, value) {
        switch (addr) {
            case 0x4010:
                this.irqEnabled = (value & 0x80) !== 0;
                this.loop = (value & 0x40) !== 0;
                this.rate = value & 0x0F;
                break;
            case 0x4011:
                this.outputLevel = value & 0x7F;
                break;
            case 0x4012:
                this.sampleAddress = 0xC000 + (value * 64);
                break;
            case 0x4013:
                this.sampleLength = (value * 16) + 1;
                break;
        }
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (this.enabled && this.currentLength === 0) {
            this.restartSample();
        }
    }

    restartSample() {
        this.currentAddress = this.sampleAddress;
        this.currentLength = this.sampleLength;
    }

    step() {
        if (!this.enabled) return;

        if (this.bitsRemaining === 0) {
            if (this.bufferEmpty) {
                this.fetchSample();
            }
            if (!this.bufferEmpty) {
                this.shiftRegister = this.sampleBuffer;
                this.bitsRemaining = 8;
                this.bufferEmpty = true;
            }
        }

        if (this.bitsRemaining > 0) {
            if (this.shiftRegister & 1) {
                if (this.outputLevel <= 125) this.outputLevel += 2;
            } else {
                if (this.outputLevel >= 2) this.outputLevel -= 2;
            }
            this.shiftRegister >>= 1;
            this.bitsRemaining--;
        }
    }

    fetchSample() {
        if (this.currentLength > 0) {
            this.sampleBuffer = this.memory.read(this.currentAddress);
            this.currentAddress++;
            if (this.currentAddress > 0xFFFF) this.currentAddress = 0x8000;
            this.currentLength--;
            this.bufferEmpty = false;
            if (this.currentLength === 0) {
                if (this.loop) {
                    this.restartSample();
                } else if (this.irqEnabled) {
                    this.dmcIRQ = true;
                }
            }
        }
    }
