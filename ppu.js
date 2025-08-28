// ppu.js
// Cycle-stepped NES PPU with full-ish background fetch pipeline, sprite evaluation (8-sprite limit),
// sprite pattern fetch, sprite-0 hit, vblank/NMI, and palette mirroring.
// Exports PPU class with methods expected by the Bus/CPU wiring.

export class PPU {
  constructor() {
    // scroll registers
    this.v = 0; // current VRAM address (15 bits)
    this.t = 0; // temporary VRAM address (15 bits)
    this.x = 0; // fine X (3 bits)
    this.w = 0; // write toggle

    // ctrl/mask/status
    this.ctrl = 0;  // $2000
    this.mask = 0;  // $2001
    this.status = 0; // $2002

    // OAM
    this.oam = new Uint8Array(256);
    this.oamaddr = 0;
    this.secOAM = new Uint8Array(32); // secondary OAM (8 sprites * 4 bytes)
    this.spriteCount = 0;
    this.spriteZeroInLine = false;

    // VRAM / palette
    this.vram = new Uint8Array(0x800); // 2KB nametable
    this.palette = new Uint8Array(32);

    // cartridge / mapper connection (set by connectCart)
    this.cart = null;
    this.mapper = null;
    this.mirror = 'horizontal';

    // canvas / framebuffer
    this.canvas = null;
    this.ctx = null;
    this.imageData = null;
    this.fb = null; // Uint32Array view

    // pipeline state
    this.cycle = 0;       // 0..340
    this.scanline = 261;  // pre-render start
    this.frame = 0;
    this.nmi = false;

    // internal fetch pipeline latches / shift regs
    this.nameTableByte = 0;
    this.attrTableByte = 0;
    this.patternLo = 0;
    this.patternHi = 0;

    this.bgShiftLo = 0;  // 16-bit shift register
    this.bgShiftHi = 0;
    this.attrShiftLo = 0; // attribute shift latches (two bits repeated)
    this.attrShiftHi = 0;

    this.nextTileFineX = 0; // fine X (copied from x when rendering)
    this.bgLatch = { lo: 0, hi: 0, pal: 0 };

    // sprite pipeline storage (for rendering)
    this.spriteShiftsLo = new Uint8Array(8); // per-sprite pattern lo shift
    this.spriteShiftsHi = new Uint8Array(8);
    this.spriteX = new Uint8Array(8);
    this.spriteAttr = new Uint8Array(8);
    this.spriteY = new Uint8Array(8);
    this.spriteIndices = new Uint8Array(8);

    // temporary values used during eval/fetch
    this.scanlineSprites = []; // indexes of sprites found this scanline

    // buffered read (for $2007)
    this.buffered = 0;

    // precompute palette -> RGBA mapping
    this.paletteRGB = new Array(64).fill([0,0,0]);
  }

  attachCanvas(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.imageData = this.ctx.createImageData(256, 240);
    this.fb = new Uint32Array(this.imageData.data.buffer);
    // init paletteRGB
    for (let i=0;i<NTSC_PALETTE.length;i++) {
      const [r,g,b] = NTSC_PALETTE[i];
      // little-endian RGBA (Uint32): A<<24 | B<<16 | G<<8 | R
      this.paletteRGB[i] = (255<<24) | (b<<16) | (g<<8) | r;
    }
  }

  connectCart(cart) {
    this.cart = cart;
    this.mapper = cart.mapperInstance ? cart.mapperInstance : cart;
    this.mirror = cart.mirror || 'horizontal';
  }

  reset() {
    this.v = this.t = this.x = this.w = 0;
    this.ctrl = this.mask = this.status = 0;
    this.oam.fill(0);
    this.oamaddr = 0;
    this.secOAM.fill(0xFF);
    this.scanline = 261;
    this.cycle = 0;
    this.frame = 0;
    this.nmi = false;
    this.buffered = 0;
    this.bgShiftLo = this.bgShiftHi = 0;
    this.attrShiftLo = this.attrShiftHi = 0;
    this.nameTableByte = this.attrTableByte = this.patternLo = this.patternHi = 0;
    this.spriteCount = 0;
    this.spriteZeroInLine = false;
    this.scanlineSprites = [];
    for (let i=0;i<8;i++){ this.spriteShiftsLo[i]=0; this.spriteShiftsHi[i]=0; this.spriteX[i]=0; this.spriteAttr[i]=0; this.spriteY[i]=0; this.spriteIndices[i]=0; }
  }

