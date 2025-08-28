// emulator.js
// Central hub that coordinates CPU, PPU, APU, memory/bus, controller input, and input settings
// for an NES emulator. This file is intentionally framework-agnostic and pure JS (ES2020+).
//
// It expects *pluggable* components that follow small, well-documented interfaces below.
// Drop this file into your project and wire it up with your CPU/PPU/APU/Bus/Mapper/Input impls.
//
// ────────────────────────────────────────────────────────────────────────────────
// Component Interfaces (expected shape)
//
// CPU:
//   .reset()
//   .step() -> cycles:int (1 or 2; returns CPU cycles just executed)
//   .nmi()                 (edge-trigger NMI)
//   .irq(level:boolean)    (level-trigger IRQ)
//   .connectBus(bus)
//   .getState() / .setState(state)
//
// PPU:
//   .reset()
//   .step() -> { newFrame:boolean }  (run 1 PPU cycle; tells when a frame has just finished)
//   .connectBus(bus)
//   .getFramebuffer() -> Uint32Array (RGBA8888, 256*240 length)  OR provide .onFrame(cb)
//   .nmiLine    (boolean getter)     (PPU asserts NMI via /NMI line)
//   .getState() / .setState(state)
//
// APU:
//   .reset(sampleRateHz:number)
//   .step(cpuCycles:int)             (advance APU by given CPU cycles)
//   .sample() -> number              (pulls the next audio sample in [-1,1])
//   .needSample() -> boolean         (true when DAC wants a new sample)
//   .irqLine (boolean getter)        (APU frame IRQ level)
//   .getState() / .setState(state)
//
// Bus (Memory + Mappers + OAM DMA, etc.):
//   .reset()
//   .connectCPU(cpu)
//   .connectPPU(ppu)
//   .connectAPU(apu)
//   .loadCartridge(romBytes:Uint8Array)
//   .getState() / .setState(state)
//
// Input (Controllers + Settings):
//   .reset()
//   .read(port:int) -> byte
//   .write(port:int, value:byte)
//   .getSettings() / .setSettings(settings)
//   .getState() / .setState(state)
//
// Notes:
//  • If your PPU provides an .onFrame(cb) callback, Emulator will use it automatically.
//  • If not, Emulator polls PPU.getFramebuffer() at end of frame.
//  • Audio: This hub supports a push-pull hybrid. If your APU buffers internally, expose
//    .readBufferedSamples(N) instead; you can adapt in the 'Audio plumbing' section.
//
// ────────────────────────────────────────────────────────────────────────────────

export class Emulator {
  // Timing constants (NTSC by default)
  static NTSC = {
    CPU_HZ: 1789773,     // Ricoh 2A03 clock
    PPU_PER_CPU: 3,      // PPU runs 3x CPU frequency
    FPS: 60.0,
  };

  static PAL = {
    CPU_HZ: 1662607,     // PAL CPU clock
    PPU_PER_CPU: 3,      // same 3x relation
    FPS: 50.0,
  };

