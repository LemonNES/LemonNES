// ppu.js - NES PPU with DMA & CHR-ROM integration

class PPU {
    constructor(cpuMemory, canvasContext, chrROM, mirrorType = "horizontal") {
        this.cpuMemory = cpuMemory; // Reference to CPU memory for DMA
        this.ctx = canvasContext;
        this.chrROM = chrROM;       // CHR-ROM data from ROM
        this.screenWidth = 256;
        this.screenHeight = 240;

        // PPU registers
        this.ctrl = 0;
        this.mask = 0;
        this.status = 0;
        this.oamAddr = 0;
        this.scrollX = 0;
        this.scrollY = 0;
        this.addr = 0;
        this.data = 0;

        // VRAM & OAM
        this.vram = new Uint8Array(0x4000);  
        this.oam = new Uint8Array(256);

        // Framebuffer
        this.frameBuffer = this.ctx.createImageData(this.screenWidth, this.screenHeight);

        // Timing
        this.cycle = 0;
        this.scanline = 0;

        // Mirroring
        this.mirrorType = mirrorType;

        // NES palette (64 colors)
        this.palette = [ /* 64-color array */ ];

        // Scroll registers
        this.fineX = 0;
        this.writeToggle = 0;
        this.tempAddr = 0;
        this.vramAddr = 0;

        this.sprite0Hit = false;
    }

    // DMA transfer: copy 256 bytes from CPU memory page to OAM
    performDMA(page) {
        const base = page << 8;
        for(let i=0; i<256; i++){
            this.oam[i] = this.cpuMemory[base + i];
        }
    }

    readRegister(addr) {
        switch(addr) {
            case 0x2002:
                const value = this.status;
                this.status &= 0x7F; // clear VBlank
                this.writeToggle = 0;
                return value;
            case 0x2007:
                let data;
                const patternTableAddr = this.vramAddr & 0x1FFF;
                if(patternTableAddr < 0x2000) {
                    // Fetch from CHR-ROM
                    data = this.chrROM[patternTableAddr];
                } else {
                    data = this.vram[this.vramAddr & 0x3FFF];
                }
                this.vramAddr += (this.ctrl & 0x04) ? 32 : 1;
                return data;
            default: return 0;
        }
    }

    writeRegister(addr, value) {
        switch(addr) {
            case 0x2000: this.ctrl = value; break;
            case 0x2001: this.mask = value; break;
            case 0x2003: this.oamAddr = value; break;
            case 0x2004: this.oam[this.oamAddr++] = value; break;
            case 0x2005:
                if(this.writeToggle === 0){
                    this.fineX = value & 7;
                    this.tempAddr = (this.tempAddr & 0x7FE0) | (value >> 3);
                    this.writeToggle = 1;
                } else {
                    this.tempAddr = (this.tempAddr & 0x0C1F) | ((value & 0xF8) << 2) | ((value & 7) << 12);
                    this.writeToggle = 0;
                }
                break;
            case 0x2006:
                if(this.writeToggle === 0){
                    this.tempAddr = (this.tempAddr & 0x00FF) | (value << 8);
                    this.writeToggle = 1;
                } else {
                    this.tempAddr = (this.tempAddr & 0xFF00) | value;
                    this.vramAddr = this.tempAddr;
                    this.writeToggle = 0;
                }
                break;
            case 0x2007:
                this.vram[this.vramAddr & 0x3FFF] = value;
                this.vramAddr += (this.ctrl & 0x04) ? 32 : 1;
                break;
            case 0x4014: // DMA register
                this.performDMA(value);
                break;
        }
    }

    drawPixel(x, y, color) {
        if(x < 0 || x >= 256 || y < 0 || y >= 240) return;
        const idx = (y * this.screenWidth + x) * 4;
        this.frameBuffer.data[idx] = color[0];
        this.frameBuffer.data[idx + 1] = color[1];
        this.frameBuffer.data[idx + 2] = color[2];
        this.frameBuffer.data[idx + 3] = 255;
    }

    mirrorAddress(addr) {
        const mirrored = addr & 0x2FFF;
        const vramIndex = mirrored - 0x2000;
        const table = Math.floor(vramIndex / 0x400);
        if(this.mirrorType === "horizontal") {
            return (table & 1) * 0x400 + (vramIndex & 0x3FF);
        } else {
            return (table & 2 ? 0x400 : 0) + (vramIndex & 0x3FF);
        }
    }

