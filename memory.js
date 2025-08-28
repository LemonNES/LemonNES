// memory.js
// NES CPU Memory Map Implementation
// 0x0000 - 0xFFFF

export default class Memory {
    constructor(cartridge, ppu, apu, controllers) {
        this.ram = new Uint8Array(0x0800); // 2KB internal RAM
        this.cartridge = cartridge;        // PRG-ROM / Mapper
        this.ppu = ppu;                    // Picture Processing Unit
        this.apu = apu;                    // Audio Processing Unit
        this.controllers = controllers;    // Input

        this.reset();
    }

    reset() {
        this.ram.fill(0);
    }

    // Read 8-bit value from memory
    read(addr) {
        addr &= 0xFFFF; // wrap to 16-bit space

        if (addr < 0x2000) {
            // RAM + mirrors
            return this.ram[addr % 0x0800];
        }
        else if (addr < 0x4000) {
            // PPU registers (mirrored every 8 bytes)
            return this.ppu.readRegister(addr % 8);
        }
        else if (addr === 0x4016 || addr === 0x4017) {
            // Controller input
            return this.controllers.read(addr);
        }
        else if (addr >= 0x4000 && addr < 0x4020) {
            // APU and I/O registers
            return this.apu.readRegister(addr);
        }
        else if (addr >= 0x4020) {
            // Cartridge space: PRG-ROM, PRG-RAM, mapper-controlled
            return this.cartridge.cpuRead(addr);
        }

        return 0; // open bus (default)
    }

    // Write 8-bit value to memory
    write(addr, value) {
        addr &= 0xFFFF;
        value &= 0xFF;

        if (addr < 0x2000) {
            // RAM + mirrors
            this.ram[addr % 0x0800] = value;
        }
        else if (addr < 0x4000) {
            // PPU registers (mirrored)
            this.ppu.writeRegister(addr % 8, value);
        }
        else if (addr >= 0x4000 && addr < 0x4020) {
            if (addr === 0x4016 || addr === 0x4017) {
                // Controller strobe
                this.controllers.write(addr, value);
            } else {
                // APU and I/O
                this.apu.writeRegister(addr, value);
            }
        }
        else if (addr >= 0x4020) {
            // Cartridge / mapper
            this.cartridge.cpuWrite(addr, value);
        }
    }
}