  /**
   * @param {Object} opts
   * @param {'NTSC'|'PAL'} [opts.region='NTSC']
   * @param {Object} opts.cpu  - CPU instance
   * @param {Object} opts.ppu  - PPU instance
   * @param {Object} opts.apu  - APU instance
   * @param {Object} opts.bus  - Memory/Bus instance (with mapper hookup)
   * @param {Object} opts.input - Input instance (controllers)
   * @param {number} [opts.sampleRate=48000] - Audio output sample rate
   * @param {(framebuffer:Uint32Array)=>void} [opts.onVideoFrame] - Called each completed frame
   * @param {(samples:Float32Array)=>void} [opts.onAudioSamples]  - Called with audio bursts
   * @param {number} [opts.audioBatch=1024] - How many samples to batch per callback
   */
  constructor(opts) {
    const {
      region = 'NTSC',
      cpu, ppu, apu, bus, input,
      sampleRate = 48000,
      onVideoFrame = null,
      onAudioSamples = null,
      audioBatch = 1024,
    } = opts || {};

    if (!cpu || !ppu || !apu || !bus || !input) {
      throw new Error('Emulator missing required components: cpu, ppu, apu, bus, input');
    }

    this.region = region.toUpperCase() === 'PAL' ? Emulator.PAL : Emulator.NTSC;
    this.cpu = cpu;
    this.ppu = ppu;
    this.apu = apu;
    this.bus = bus;
    this.input = input;

    this.sampleRate = sampleRate | 0;
    this.onVideoFrame = typeof onVideoFrame === 'function' ? onVideoFrame : null;
    this.onAudioSamples = typeof onAudioSamples === 'function' ? onAudioSamples : null;
    this.audioBatch = Math.max(64, audioBatch | 0);

    // Derived timing
    this.cpuCyclesPerFrame = this.region.CPU_HZ / this.region.FPS; // ~29829.5 (NTSC)
    this._audioAccumulator = new Float32Array(this.audioBatch);
    this._audioWriteIdx = 0;

    // Wires
    this.cpu.connectBus(this.bus);
    this.ppu.connectBus(this.bus);
    this.apu && this.bus.connectAPU && this.bus.connectAPU(this.apu);
    this.bus.connectCPU(this.cpu);
    this.bus.connectPPU(this.ppu);

    // Interrupt lines
    this._nmiPrev = false;

    // Video callback path: subscribe if provided
    if (this.ppu.onFrame && typeof this.ppu.onFrame === 'function' && this.onVideoFrame) {
      this.ppu.onFrame((fb) => this.onVideoFrame(fb));
    }

    // Runtime control
    this._running = false;
    this._frameCounter = 0;

    // Initialize
    this.reset();
  }

  /** Load iNES/UNIF bytes and hard-reset. */
  loadROM(romBytes) {
    if (!(romBytes instanceof Uint8Array)) {
      throw new Error('loadROM expects a Uint8Array');
    }
    this.stop();
    this.bus.loadCartridge(romBytes);
    this.reset(); // cold boot after cart insertion
  }

  /** Cold reset (like power cycle). */
  reset() {
    this._frameCounter = 0;
    this._audioWriteIdx = 0;
    this._nmiPrev = false;

    this.bus.reset();
    // Region-dependent init
    this.apu.reset(this.sampleRate);
    this.ppu.reset();
    this.input.reset();
    this.cpu.reset();
  }

  /** Soft reset (CPU/PPU/APU) but preserve cartridge. */
  softReset() {
    this._audioWriteIdx = 0;
    this._nmiPrev = false;
    this.apu.reset(this.sampleRate);
    this.ppu.reset();
    this.cpu.reset();
  }

  /** Attach a video sink later. */
  setVideoSink(fn) {
    this.onVideoFrame = typeof fn === 'function' ? fn : null;
  }

  /** Attach an audio sink later. */
  setAudioSink(fn) {
    this.onAudioSamples = typeof fn === 'function' ? fn : null;
  }

  /** Change region timing (applies on next reset). */
  setRegion(region /* 'NTSC'|'PAL' */) {
    this.region = region.toUpperCase() === 'PAL' ? Emulator.PAL : Emulator.NTSC;
    this.cpuCyclesPerFrame = this.region.CPU_HZ / this.region.FPS;
  }

  /** Update input settings (button bindings, turbo, etc.). */
  setInputSettings(settings) {
    if (this.input.setSettings) this.input.setSettings(settings);
  }