    getAttributePalette(tileX, tileY) {
        const attrAddr = 0x23C0 + (Math.floor(tileY / 4) * 8) + Math.floor(tileX / 4);
        const attrByte = this.vram[this.mirrorAddress(attrAddr)];
        const shift = ((tileY % 4 >= 2 ? 4 : 0) + (tileX % 4 >= 2 ? 2 : 0));
        return (attrByte >> shift) & 0x03;
    }

    renderBackground() {
        for(let tileY=0; tileY<30; tileY++){
            for(let tileX=0; tileX<32; tileX++){
                const baseAddr = 0x2000 + tileY*32 + tileX;
                const mirroredAddr = this.mirrorAddress(baseAddr);
                const tileIndex = this.vram[mirroredAddr];
                const paletteHigh = this.getAttributePalette(tileX, tileY) << 2;
                const patternTable = (this.ctrl & 0x10) ? 0x1000 : 0x0000;

                for(let row=0; row<8; row++){
                    const low = this.chrROM[patternTable + tileIndex*16 + row];
                    const high = this.chrROM[patternTable + tileIndex*16 + row + 8];
                    for(let col=0; col<8; col++){
                        const bit0 = (low >> (7-col)) & 1;
                        const bit1 = (high >> (7-col)) & 1;
                        let colorIndex = (bit1 << 1) | bit0;
                        if(colorIndex === 0) continue;
                        colorIndex += paletteHigh + 1;
                        const color = this.palette[colorIndex];
                        const x = (tileX*8 + col - this.fineX) & 0xFF;
                        const y = (tileY*8 + row - (this.scrollY & 7)) & 0xFF;
                        this.drawPixel(x, y, color);
                    }
                }
            }
        }
    }

    renderSprites() {
        const spriteSize = (this.ctrl & 0x20) ? 16 : 8;
        this.sprite0Hit = false;

        for(let i=0; i<64; i++){
            const yPos = this.oam[i*4];
            const tileIndex = this.oam[i*4+1];
            const attr = this.oam[i*4+2];
            const xPos = this.oam[i*4+3];

            const paletteHigh = (attr & 0x03) << 2;
            const flipH = (attr & 0x40) !== 0;
            const flipV = (attr & 0x80) !== 0;
            const priority = (attr & 0x20) === 0;

            const patternTable = spriteSize === 16 ? (tileIndex & 1 ? 0x1000 : 0x0000) : ((this.ctrl & 0x08) ? 0x1000 : 0x0000);

            for(let row=0; row<spriteSize; row++){
                const rowIdx = flipV ? spriteSize - 1 - row : row;
                const low = this.chrROM[patternTable + tileIndex*16 + rowIdx];
                const high = this.chrROM[patternTable + tileIndex*16 + rowIdx + 8];

                for(let col=0; col<8; col++){
                    const colIdx = flipH ? 7-col : col;
                    const bit0 = (low >> (7-colIdx)) & 1;
                    const bit1 = (high >> (7-colIdx)) & 1;
                    let colorIndex = (bit1 << 1) | bit0;
                    if(colorIndex === 0) continue;

                    colorIndex += paletteHigh + 0x11;
                    const color = this.palette[colorIndex];
                    const px = xPos + col;
                    const py = yPos + row;

                    if(i === 0 && colorIndex !== 0 && this.frameBuffer.data[(py*256+px)*4+3] !== 0){
                        this.status |= 0x40;
                        this.sprite0Hit = true;
                    }

                    if(priority || this.frameBuffer.data[(py*256+px)*4+3] === 0){
                        this.drawPixel(px, py, color);
                    }
                }
            }
        }
    }

    renderFrame() {
        this.renderBackground();
        this.renderSprites();
        this.ctx.putImageData(this.frameBuffer, 0, 0);
    }

    step() {
        this.cycle++;
        if(this.cycle > 340){
            this.cycle = 0;
            this.scanline++;
            if(this.scanline === 241){
                this.status |= 0x80;
                this.renderFrame();
            }
            if(this.scanline >= 262){
                this.scanline = 0;
                this.status &= 0x7F;
            }
        }
    }
}

export default PPU;