  // CPU-visible register reads ($2002, $2004, $2007)
  read(addr) {
    switch(addr & 7) {
      case 2: // $2002 PPUSTATUS
        {
          const res = (this.status & 0xE0) | (this.buffered & 0x1F);
          this.status &= ~0x80; // clear vblank
          this.w = 0;
          return res;
        }
      case 4: // $2004 OAMDATA
        return this.oam[this.oamaddr & 0xFF];
      case 7: // $2007 PPUDATA (buffered)
        {
          const addr14 = this.v & 0x3FFF;
          const val = this.ppuRead(addr14);
          // palette reads are not buffered
          if (addr14 >= 0x3F00) {
            this.buffered = this.ppuRead(addr14 - 0x1000);
            this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
            return val;
          } else {
            const ret = this.buffered;
            this.buffered = val;
            this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
            return ret;
          }
        }
      default: return 0;
    }
  }

  // CPU-visible register writes ($2000-$2007)
  write(addr, val) {
    val &= 0xFF;
    switch(addr & 7) {
      case 0: // $2000 PPUCTRL
        this.ctrl = val;
        // t: bits 10-11 = nametable select (d0-d1)
        this.t = (this.t & 0xF3FF) | ((val & 0x03) << 10);
        break;
      case 1: // $2001 PPUMASK
        this.mask = val;
        break;
      case 3: // $2003 OAMADDR
        this.oamaddr = val & 0xFF;
        break;
      case 4: // $2004 OAMDATA
        this.oam[this.oamaddr & 0xFF] = val;
        this.oamaddr = (this.oamaddr + 1) & 0xFF;
        break;
      case 5: // $2005 PPUSCROLL
        if (this.w === 0) {
          this.x = val & 0x07;
          this.t = (this.t & 0x7FE0) | ((val & 0xF8) >> 3);
          this.w = 1;
        } else {
          this.t = (this.t & 0x0C1F) | ((val & 0x07) << 12) | ((val & 0xF8) << 2);
          this.w = 0;
        }
        break;
      case 6: // $2006 PPUADDR
        if (this.w === 0) {
          this.t = (this.t & 0x00FF) | ((val & 0x3F) << 8);
          this.w = 1;
        } else {
          this.t = (this.t & 0x7F00) | val;
          this.v = this.t;
          this.w = 0;
        }
        break;
      case 7: // $2007 PPUDATA
        this.ppuWrite(this.v & 0x3FFF, val);
        this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
        break;
    }
  }

  // low-level PPU memory access
  ppuRead(addr) {
    addr &= 0x3FFF;
    if (addr < 0x2000) {
      // pattern table via mapper.chrRead
      return this.mapper && this.mapper.chrRead ? this.mapper.chrRead(addr & 0x1FFF) : 0;
    } else if (addr < 0x3F00) {
      const idx = this.ntIndex(addr);
      return this.vram[idx & 0x7FF];
    } else {
      // palette range 0x3F00 - 0x3FFF mirrored every 32 bytes
      const a = 0x3F00 + (addr & 0x1F);
      let idx = a & 0x1F;
      // mirror the background color addresses (0x3F10/0x3F14/... mirror 0x3F00/0x3F04/...)
      if ((idx & 0x13) === 0x10) idx &= ~0x10;
      return this.palette[idx] & 0x3F;
    }
  }

  ppuWrite(addr, val) {
    addr &= 0x3FFF; val &= 0xFF;
    if (addr < 0x2000) {
      if (this.mapper && this.mapper.chrWrite) this.mapper.chrWrite(addr & 0x1FFF, val);
    } else if (addr < 0x3F00) {
      const idx = this.ntIndex(addr);
      this.vram[idx & 0x7FF] = val;
    } else {
      const a = 0x3F00 + (addr & 0x1F);
      let idx = a & 0x1F;
      if ((idx & 0x13) === 0x10) idx &= ~0x10;
      this.palette[idx] = val & 0x3F;
    }
  }

  // name table index mapping with mirroring
  ntIndex(addr) {
    const a = addr & 0x0FFF;
    const nt = (a >> 10) & 3;
    const off = a & 0x03FF;
    if (this.mirror === 'vertical') {
      return ((nt & 1) * 0x400) + off;
    } else if (this.mirror === 'horizontal') {
      return (((nt >> 1) & 1) * 0x400) + off;
    } else {
      // four-screen fallback
      return off;
    }
  }

