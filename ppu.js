// ppu.js
// Cycle-stepped NES PPU (visible background + sprites, sprite-0 hit, NMI at vblank).
// This is a reasonably accurate MVP — not every PPU timing edge-case, but
// good for many early games and homebrew.

export class PPU {
  constructor() {
    // Scroll / addressing registers
    this.v = 0;   // current VRAM address (15 bits)
    this.t = 0;   // temporary VRAM address (15 bits)
    this.x = 0;   // fine X scroll (3 bits)
    this.w = 0;   // write toggle (0/1)

    // Control / mask / status
    this.ctrl = 0;   // $2000
    this.mask = 0;   // $2001
    this.status = 0; // $2002

    // OAM
    this.oam = new Uint8Array(256);   // primary OAM
    this.secOAM = new Uint8Array(32); // secondary OAM copy for scanline (8 sprites * 4 bytes)
    this.oamaddr = 0;

    // Internal memory
    this.vram = new Uint8Array(0x800); // 2KB internal nametables
    this.palette = new Uint8Array(32); // palette RAM

    // Sprite state
    this.spriteCount = 0;
    this.spriteZeroInLine = false;
    this.spriteZeroHit = false;

    // PPU timing
    this.cycle = 0;     // 0-340
    this.scanline = 261; // pre-render line (261), visible 0-239, vblank 241-260
    this.frame = 0;
    this.nmi = false;   // set to true when CPU needs to run NMI

    // Cartridge/mapper link (set by connectCart)
    this.cart = null;
    this.mapper = null;
    this.mirror = 'horizontal';

    // Rendering target
    this.canvas = null;
    this.ctx = null;
    this.imageData = null;
    this.fb = null; // Uint32Array backing framebuffer (RGBA)
  }

  attachCanvas(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.imageData = this.ctx.createImageData(256, 240);
    this.fb = new Uint32Array(this.imageData.data.buffer);
  }

  connectCart(cart) {
    this.cart = cart;
    // mapper object must implement chrRead(addr) & chrWrite(addr,val)
    this.mapper = cart && cart.mapperInstance ? cart.mapperInstance : cart;
    // mirror string (horizontal/vertical/four)
    this.mirror = cart.mirror || 'horizontal';
  }

  reset() {
    this.v = this.t = this.x = this.w = 0;
    this.ctrl = this.mask = this.status = 0;
    this.oamaddr = 0;
    this.oam.fill(0);
    this.secOAM.fill(0xFF);
    this.vram.fill(0);
    this.palette.fill(0);
    this.cycle = 0;
    this.scanline = 261;
    this.frame = 0;
    this.nmi = false;
    this.spriteCount = 0;
    this.spriteZeroInLine = false;
    this.spriteZeroHit = false;
  }

  // CPU register interface ($2002, $2004, $2007; $2000/$2001 writes; $2005/$2006 writes)
  read(addr) {
    // CPU read at 0x2002 / 0x2004 / 0x2007 mapped to this method by Bus
    switch (addr & 7) {
      case 2: // $2002 PPUSTATUS
        {
          const res = (this.status & 0xE0) | (this.buffered & 0x1F);
          this.status &= ~0x80; // clear vblank
          this.w = 0;
          return res;
        }
      case 4: // $2004 OAMDATA
        return this.oam[this.oamaddr & 0xFF];
      case 7: // $2007 PPUDATA
        {
          // Read from VRAM bus with buffered read behavior
          const val = this.ppuRead(this.v & 0x3FFF);
          // If address is in palette range, return directly and update buffer differently
          if ((this.v & 0x3FFF) >= 0x3F00) {
            // palette reads are not buffered
            this.buffered = this.ppuRead((this.v - 0x1000) & 0x3FFF); // keep buffer sane
            this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
            return val;
          } else {
            const ret = this.buffered;
            this.buffered = val;
            this.v = (this.v + ((this.ctrl & 0x04) ? 32 : 1)) & 0x7FFF;
            return ret;
          }
        }
      default:
        return 0;
    }
  }