  /** Read back current input settings. */
  getInputSettings() {
    return this.input.getSettings ? this.input.getSettings() : {};
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Core stepping
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Execute approximately one frame worth of emulation.
   * Returns an object with stats for profiling.
   */
  runFrame() {
    let cpuCyclesTarget = this.cpuCyclesPerFrame;
    let cpuCyclesRun = 0;
    let ppuCyclesRun = 0;
    let framesCompleted = 0;

    // We iterate CPU as the master, driving PPU/APU (PPU runs 3x per CPU tick).
    // We stop as soon as the PPU reports a new frame OR we reach the target CPU cycles.
    while (framesCompleted === 0 && cpuCyclesRun < cpuCyclesTarget) {
      // 1) CPU step → returns cycles consumed (1 or 2 for some ops)
      const c = this.cpu.step();
      cpuCyclesRun += c;

      // 2) PPU runs 3 * c cycles
      for (let i = 0; i < c * this.region.PPU_PER_CPU; i++) {
        const { newFrame } = this.ppu.step();
        ppuCyclesRun++;
        // Edge-trigger NMI from PPU (VBlank)
        this._serviceNMI();
        if (newFrame) {
          framesCompleted++;
          // If PPU didn't push the frame (no onFrame), pull and present
          if (this.onVideoFrame && !this.ppu.onFrame) {
            const fb = this.ppu.getFramebuffer();
            if (fb) this.onVideoFrame(fb);
          }
        }
      }

      // 3) APU advances by CPU cycles (APU internal timer uses CPU dividers)
      this.apu.step(c);
      this._pumpAudio();

      // 4) IRQ handling (APU frame IRQ and mapper IRQ may both assert)
      this._serviceIRQ();
    }

    this._frameCounter += framesCompleted;

    return {
      cpuCyclesRun,
      ppuCyclesRun,
      framesCompleted,
      frameIndex: this._frameCounter,
    };
  }

  /** Execute a single CPU instruction worth of time (plus synced PPU/APU). */
  stepInstruction() {
    const c = this.cpu.step();

    // PPU x3 per CPU cycle
    for (let i = 0; i < c * this.region.PPU_PER_CPU; i++) {
      this.ppu.step();
      this._serviceNMI();
    }

    // APU and audio
    this.apu.step(c);
    this._pumpAudio();

    // IRQs
    this._serviceIRQ();

    return c;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Interrupts
  // ────────────────────────────────────────────────────────────────────────────

  _serviceNMI() {
    const nmiLevel = !!this.ppu.nmiLine;
    if (nmiLevel && !this._nmiPrev) {
      this.cpu.nmi(); // rising edge
    }
    this._nmiPrev = nmiLevel;
  }

  _serviceIRQ() {
    // APU IRQ (frame sequencer) – level triggered
    const apuIRQ = !!this.apu.irqLine;

    // Mapper IRQ: allow bus to expose a line (optional)
    const mapperIRQ = !!(this.bus.mapper && this.bus.mapper.irqLine);

    // Some buses expose a combined IRQ line; prefer explicit sources then fallback
    const busIRQ = !!this.bus.irqLine;

    const irqAsserted = apuIRQ || mapperIRQ || busIRQ;
    this.cpu.irq(irqAsserted);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Audio plumbing
  // ────────────────────────────────────────────────────────────────────────────

  _pumpAudio() {
    if (!this.onAudioSamples) return;

    // Strategy A: pull samples whenever the APU says it's time
    while (this.apu.needSample && this.apu.needSample()) {
      const s = this.apu.sample();
      this._enqueueSample(typeof s === 'number' ? s : 0);
    }

    // If your APU provides buffered reads, adapt it like:
    // const n = this.apu.available();
    // if (n > 0) {
    //   const chunk = this.apu.readBufferedSamples(Math.min(n, this.audioBatch - this._audioWriteIdx));
    //   this._audioAccumulator.set(chunk, this._audioWriteIdx);
    //   this._audioWriteIdx += chunk.length;
    //   if (this._audioWriteIdx >= this.audioBatch) this._flushAudio();
    // }
  }

  _enqueueSample(s) {
    // Clip to [-1, 1] just in case
    const clipped = s < -1 ? -1 : s > 1 ? 1 : s;
    this._audioAccumulator[this._audioWriteIdx++] = clipped;
    if (this._audioWriteIdx >= this.audioBatch) {
      this._flushAudio();
    }
  }

  _flushAudio() {
    if (!this.onAudioSamples || this._audioWriteIdx === 0) {
      this._audioWriteIdx = 0;
      return;
    }
    const out = new Float32Array(this._audioAccumulator.subarray(0, this._audioWriteIdx));
    this._audioWriteIdx = 0;
    this.onAudioSamples(out);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Run loop helpers (no timers; host decides real-time pacing)
  // ────────────────────────────────────────────────────────────────────────────

  /** Run N frames (useful for batch headless rendering or tests). */
  runFrames(count = 1) {
    const n = Math.max(0, count | 0);
    let stats = null;
    for (let i = 0; i < n; i++) {
      stats = this.runFrame();
    }
    return stats;
  }

  /** Start/stop flags (host is responsible for scheduling frames). */
  start() { this._running = true; }
  stop()  { this._running = false; }
  get running() { return this._running; }

  // ────────────────────────────────────────────────────────────────────────────
  // Save states
  // ────────────────────────────────────────────────────────────────────────────

  /** Create a compact, serializable save-state. */
  saveState() {
    return {
      v: 1,                        // version
      region: this.region === Emulator.PAL ? 'PAL' : 'NTSC',
      frame: this._frameCounter,
      cpu: this.cpu.getState ? this.cpu.getState() : null,
      ppu: this.ppu.getState ? this.ppu.getState() : null,
      apu: this.apu.getState ? this.apu.getState() : null,
      bus: this.bus.getState ? this.bus.getState() : null,
      input: this.input.getState ? this.input.getState() : null,
      audioWriteIdx: this._audioWriteIdx,
      // Note: we don't persist audio accumulator contents; not meaningful across loads.
    };
  }

  /** Load a previously created save-state. */
  loadState(state) {
    if (!state || typeof state !== 'object') throw new Error('Invalid state');

    this.stop();

    // Region may affect timing; apply first
    this.setRegion(state.region || 'NTSC');

    // Restore subcomponents
    if (state.bus && this.bus.setState) this.bus.setState(state.bus);
    if (state.cpu && this.cpu.setState) this.cpu.setState(state.cpu);
    if (state.ppu && this.ppu.setState) this.ppu.setState(state.ppu);
    if (state.apu && this.apu.setState) this.apu.setState(state.apu);
    if (state.input && this.input.setState) this.input.setState(state.input);

    this._frameCounter = state.frame | 0;
    this._audioWriteIdx = 0;
    this._nmiPrev = !!(this.ppu && this.ppu.nmiLine);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Controller I/O convenience (for UIs)
  // ────────────────────────────────────────────────────────────────────────────

  /** Programmatic button press/release (port: 0 or 1). */
  setButton(port, buttonName, pressed) {
    if (this.input.setButton) this.input.setButton(port | 0, String(buttonName), !!pressed);
  }

  /** Snapshot controller state (useful for debugging). */
  getControllerState(port = 0) {
    return this.input.getControllerState ? this.input.getControllerState(port | 0) : {};
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ────────────────────────────────────────────────────────────────────────────

  /** Quick, human-friendly profile of one frame. */
  profileFrame() {
    const t0 = nowMs();
    const stats = this.runFrame();
    const t1 = nowMs();
    return {
      ms: +(t1 - t0).toFixed(3),
      fpsApprox: +(1000 / (t1 - t0)).toFixed(2),
      ...stats,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Simple high-res timer that works in both browser and Node.
// ──────────────────────────────────────────────────────────────────────────────
function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  const [s, ns] = process.hrtime ? process.hrtime() : [Math.floor(Date.now() / 1000), (Date.now() % 1000) * 1e6];
  return s * 1000 + ns / 1e6;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Example wiring (pseudo, not executed here):

   import { Emulator } from './emulator.js';
   import { CPU } from './cpu.js';
   import { PPU } from './ppu.js';
   import { APU } from './apu.js';
   import { Bus } from './bus.js';
   import { Input } from './input.js';

   const emu = new Emulator({
     region: 'NTSC',
     cpu: new CPU(),
     ppu: new PPU(),
     apu: new APU(),
     bus: new Bus(),
     input: new Input(),
     sampleRate: 48000,
     onVideoFrame: (framebufferRGBA) => {
       // draw framebuffer (Uint32Array length 256*240) to a <canvas>
     },
     onAudioSamples: (samplesF32) => {
       // queue Float32Array to WebAudio AudioWorklet/ScriptProcessor
     },
     audioBatch: 1024,
   });

   // Load ROM bytes (Uint8Array):
   // emu.loadROM(romBytes);

   // Drive emulation from your host:
   function animationFrameLoop() {
     // For a 60Hz display, one runFrame() per RAF is about right.
     emu.runFrame();
     requestAnimationFrame(animationFrameLoop);
   }
   requestAnimationFrame(animationFrameLoop);