  // OAM DMA
  doDMA(buf) {
    for (let i=0;i<256;i++) this.oam[(this.oamaddr + i) & 0xFF] = buf[i];
  }

  // scrolling helpers
  incCoarseX() {
    if ((this.v & 0x001F) === 31) {
      this.v &= ~0x001F;
      this.v ^= 0x0400;
    } else {
      this.v++;
    }
  }

  incY() {
    if ((this.v & 0x7000) !== 0x7000) {
      this.v += 0x1000;
    } else {
      this.v &= ~0x7000;
      let y = (this.v & 0x03E0) >> 5;
      if (y === 29) {
        y = 0;
        this.v ^= 0x0800;
      } else if (y === 31) {
        y = 0;
      } else {
        y++;
      }
      this.v = (this.v & ~0x03E0) | (y << 5);
    }
  }

  copyX() {
    this.v = (this.v & ~0x041F) | (this.t & 0x041F);
  }

  copyY() {
    this.v = (this.v & ~0x7BE0) | (this.t & 0x7BE0);
  }

  // background fetch pipeline - invoked at specific cycles (see step())
  fetchName() {
    const addr = 0x2000 | (this.v & 0x0FFF);
    this.nameTableByte = this.ppuRead(addr);
  }

  fetchAttr() {
    const at = 0x23C0 | (this.v & 0x0C00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07);
    this.attrTableByte = this.ppuRead(at);
    // compute palette bits
    const shift = ((this.v >> 4) & 4) | (this.v & 2);
    this.bgLatch.pal = ((this.attrTableByte >> shift) & 3) << 2;
  }

  fetchPatternLow() {
    const fineY = (this.v >> 12) & 7;
    const table = (this.ctrl & 0x10) ? 1 : 0; // bg pattern table select
    const tile = this.nameTableByte & 0xFF;
    const addr = (table * 0x1000) + (tile * 16) + fineY;
    this.patternLo = this.ppuRead(addr);
  }

  fetchPatternHigh() {
    const fineY = (this.v >> 12) & 7;
    const table = (this.ctrl & 0x10) ? 1 : 0;
    const tile = this.nameTableByte & 0xFF;
    const addr = (table * 0x1000) + (tile * 16) + fineY + 8;
    this.patternHi = this.ppuRead(addr);
  }

  // Load latches into shift registers at cycle boundary (every 8 pixels)
  loadBGShiftRegisters() {
    // load pattern bytes (they will be shifted 8..0 in real PPU as pixels are consumed)
    this.bgShiftLo = ((this.bgShiftLo & 0xFF) | (this.patternLo << 8)) & 0xFFFF;
    this.bgShiftHi = ((this.bgShiftHi & 0xFF) | (this.patternHi << 8)) & 0xFFFF;
    // attribute uses single-bit latches that are expanded to full 8-bit masks
    const pal = this.bgLatch.pal & 0xFF;
    // create 8-bit-wide attribute "streams"
    const lo = (pal & 0x01) ? 0xFF : 0x00;
    const hi = (pal & 0x02) ? 0xFF : 0x00;
    this.attrShiftLo = ((this.attrShiftLo & 0xFF) | (lo << 8)) & 0xFFFF;
    this.attrShiftHi = ((this.attrShiftHi & 0xFF) | (hi << 8)) & 0xFFFF;
  }