  write(addr, val) {
    // CPU writes to PPU registers
    switch (addr & 7) {
      case 0: // $2000 PPUCTRL
        this.ctrl = val;
        // t: .....BA.. ........ = d: ......BA
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
          this.x = val & 7;
          this.t = (this.t & 0x7FE0) | (val >> 3);
          this.w = 1;
        } else {
          this.t = (this.t & 0x0C1F) | ((val & 7) << 12) | ((val & 0xF8) << 2);
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

  // OAM DMA (write 256 bytes starting at OAMADDR)
  doDMA(buf) {
    for (let i = 0; i < 256; i++) {
      this.oam[(this.oamaddr + i) & 0xFF] = buf[i];
    }
  }

  // low-level PPU memory access (pattern tables, nametables, palette)
  ppuRead(addr) {
    addr &= 0x3FFF;
    if (addr < 0x2000) {
      return this.mapper && this.mapper.chrRead ? this.mapper.chrRead(addr & 0x1FFF) : 0;
    } else if (addr < 0x3F00) {
      // nametable read with mirroring
      const idx = this.ntIndex(addr);
      return this.vram[idx];
    } else {
      // palette read (mirroring of some entries)
      const a = 0x3F00 + (addr & 0x1F);
      const idx = (a - 0x3F00) & 0x1F;
      // palette RAM index mirrors for addresses like 0x3F10 == 0x3F00
      const mirrorMap = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15, 16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31];
      const palIdx = idx & 0x1F;
      return this.palette[palIdx] & 0x3F;
    }
  }

  ppuWrite(addr, val) {
    addr &= 0x3FFF;
    val &= 0xFF;
    if (addr < 0x2000) {
      if (this.mapper && this.mapper.chrWrite) this.mapper.chrWrite(addr & 0x1FFF, val);
    } else if (addr < 0x3F00) {
      const idx = this.ntIndex(addr);
      this.vram[idx] = val;
    } else {
      const palIdx = (addr - 0x3F00) & 0x1F;
      // mirrors: writes to 0x3F10/0x3F14/... map to 0x3F00/...
      const mirror = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15, 16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31];
      this.palette[palIdx] = val & 0x3F;
    }
  }

  // translate 0x2000..0x2FFF nametable addr into vram index depending on mirroring
  ntIndex(addr) {
    const a = addr & 0x0FFF; // offset into name table space
    const nt = (a >> 10) & 3; // 0-3
    const off = a & 0x03FF;
    if (this.mirror === 'vertical') {
      // nt 0,2 -> first; 1,3 -> second
      return ((nt & 1) * 0x400) + off;
    } else if (this.mirror === 'horizontal') {
      // nt 0,1 -> first; 2,3 -> second
      return (((nt >> 1) & 1) * 0x400) + off;
    } else if (this.mirror === 'four') {
      // four-screen: direct mapping (we don't implement extra RAM here; fallback to first)
      return off;
    }
    return off;
  }

  // scrolling helpers (H/V increment behavior)
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

  // Background fetch helpers: fetch tile / attr / pattern bytes for current v
  bgFetchForX() {
    // This is a simplified per-8-dot fetch that returns pattern low/high and palette bits.
    const ntAddr = 0x2000 | (this.v & 0x0FFF);
    const atAddr = 0x23C0 | (this.v & 0x0C00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07);
    const fineY = (this.v >> 12) & 7;
    const tile = this.ppuRead(ntAddr);
    const attr = this.ppuRead(atAddr);
    const shift = (((this.v >> 4) & 4) | (this.v & 2));
    const pal = ((attr >> shift) & 3) << 2;
    const base = (this.ctrl & 0x10) ? 0x1000 : 0x0000;
    const addrLo = base + tile * 16 + fineY;
    const addrHi = addrLo + 8;
    const lo = this.ppuRead(addrLo);
    const hi = this.ppuRead(addrHi);
    return { lo, hi, pal };
  }

  // Evaluate sprites for current scanline (populates secOAM)
  evalSprites() {
    const y = this.scanline;
    this.spriteCount = 0;
    this.spriteZeroInLine = false;
    const spriteHeight = (this.ctrl & 0x20) ? 16 : 8;

    // initialize secOAM with 0xFF
    for (let i = 0; i < 32; i++) this.secOAM[i] = 0xFF;

    for (let i = 0; i < 64; i++) {
      const o = i * 4;
      const sy = this.oam[o];
      const tile = this.oam[o + 1];
      const attr = this.oam[o + 2];
      const sx = this.oam[o + 3];
      const row = y - sy;
      if (row >= 0 && row < spriteHeight) {
        if (this.spriteCount < 8) {
          if (i === 0) this.spriteZeroInLine = true;
          const base = this.spriteCount * 4;
          this.secOAM[base + 0] = sy;
          this.secOAM[base + 1] = tile;
          this.secOAM[base + 2] = attr;
          this.secOAM[base + 3] = sx;
        }
        this.spriteCount++;
        if (this.spriteCount === 9) {
          // set sprite overflow flag (note: hardware sets it differently in some cases,
          // but this is good-enough for MVP)
          this.status |= 0x20;
          break;
        }
      }
    }
  }

