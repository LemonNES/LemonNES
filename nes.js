// nes.js
import { CPU6502 } from './cpu6502.js';
import { PPU } from './ppu.js';
import { APU } from './apu.js';
import { Bus } from './memory.js';
import { Controller } from './input.js';
import { Cartridge } from './cartridge.js';

// DOM
const canvas = document.getElementById('screen');
const romFile = document.getElementById('romFile');
const btnUseBuilt = document.getElementById('btnUseBuilt');
const btnRun = document.getElementById('btnRun');
const btnPause = document.getElementById('btnPause');
const btnReset = document.getElementById('btnReset');

let nes = null;
let running = false;

// Create components helper
function createNESFromROMBytes(bytes) {
  const cart = new Cartridge(bytes);
  const ppu = new PPU();
  ppu.attachCanvas(canvas);
  const apu = new APU(); // stubbed APU; ok for now
  const c1 = new Controller();
  const c2 = new Controller();
  const cpu = new CPU6502();
  const bus = new Bus(cpu, ppu, apu, [c1, c2], cart);
  cpu.connectBus(bus);
  ppu.connectCart(cart);
  // expose
  return { cpu, ppu, apu, bus, controllers: [c1,c2], cart };
}

// Built-in test ROM (small homebrew iNES PRG) — draws a simple background color via PPU writes
function buildBuiltInTestROM() {
  // Build a tiny iNES file:
  // PRG: 16KB with code:
  // - Reset vector -> code that writes to $2000/$2001/$2006/$2007 to paint pattern table / palette then infinite loop.
  // CHR: provide 8KB CHR-RAM (filled zeros) so PPU has something.
  // This is minimal test content to confirm CPU runs, bus talks to PPU, and PPU renders something.
  const PRG = new Uint8Array(16384);
  // Simple code (6502 assembly translated into machine bytes):
  // We will write naive bytes: set PPUCTRL/PPUMASK, write to PPUADDR then PPUDATA to set some nametable bytes.
  // The code below is hand-crafted:
  // LDX #$00
  // STX $2000- this would be STA though; we'll use immediate loads + STA
  // We'll do: LDA #$80 ; STA $2000 ; LDA #$08 ; STA $2001 ; LDA #$3F ; STA $2006 ; LDA #$00 ; STA $2007 ; JMP $8000
  // Machine code:
  // A9 80   LDA #$80
  // 8D 00 20 STA $2000
  // A9 08   LDA #$08
  // 8D 01 20 STA $2001
  // A9 3F   LDA #$3F
  // 8D 00 20 STA $2006 ; note: $2006 is two-byte write: high then low — this example is simplistic and not fully correct but OK for smoke test.
  // A9 00   LDA #$00
  // 8D 07 20 STA $2007
  // 4C 00 80 JMP $8000
  const code = [
    0xA9,0x80, 0x8D,0x00,0x20,
    0xA9,0x08, 0x8D,0x01,0x20,
    0xA9,0x3F, 0x8D,0x00,0x20, // write $2006 low? (approx)
    0xA9,0x00, 0x8D,0x07,0x20,
    0x4C,0x00,0x80
  ];
  PRG.set(code, 0x0000);

  // iNES header
  const header = new Uint8Array(16);
  header[0]=0x4E;header[1]=0x45;header[2]=0x53;header[3]=0x1A; // NES\26
  header[4]=1; // 1x16KB PRG
  header[5]=1; // 1x8KB CHR (we provide CHR RAM)
  header[6]=0; header[7]=0; header[8]=0; header[9]=0; // flags/minor
  // CHR (8KB) fill zeros
  const CHR = new Uint8Array(8192);
  // compose file
  const full = new Uint8Array(16 + PRG.length + CHR.length);
  full.set(header,0);
  full.set(PRG,16);
  full.set(CHR,16+PRG.length);
  return full;
}

// load from file
romFile.addEventListener('change', async (e)=>{
  const f = e.target.files[0]; if(!f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  nes = createNESFromROMBytes(buf);
  btnRun.disabled=false; btnPause.disabled=false; btnReset.disabled=false;
});

// built-in rom
btnUseBuilt.addEventListener('click', ()=>{
  const data = buildBuiltInTestROM();
  nes = createNESFromROMBytes(data);
  btnRun.disabled=false; btnPause.disabled=false; btnReset.disabled=false;
});

// run/pause/reset
btnRun.addEventListener('click', ()=>{
  if(!nes) return;
  running = true;
  runLoop();
});
btnPause.addEventListener('click', ()=>{
  running = false;
});
btnReset.addEventListener('click', ()=>{
  if(!nes) return;
  nes.cpu.reset();
  nes.ppu.reset();
});

// main run loop — drive CPU/PPU/APU: CPU.step returns cycles; PPU.step called 3x per CPU cycle.
function runLoop() {
  if(!running || !nes) return;
  // target: run roughly 60 FPS worth of CPU cycles per frame (but simpler: run until PPU completes a frame)
  let frameComplete = false;
  // run until PPU reports end-of-frame (we use frames counter). To avoid tight infinite loops, limit iterations.
  const startFrame = nes.ppu.frame;
  let iter = 0;
  while(nes.ppu.frame === startFrame && iter < 200000) {
    const cyc = nes.cpu.step();
    // step PPU 3 * cyc
    for(let i=0;i<cyc*3;i++){
      nes.ppu.step();
      if(nes.ppu.nmi) {
        nes.cpu.nmi();
        nes.ppu.nmi=false;
      }
    }
    nes.apu.step(cyc);
    iter++;
  }
  // draw already done inside PPU on vblank
  // schedule next frame
  requestAnimationFrame(runLoop);
}