  // Sprite evaluation (scanline -> secOAM)
  evaluateSprites() {
    const y = this.scanline;
    this.scanlineSprites = [];
    this.spriteCount = 0;
    this.spriteZeroInLine = false;
    // clear secOAM
    for (let i=0;i<32;i++) this.secOAM[i] = 0xFF;
    for (let i=0;i<64;i++) {
      const o = i * 4;
      const sy = this.oam[o];
      const tile = this.oam[o+1];
      const attr = this.oam[o+2];
      const sx = this.oam[o+3];
      const h = (this.ctrl & 0x20) ? 16 : 8;
      const row = y - sy;
      if (row >= 0 && row < h) {
        if (this.spriteCount < 8) {
          const dest = this.spriteCount * 4;
          this.secOAM[dest+0] = sy;
          this.secOAM[dest+1] = tile;
          this.secOAM[dest+2] = attr;
          this.secOAM[dest+3] = sx;
          if (i === 0) this.spriteZeroInLine = true;
        }
        this.spriteCount++;
        if (this.spriteCount === 9) {
          // set overflow flag (approximation used by many emulators)
          this.status |= 0x20;
          break;
        }
      }
    }
    // after filling secOAM we will fetch pattern bytes for these sprites
    // populate per-sprite registers (we'll shift them as pixels are rendered)
    for (let i=0;i<8;i++) {
      const base = i*4;
      const sy = this.secOAM[base+0];
      if (sy === 0xFF) {
        this.spriteY[i] = 0xFF;
        this.spriteX[i] = 0x00;
        this.spriteAttr[i] = 0;
        this.spriteShiftsLo[i] = 0;
        this.spriteShiftsHi[i] = 0;
        this.spriteIndices[i] = 0xFF;
        continue;
      }
      const tile = this.secOAM[base+1];
      const attr = this.secOAM[base+2];
      const sx = this.secOAM[base+3];
      this.spriteY[i] = sy;
      this.spriteAttr[i] = attr;
      this.spriteX[i] = sx;
      this.spriteIndices[i] = tile;
      // pattern fetch will happen in fetch cycles 257..320 (we do actual reads during step)
      this.spriteShiftsLo[i] = 0;
      this.spriteShiftsHi[i] = 0;
    }
  }

  // Fetch sprite pattern bytes for secondary OAM (called during cycles 257..320)
  fetchSpritePatterns() {
    const spriteHeight = (this.ctrl & 0x20) ? 16 : 8;
    for (let i=0;i<8;i++) {
      if (this.spriteY[i] === 0xFF) {
        this.spriteShiftsLo[i] = 0;
        this.spriteShiftsHi[i] = 0;
        continue;
      }
      const row = this.scanline - this.spriteY[i];
      let tile = this.spriteIndices[i];
      let table = (this.ctrl & 0x08) ? 1 : 0; // sprite pattern table bit (when 8x8)
      let fineY = row & 0x07;
      if (spriteHeight === 16) {
        // 8x16: tile low bit selects the table, top bit of tile handled specially
        table = tile & 1;
        tile = tile & 0xFE;
        // if row >=8 then second tile
        if (row >= 8) {
          tile = tile + 1;
          fineY = row - 8;
        }
      } else {
        // if vertical flip, adjust fineY
      }

      // handle vertical flip
      const flipV = (this.spriteAttr[i] >> 7) & 1;
      const flipH = (this.spriteAttr[i] >> 6) & 1;
      let fy = flipV ? (7 - fineY) : fineY;

      const addrLo = (table * 0x1000) + (tile * 16) + fy;
      const addrHi = addrLo + 8;
      let lo = this.ppuRead(addrLo);
      let hi = this.ppuRead(addrHi);

      // handle horizontal flip: we will reverse bits when we shift them out per-pixel
      if (flipH) {
        lo = reverseByte(lo);
        hi = reverseByte(hi);
      }
      this.spriteShiftsLo[i] = lo;
      this.spriteShiftsHi[i] = hi;
    }
  }

