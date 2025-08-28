// memory.js
export class Bus {
  constructor(cpu, ppu, apu, controllers, cart) {
    this.cpu = cpu;
    this.ppu = ppu;
    this.apu = apu;
    this.controllers = controllers;
    this.cart = cart;

    this.ram = new Uint8Array(0x800); // 2KB internal
  }

  cpuRead(addr) {
    addr &= 0xFFFF;
    // CPU reads
    if (addr < 0x2000) return this.ram[addr & 0x7FF];
    if (addr < 0x4000) return this.ppu.read(0x2000 + (addr & 7));
    if (addr === 0x4016) return this.controllers[0].read();
    if (addr === 0x4017) return this.controllers[1].read();
    if (addr === 0x4015) return this.apu.read ? this.apu.read(0x4015) : 0; // APU status
    if (addr >= 0x8000) return this.cart.prgRead ? this.cart.prgRead(addr) : this.cart.read(addr);
    if (addr >= 0x6000) return this.cart.sram ? this.cart.sram[addr - 0x6000] : 0;
    return 0;
  }

  cpuWrite(addr, val) {
    addr &= 0xFFFF; val &= 0xFF;
    if (addr < 0x2000) { this.ram[addr & 0x7FF] = val; return; }
    if (addr < 0x4000) { this.ppu.write(0x2000 + (addr & 7), val); return; }
    if (addr === 0x4014) {
      // OAM DMA - read 256 bytes from page and write to PPU OAM
      const page = val << 8;
      const buf = new Uint8Array(256);
      for (let i=0;i<256;i++) buf[i] = this.cpuRead(page + i);
      if (this.ppu.doDMA) this.ppu.doDMA(buf);
      // CPU is stalled in real hw; our CPU.step will be simple MVP (no stall).
      return;
    }
    if (addr === 0x4016) {
      this.controllers.forEach(c => c.write(val));
      return;
    }
    if (addr >= 0x4000 && addr <= 0x4017) {
      if (this.apu && this.apu.write) this.apu.write(addr, val);
      return;
    }
    if (addr >= 0x8000) {
      if (this.cart && this.cart.prgWrite) this.cart.prgWrite(addr, val);
      return;
    }
    if (addr >= 0x6000) {
      if (this.cart && this.cart.sram) this.cart.sram[addr-0x6000] = val;
      return;
    }
  }
}