  // Render a single pixel using fetched BG info and sprite evaluation
  renderPixel(x, y, bgLatch) {
    // Background pixel extract
    let bgPixel = 0;
    let bgPal = 0;
    if (this.mask & 0x08) { // show background
      const bit = 7 - ((x + this.x) & 7);
      bgPixel = (((bgLatch.hi >> bit) & 1) << 1) | ((bgLatch.lo >> bit) & 1);
      if (bgPixel) bgPal = bgLatch.pal + bgPixel;
    }

    // Sprite pixel: test secOAM sprites in order (0..spriteCount-1)
    let spritePixel = 0;
    let spritePalette = 0;
    let spritePriority = 0;
    let sprite0 = false;

    if (this.mask & 0x10) { // show sprites
      for (let i = 0; i < Math.min(this.spriteCount, 8); i++) {
        const b = i * 4;
        const sy = this.secOAM[b + 0];
        const tile = this.secOAM[b + 1];
        const attr = this.secOAM[b + 2];
        const sx = this.secOAM[b + 3];
        const h = (this.ctrl & 0x20) ? 16 : 8;
        if (x < sx || x >= sx + 8) continue;
        const row = y - sy;
        if (row < 0 || row >= h) continue;

        const flipV = (attr >> 7) & 1;
        const flipH = (attr >> 6) & 1;
        const pal = ((attr & 3) + 4) << 2;
        const priority = (attr >> 5) & 1;
        if (this.spriteZeroInLine && i === 0) sprite0 = true;

        // compute fineY / base for sprite tile
        let fineY = row;
        if (flipV) fineY = (h - 1) - row;
        const base = (this.ctrl & 0x08) ? 0x1000 : 0x0000;
        let tileIndex = tile;
        if (h === 16) {
          // 8x16 tiles: bit0 of ctrl selects pattern table for each tile.
          // tileIndex & 1 selects table, tileIndex >> 1 selects tile number
          const table = tile & 1;
          tileIndex = (tile & 0xFE);
          // for 8x16, tile numbering is more involved; for MVP this approximates common carts.
        }
        const addrLo = base + tileIndex * 16 + fineY;
        const addrHi = addrLo + 8;
        const lo = this.ppuRead(addrLo);
        const hi = this.ppuRead(addrHi);

        const bitIndex = flipH ? (x - sx) : (7 - (x - sx));
        const spPx = (((hi >> bitIndex) & 1) << 1) | ((lo >> bitIndex) & 1);
        if (spPx) {
          spritePixel = spPx;
          spritePalette = pal;
          spritePriority = priority;
          break;
        }
      }
    }

    // Sprite 0 hit: if both non-zero and sprite is sprite0 and x < 255, set flag
    if (spritePixel && bgPixel && sprite0 && x < 255) {
      this.status |= 0x40;
    }

    // final pixel selection: sprite priority bit == 0 -> sprite in front unless bgPx==0
    let colorIndex = 0;
    if (spritePixel && (spritePriority === 0 || bgPixel === 0)) {
      colorIndex = 0x10 + spritePalette + spritePixel;
    } else if (bgPixel) {
      colorIndex = 0x10 + bgPal;
    } else {
      colorIndex = this.palette[0] & 0x3F; // backdrop color from palette[0]
    }

    const rgb = NTSC_PALETTE[colorIndex & 0x3F];
    const idx = y * 256 + x;
    this.fb[idx] = (255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | (rgb[0]); // little-endian RGBA
  }

  // Place framebuffer onto canvas
  renderToCanvas() {
    if (!this.ctx || !this.imageData) return;
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  // One PPU cycle step (call this 3x per CPU cycle)
  step() {
    // pre-render scanline 261: clear flags and prepare for frame
    if (this.scanline === 261) {
      if (this.cycle === 1) {
        this.status &= ~(0x80 | 0x40 | 0x20); // clear VBlank, sprite0hit, sprite overflow
        this.spriteZeroHit = false;
      }
      // during cycles 280-304, if rendering is enabled, copy vertical bits from t to v
      if (this.cycle >= 280 && this.cycle <= 304 && (this.mask & 0x18)) {
        this.copyY();
      }
    }

    // Visible scanlines
    if (this.scanline >= 0 && this.scanline <= 239) {
      if (this.cycle === 0) {
        // idle
      } else if (this.cycle === 1) {
        // sprite evaluation for this scanline
        if (this.mask & 0x10) this.evalSprites();
      }

      // Visible pixels: cycles 1..256 are visible pixels (1-based)
      if (this.cycle >= 1 && this.cycle <= 256) {
        // on every 8-dot boundary we fetch tile data; simplified: do a bgFetch per pixel
        // To balance correctness & simplicity, perform a bgFetch at cycles where we need it.
        if ((this.cycle & 7) === 1) {
          this.bgLatch = this.bgFetchForX();
        }
        const x = this.cycle - 1;
        const y = this.scanline;
        this.renderPixel(x, y, this.bgLatch);
        if ((this.cycle & 7) === 0) {
          this.incCoarseX();
        }
      }

      if (this.cycle === 256) {
        this.incY();
      }
      if (this.cycle === 257) {
        this.copyX();
      }
    }

    // End of visible area -> vblank start on scanline 241, cycle 1
    if (this.scanline === 241 && this.cycle === 1) {
      this.status |= 0x80; // set VBlank flag
      // when control bit 7 is set, NMI should fire
      if (this.ctrl & 0x80) {
        this.nmi = true;
      }
      // push framebuffer to canvas
      this.renderToCanvas();
    }

    // advance cycle/scanline/frame
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

// Approximate NTSC palette (same as many emulators; each entry is [R,G,B])
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