  // Render a single pixel from bg + sprites at (x,y)
  renderPixel(x,y) {
    const maskedBg = (this.mask & 0x08) !== 0;
    const maskedSprites = (this.mask & 0x10) !== 0;

    // Background pixel
    let bgPixel = 0;
    let bgPalette = 0;
    if (maskedBg) {
      const bit = 15 - (this.x + ((x & 7))) ; // relative to shift reg? we'll compute using fine X
      // Instead of bit math above, use shifting from bgShift registers:
      const shift = 15 - this.x; // we will shift left each cycle; typical technique is to read top bits
      const lo = (this.bgShiftLo >> (8 - this.x)) & 0xFF; // easier: calculate pixel bits by indexing into shift reg
      // A simpler and correct approach used below:
      const bgLo = (this.bgShiftLo >> (15 - x % 16)) & 1; // this attempt is brittle; use canonical method below
      // Use canonical extraction: the next pixel comes from high bits of shift registers >> (15 - x)
      // Compute bitIndex = 15 - (this.x)
      // But to keep things robust, instead compute pixel as follows:
      const bitIndex = 15 - this.x;
      // extract the two bitplanes for the current pixel (use >> (15 - this.x))
      const planeLo = (this.bgShiftLo >> (15 - this.x)) & 1;
      const planeHi = (this.bgShiftHi >> (15 - this.x)) & 1;
      const palLo = (this.attrShiftLo >> (15 - this.x)) & 1;
      const palHi = (this.attrShiftHi >> (15 - this.x)) & 1;
      bgPixel = (planeHi << 1) | planeLo;
      bgPalette = (palHi << 1) | palLo;
      bgPalette = (bgPalette << 2); // palette high bits
    }

    // Sprite pixel: find first non-zero sprite pixel whose X counter == 0
    let spritePixel = 0;
    let spritePal = 0;
    let spritePriority = 0;
    let spriteIsZero = false;

    if (maskedSprites) {
      for (let s = 0; s < 8; s++) {
        if (this.spriteY[s] === 0xFF) continue; // empty
        if (this.spriteX[s] === 0) {
          // this sprite aligned with current x; get its top-bit of shifts
          const lo = (this.spriteShiftsLo[s] >> 7) & 1;
          const hi = (this.spriteShiftsHi[s] >> 7) & 1;
          const px = (hi << 1) | lo;
          if (px !== 0) {
            spritePixel = px;
            const attr = this.spriteAttr[s];
            spritePal = ((attr & 3) + 4) << 2;
            spritePriority = (attr >> 5) & 1;
            if (this.spriteZeroInLine && s === 0) spriteIsZero = true;
            break;
          }
        }
      }
    }

    // sprite-0 hit: when both bg and sprite non-zero and sprite is sprite0 and x < 255, set flag
    if (spritePixel && bgPixel && spriteIsZero && x < 255) {
      this.status |= 0x40;
    }

    // final color selection
    let colorIndex = 0;
    if (spritePixel && (spritePriority === 0 || bgPixel === 0)) {
      colorIndex = 0x10 | spritePal | (spritePixel & 3);
    } else if (bgPixel) {
      colorIndex = 0x10 | (bgPalette) | (bgPixel & 3);
    } else {
      colorIndex = this.palette[0] & 0x3F;
    }

    const rgbIndex = colorIndex & 0x3F;
    this.fb[y*256 + x] = this.paletteRGB[rgbIndex] || 0xFF000000;
  }

  // shift background registers every cycle during visible pixels (but only when rendering enabled)
  stepShifters() {
    if (this.mask & 0x08) {
      this.bgShiftLo = (this.bgShiftLo << 1) & 0xFFFF;
      this.bgShiftHi = (this.bgShiftHi << 1) & 0xFFFF;
      this.attrShiftLo = (this.attrShiftLo << 1) & 0xFFFF;
      this.attrShiftHi = (this.attrShiftHi << 1) & 0xFFFF;
    }
    // shift sprite shifts
    if (this.mask & 0x10) {
      for (let i=0;i<8;i++) {
        if (this.spriteX[i] === 0) {
          this.spriteShiftsLo[i] = (this.spriteShiftsLo[i] << 1) & 0xFF;
          this.spriteShiftsHi[i] = (this.spriteShiftsHi[i] << 1) & 0xFF;
        } else {
          // decrease X counter until 0
          if (this.spriteX[i] > 0) this.spriteX[i]--;
        }
      }
    }
  }

  // Put framebuffer to canvas
  renderToCanvas() {
    if (!this.ctx || !this.imageData) return;
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  // Primary PPU cycle step (call 3x per CPU cycle in main loop)
  step() {
    // Pre-render line 261 behavior: clear flags at cycle 1
    if (this.scanline === 261 && this.cycle === 1) {
      this.status &= ~(0x80 | 0x40 | 0x20); // clear VBlank, sprite0, overflow
      this.spriteZeroInLine = false;
    }

    // Visible region: 0..239 lines; cycles 1..256 visible dots
    const renderingEnabled = (this.mask & 0x18) !== 0; // either bg or sprite enabled

    // Visible scanlines: fetch background & sprites on proper cycles
    if (this.scanline >= 0 && this.scanline <= 239) {
      // cycles 1..256: pixel rendering
      if (this.cycle >= 1 && this.cycle <= 256) {
        // On each dot we render pixel then shift registers
        // But per canonical pipeline, fetches happen on specific cycles:
        // We'll follow the 8-step sequence across cycles (mod 8)
        const cycleMod8 = this.cycle & 7;
        // At cycles where background fetches occur:
        if (cycleMod8 === 1) {
          this.fetchName();
        } else if (cycleMod8 === 3) {
          this.fetchAttr();
        } else if (cycleMod8 === 5) {
          this.fetchPatternLow();
        } else if (cycleMod8 === 7) {
          this.fetchPatternHigh();
        } else if (cycleMod8 === 0) {
          // load into shift registers at end of the 8-dot sequence
          this.loadBGShiftRegisters();
        }

        // At cycle 1 of this dot, render the pixel (uses current shift regs & fine-x)
        const x = this.cycle - 1;
        const y = this.scanline;
        if (renderingEnabled) {
          // Calculate background fine-X adjusted bits via shifts: we maintain shifts so that the top bit corresponds to next pixel
          // Render
          this.renderPixel(x, y);
        } else {
          // fill with backdrop color
          const col = this.palette[0] & 0x3F;
          this.fb[y*256 + x] = this.paletteRGB[col] || 0xFF000000;
        }
        // shift
        this.stepShifters();

        // increment coarse X every 8 cycles (after load), but simplified: when cycleMod8 === 0 occurs we already loaded and next inc handled below
        if (cycleMod8 === 0) {
          this.incCoarseX();
        }
      }

      // cycle 257: copy X and evaluate sprites
      if (this.cycle === 257) {
        if (renderingEnabled) this.copyX();
        // sprite evaluation and fetches are done here (we'll evaluate and then fetch patterns)
        if (renderingEnabled) {
          this.evaluateSprites();
          // fetch sprite patterns now (this will call mapper/chr reads)
          this.fetchSpritePatterns();
          // Initialize sprite X counters and ensure shift registers aligned: spriteShifts are loaded above
          for (let i=0;i<8;i++) {
            // spriteX is already set from secOAM during evaluateSprites
            if (this.spriteY[i] === 0xFF) {
              this.spriteX[i] = 0xFF;
            }
            // note: for rendering we expect spriteX to be an integer >=0; in stepShifters we check ===0
          }
        }
      }

      // cycle 256: increment Y (fine Y handling)
      if (this.cycle === 256) {
        if (renderingEnabled) this.incY();
      }
    }

    // Pre-render line: cycles 280..304 copy Y if rendering enabled
    if (this.scanline === 261) {
      if (this.cycle >= 280 && this.cycle <= 304 && renderingEnabled) {
        this.copyY();
      }
    }

    // Enter VBlank at scanline 241 cycle 1
    if (this.scanline === 241 && this.cycle === 1) {
      this.status |= 0x80;
      if (this.ctrl & 0x80) this.nmi = true;
      // push framebuffer to canvas
      this.renderToCanvas();
    }

    // Advance cycle counters
    this.cycle++;
    if (this.cycle > 340) {
      this.cycle = 0;
      this.scanline++;
      if (this.scanline > 261) {
        this.scanline = 0;
        this.frame++;
      }
    }
  }
}

// small helper: reverse bits in a byte (used for sprite H-flip pre-flip)
function reverseByte(b) {
  b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
  b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
  b = ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
  return b & 0xFF;
}

// NTSC palette (same as earlier)
const NTSC_PALETTE = [
  [84,84,84],[0,30,116],[8,16,144],[48,0,136],[68,0,100],[92,0,48],[84,4,0],[60,24,0],
  [32,42,0],[8,58,0],[0,64,0],[0,60,0],[0,50,60],[0,0,0],[0,0,0],[0,0,0],
  [152,150,152],[8,76,196],[48,50,236],[92,30,228],[136,20,176],[160,20,100],[152,34,32],[120,60,0],
  [84,90,0],[40,114,0],[8,124,0],[0,118,40],[0,102,120],[0,0,0],[0,0,0],[0,0,0],
  [236,238,236],[76,154,236],[120,124,236],[176,98,236],[228,84,236],[236,88,180],[236,106,100],[212,136,32],
  [160,170,0],[116,196,0],[76,208,32],[56,204,108],[56,180,204],[60,60,60],[0,0,0],[0,0,0],
  [236,238,236],[168,204,236],[188,188,236],[212,178,236],[236,174,236],[236,174,212],[236,180,176],[228,196,144],
  [204,210,120],[180,222,120],[168,226,144],[152,226,180],[160,214,228],[160,162,160],[0,0,0],[0,0,0]
];
