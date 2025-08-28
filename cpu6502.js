// cpu6502.js
export class CPU6502 {
    constructor(memory) {
        this.memory = memory;

        // Registers
        this.A = 0x00;   // Accumulator
        this.X = 0x00;   // X index
        this.Y = 0x00;   // Y index
        this.SP = 0xFD;  // Stack pointer
        this.PC = this.read16(0xFFFC); // Reset vector
        this.status = 0x34; // Processor status

        // Internal
        this.cycles = 0;
        this.opcode = 0;
        this.addr = 0;
        this.fetched = 0;

        // Opcode table
        this.opcodes = this.buildOpcodeTable();
    }

    reset() {
        this.A = 0;
        this.X = 0;
        this.Y = 0;
        this.SP = 0xFD;
        this.status = 0x34;
        this.PC = this.read16(0xFFFC);
        this.cycles = 7; // Reset cycle cost
    }

    read(addr) {
        return this.memory.read(addr);
    }

    write(addr, value) {
        this.memory.write(addr, value);
    }

    read16(addr) {
        // 6502 little-endian
        const lo = this.read(addr);
        const hi = this.read(addr + 1);
        return (hi << 8) | lo;
    }

    fetch() {
        // For instructions that fetch a value
        if (this.opcode.addrMode !== 'IMP') {
            this.fetched = this.read(this.addr);
        }
    }

    step() {
        if (this.cycles === 0) {
            this.opcode = this.opcodes[this.read(this.PC)];
            this.PC++;
            this.addr = this.getAddress(this.opcode.addrMode);
            this.fetch();
            this.cycles = this.opcode.cycles;
            this.execute(this.opcode.mnemonic);
        }
        this.cycles--;
    }

    getAddress(addrMode) {
        switch (addrMode) {
            case 'IMM': return this.PC++;
            case 'ZP0': return this.read(this.PC++);
            case 'ZPX': return (this.read(this.PC++) + this.X) & 0xFF;
            case 'ZPY': return (this.read(this.PC++) + this.Y) & 0xFF;
            case 'ABS': {
                const lo = this.read(this.PC++);
                const hi = this.read(this.PC++);
                return (hi << 8) | lo;
            }
            case 'ABX': {
                const lo = this.read(this.PC++);
                const hi = this.read(this.PC++);
                return ((hi << 8) | lo) + this.X;
            }
            case 'ABY': {
                const lo = this.read(this.PC++);
                const hi = this.read(this.PC++);
                return ((hi << 8) | lo) + this.Y;
            }
            case 'IND': {
                const ptr = this.read16(this.PC);
                // 6502 page bug
                const lo = this.read(ptr);
                const hi = this.read((ptr & 0xFF00) | ((ptr + 1) & 0xFF));
                this.PC += 2;
                return (hi << 8) | lo;
            }
            case 'REL': return this.PC + this.read(this.PC++);
            case 'IMP': return 0; // implied
            default: return 0;
        }
    }

    execute(mnemonic) {
        switch (mnemonic) {
            case 'LDA': this.A = this.fetched; this.setZN(this.A); break;
            case 'LDX': this.X = this.fetched; this.setZN(this.X); break;
            case 'LDY': this.Y = this.fetched; this.setZN(this.Y); break;
            case 'STA': this.write(this.addr, this.A); break;
            case 'STX': this.write(this.addr, this.X); break;
            case 'STY': this.write(this.addr, this.Y); break;
            case 'TAX': this.X = this.A; this.setZN(this.X); break;
            case 'TAY': this.Y = this.A; this.setZN(this.Y); break;
            case 'TXA': this.A = this.X; this.setZN(this.A); break;
            case 'TYA': this.A = this.Y; this.setZN(this.A); break;
            case 'INX': this.X = (this.X + 1) & 0xFF; this.setZN(this.X); break;
            case 'INY': this.Y = (this.Y + 1) & 0xFF; this.setZN(this.Y); break;
            case 'DEX': this.X = (this.X - 1) & 0xFF; this.setZN(this.X); break;
            case 'DEY': this.Y = (this.Y - 1) & 0xFF; this.setZN(this.Y); break;
            case 'NOP': break;
            default: console.log('Unimplemented opcode:', mnemonic); break;
        }
    }

    setZN(value) {
        this.status = (this.status & 0x7D) | (value === 0 ? 0x02 : 0) | (value & 0x80);
    }

    buildOpcodeTable() {
        // Only implement a minimal subset for testing
        return {
            0xA9: { mnemonic: 'LDA', addrMode: 'IMM', cycles: 2 },
            0xA2: { mnemonic: 'LDX', addrMode: 'IMM', cycles: 2 },
            0xA0: { mnemonic: 'LDY', addrMode: 'IMM', cycles: 2 },
            0xAA: { mnemonic: 'TAX', addrMode: 'IMP', cycles: 2 },
            0xE8: { mnemonic: 'INX', addrMode: 'IMP', cycles: 2 },
            0x00: { mnemonic: 'NOP', addrMode: 'IMP', cycles: 2 },
            // Add more opcodes as needed
        };
    }
}

export class CPU6502 {
  constructor() {
    this.bus = null;
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xFD;
    this.p = 0x24;
    this.pc = 0;
    this.cycles = 0;
    this.stall = 0;

    this.addrMode = null;
    this.pageCross = 0;

    this.buildOpcodes();
  }

  connectBus(bus) {
    this.bus = bus;
  }

  read(addr) {
    return this.bus.cpuRead(addr & 0xFFFF);
  }

  write(addr, val) {
    this.bus.cpuWrite(addr & 0xFFFF, val & 0xFF);
  }

  push(v) {
    this.write(0x100 + this.sp, v & 0xFF);
    this.sp = (this.sp - 1) & 0xFF;
  }

  pop() {
    this.sp = (this.sp + 1) & 0xFF;
    return this.read(0x100 + this.sp);
  }

  getFlag(bit) { return (this.p >> bit) & 1; }
  setFlag(bit, val) {
    if (val) this.p |= (1 << bit);
    else this.p &= ~(1 << bit);
  }
  // flag helpers for naming
  getC(){ return this.getFlag(0); } setC(v){ this.setFlag(0, v);}
  getZ(){ return this.getFlag(1); } setZ(v){ this.setFlag(1, v);}
  getI(){ return this.getFlag(2); } setI(v){ this.setFlag(2, v);}
  getD(){ return this.getFlag(3); } setD(v){ this.setFlag(3, v);}
  getB(){ return this.getFlag(4); } setB(v){ this.setFlag(4, v);}
  getU(){ return this.getFlag(5); } setU(v){ this.setFlag(5, v);}
  getV(){ return this.getFlag(6); } setV(v){ this.setFlag(6, v);}
  getN(){ return this.getFlag(7); } setN(v){ this.setFlag(7, v);}

  reset() {
    this.a=0; this.x=0; this.y=0; this.sp=0xFD; this.p=0x24;
    const lo = this.read(0xFFFC), hi = this.read(0xFFFD);
    this.pc = lo | (hi<<8);
    this.cycles = 7;
    this.stall = 0;
  }

  nmi() {
    // push PC & P, set I
    this.push((this.pc>>8)&0xFF);
    this.push(this.pc&0xFF);
    this.setB(0); this.setU(1); this.setI(1);
    this.push(this.p);
    const lo = this.read(0xFFFA), hi = this.read(0xFFFB);
    this.pc = lo | (hi<<8);
    this.cycles += 7;
  }

  irq() {
    if (this.getI()) return;
    this.push((this.pc>>8)&0xFF);
    this.push(this.pc&0xFF);
    this.setB(0); this.setU(1); this.setI(1);
    this.push(this.p);
    const lo = this.read(0xFFFE), hi = this.read(0xFFFF);
    this.pc = lo | (hi<<8);
    this.cycles += 7;
  }

  step() {
    if (this.stall > 0) { this.stall--; this.cycles++; return 1; }
    const op = this.read(this.pc++);
    const entry = this.OPCODES[op];
    if (!entry) {
      // treat unknown opcode as NOP (1 cycle) to avoid lock
      return 1;
    }
    this.addrMode = entry.mode;
    this.pageCross = 0;
    const addr = this.fetchAddr(this.addrMode);
    const cyclesBefore = this.cycles;
    this.execute(entry.ins, addr);
    const c = entry.cy + this.pageCross;
    this.cycles += c;
    return this.cycles - cyclesBefore;
  }

  // addressing modes
  fetchAddr(mode) {
    const zp = ()=> this.read(this.pc++);
    const imm = ()=> this.pc++;
    const abs = ()=> { const lo = this.read(this.pc++); const hi = this.read(this.pc++); return lo | (hi<<8); };
    const ind = ()=> { const ptr = abs(); const lo = this.read(ptr); const hi = this.read((ptr & 0xFF00) | ((ptr+1)&0xFF)); return lo | (hi<<8); };
    const zpX = ()=> ( (zp() + this.x) & 0xFF);
    const zpY = ()=> ( (zp() + this.y) & 0xFF);
    const absX = ()=> { const a = abs(); const res = (a + this.x) & 0xFFFF; if ((a ^ res) & 0xFF00) this.pageCross = 1; return res; };
    const absY = ()=> { const a = abs(); const res = (a + this.y) & 0xFFFF; if ((a ^ res) & 0xFF00) this.pageCross = 1; return res; };
    const indX = ()=> { const t = (this.read(this.pc++) + this.x) & 0xFF; const lo = this.read(t); const hi = this.read((t+1)&0xFF); return lo | (hi<<8); };
    const indY = ()=> { const t = this.read(this.pc++); const lo = this.read(t); const hi = this.read((t+1)&0xFF); const a = lo | (hi<<8); const res = (a + this.y) & 0xFFFF; if ((a ^ res) & 0xFF00) this.pageCross = 1; return res; };
    const rel = ()=> { const off = this.read(this.pc++); return (off < 0x80) ? (this.pc + off) : (this.pc + off - 0x100); };

    switch(mode) {
      case 'IMP': return null;
      case 'IMM': return imm();
      case 'ZP0': return zp();
      case 'ZPX': return zpX();
      case 'ZPY': return zpY();
      case 'ABS': return abs();
      case 'ABX': return absX();
      case 'ABY': return absY();
      case 'IZX': return indX();
      case 'IZY': return indY();
      case 'IND': return ind();
      case 'REL': return rel();
      default: return null;
    }
  }

  setZN(v) {
    this.setZ((v & 0xFF) === 0);
    this.setN((v & 0x80) !== 0);
  }

  execute(ins, addr) {
    const rd = (a) => (typeof a === 'number' ? this.read(a) : this.read(a));
    const wr = (a, v) => this.write(a, v & 0xFF);

    const ADC = (v) => {
      const t = this.a + v + this.getC();
      this.setC(t > 0xFF);
      this.setV((~(this.a ^ v) & (this.a ^ t) & 0x80) !== 0);
      this.a = t & 0xFF;
      this.setZN(this.a);
    };
    const SBC = (v) => { ADC((v ^ 0xFF) & 0xFF); };

    const CMP = (r, v) => {
      const t = r - v;
      this.setC(r >= v);
      this.setZN(t & 0xFF);
    };

    const BIT = (v) => {
      this.setZ((this.a & v) === 0);
      this.setV((v & 0x40) !== 0);
      this.setN((v & 0x80) !== 0);
    };

    switch(ins) {
      case 'BRK': {
        this.pc++;
        this.push((this.pc>>8)&0xFF); this.push(this.pc&0xFF);
        this.setB(1); this.setU(1); this.setI(1);
        this.push(this.p);
        const lo = this.read(0xFFFE), hi = this.read(0xFFFF);
        this.pc = lo | (hi<<8);
        break;
      }
      case 'NOP': break;
      case 'LDA': {
        this.a = (typeof addr === 'number' && this.addrMode==='IMM') ? this.read(addr) : this.read(addr);
        this.setZN(this.a);
      } break;
      case 'LDX': { this.x = this.read(addr); this.setZN(this.x); } break;
      case 'LDY': { this.y = this.read(addr); this.setZN(this.y); } break;
      case 'STA': wr(addr, this.a); break;
      case 'STX': wr(addr, this.x); break;
      case 'STY': wr(addr, this.y); break;
      case 'TAX': this.x = this.a; this.setZN(this.x); break;
      case 'TAY': this.y = this.a; this.setZN(this.y); break;
      case 'TXA': this.a = this.x; this.setZN(this.a); break;
      case 'TYA': this.a = this.y; this.setZN(this.a); break;
      case 'TSX': this.x = this.sp; this.setZN(this.x); break;
      case 'TXS': this.sp = this.x; break;
      case 'PHA': this.push(this.a); break;
      case 'PHP': this.push(this.p | 0x10); break;
      case 'PLA': this.a = this.pop(); this.setZN(this.a); break;
      case 'PLP': this.p = (this.pop() & 0xEF) | 0x20; break;
      case 'AND': this.a &= this.read(addr); this.setZN(this.a); break;
      case 'ORA': this.a |= this.read(addr); this.setZN(this.a); break;
      case 'EOR': this.a ^= this.read(addr); this.setZN(this.a); break;
      case 'ADC': ADC(this.read(addr)); break;
      case 'SBC': SBC(this.read(addr)); break;
      case 'CMP': CMP(this.a, this.read(addr)); break;
      case 'CPX': CMP(this.x, this.read(addr)); break;
      case 'CPY': CMP(this.y, this.read(addr)); break;
      case 'INC': { const v = (this.read(addr) + 1) & 0xFF; wr(addr, v); this.setZN(v); } break;
      case 'INX': this.x = (this.x + 1) & 0xFF; this.setZN(this.x); break;
      case 'INY': this.y = (this.y + 1) & 0xFF; this.setZN(this.y); break;
      case 'DEC': { const v = (this.read(addr) - 1) & 0xFF; wr(addr, v); this.setZN(v); } break;
      case 'DEX': this.x = (this.x - 1) & 0xFF; this.setZN(this.x); break;
      case 'DEY': this.y = (this.y - 1) & 0xFF; this.setZN(this.y); break;
      case 'ASL': {
        if (this.addrMode === 'IMP') { this.setC((this.a >> 7) & 1); this.a = (this.a << 1) & 0xFF; this.setZN(this.a); }
        else { const v = this.read(addr); this.setC((v>>7)&1); const r = (v<<1)&0xFF; wr(addr,r); this.setZN(r); }
      } break;
      case 'LSR': {
        if (this.addrMode === 'IMP') { this.setC(this.a & 1); this.a = (this.a >>> 1) & 0xFF; this.setZN(this.a); }
        else { const v = this.read(addr); this.setC(v & 1); const r = (v >>> 1) & 0xFF; wr(addr, r); this.setZN(r); }
      } break;
      case 'ROL': {
        if (this.addrMode === 'IMP') { const c = this.getC(); this.setC((this.a >> 7) & 1); this.a = ((this.a << 1) | c) & 0xFF; this.setZN(this.a); }
        else { const v = this.read(addr); const c = this.getC(); this.setC((v >> 7) & 1); const r = ((v << 1) | c) & 0xFF; wr(addr, r); this.setZN(r); }
      } break;
      case 'ROR': {
        if (this.addrMode === 'IMP') { const c = this.getC(); this.setC(this.a & 1); this.a = ((this.a >>> 1) | (c<<7)) & 0xFF; this.setZN(this.a); }
        else { const v = this.read(addr); const c = this.getC(); this.setC(v & 1); const r = ((v >>> 1) | (c<<7)) & 0xFF; wr(addr, r); this.setZN(r); }
      } break;
      case 'BIT': { BIT(this.read(addr)); } break;
      case 'JMP': this.pc = addr; break;
      case 'JSR': {
        const ret = (this.pc - 1) & 0xFFFF;
        this.push((ret >> 8) & 0xFF);
        this.push(ret & 0xFF);
        this.pc = addr;
      } break;
      case 'RTS': {
        const lo = this.pop(), hi = this.pop();
        this.pc = ((hi << 8) | lo) + 1;
      } break;
      case 'RTI': {
        this.p = (this.pop() & 0xEF) | 0x20;
        const lo = this.pop(), hi = this.pop();
        this.pc = (hi<<8) | lo;
      } break;
      case 'BCC': { if (!this.getC()) { this.cycles++; if ((this.pc & 0xFF00) !== (addr & 0xFF00)) this.cycles++; this.pc = addr; } } break;
      case 'BCS': { if (this.getC()) { this.cycles++; if ((this.pc & 0xFF00) !== (addr & 0xFF00)) this.cycles++; this.pc = addr; } } break;
      case 'BEQ': { if (this.getZ()) { this.cycles++; if ((this.pc & 0xFF00) !== (addr & 0xFF00)) this.cycles++; this.pc = addr; } } break;
      case 'BMI': { if (this.getN()) { this.cycles++; if ((this.pc & 0xFF00) !== (addr & 0xFF00)) this.cycles++; this.pc = addr; } } break;
      case 'BNE': { if (!this.getZ()) { this.cycles++; if ((this.pc & 0xFF00) !== (addr & 0xFF00)) this.cycles++; this.pc = addr; } } break;
      case 'BPL': { if (!this.getN()) { this.cycles++; if ((this.pc & 0xFF00) !== (addr & 0xFF00)) this.cycles++; this.pc = addr; } } break;
      case 'BVC': { if (!this.getV()) { this.cycles++; if ((this.pc & 0xFF00) !== (addr & 0xFF00)) this.cycles++; this.pc = addr; } } break;
      case 'BVS': { if (this.getV()) { this.cycles++; if ((this.pc & 0xFF00) !== (addr & 0xFF00)) this.cycles++; this.pc = addr; } } break;
      case 'CLC': this.setC(0); break;
      case 'SEC': this.setC(1); break;
      case 'CLI': this.setI(0); break;
      case 'SEI': this.setI(1); break;
      case 'CLV': this.setV(0); break;
      case 'CLD': this.setD(0); break;
      case 'SED': this.setD(1); break;
      default:
        // unknown op: treat as NOP
        break;
    }
  }

  // Build opcode table (subset of official 6502 opcodes used by many NES carts).
  buildOpcodes() {
    const O = (mode, ins, cyc) => ({ mode, ins, cyc });
    this.OPCODES = new Array(256);
    const fill = (list) => list.forEach(([op, mode, ins, cyc]) => { this.OPCODES[op] = O(mode, ins, cyc); });

    fill([
      [0x00,'IMP','BRK',7],[0xEA,'IMP','NOP',2],
      [0xA9,'IMM','LDA',2],[0xA5,'ZP0','LDA',3],[0xB5,'ZPX','LDA',4],[0xAD,'ABS','LDA',4],[0xBD,'ABX','LDA',4],[0xB9,'ABY','LDA',4],[0xA1,'IZX','LDA',6],[0xB1,'IZY','LDA',5],
      [0xA2,'IMM','LDX',2],[0xA6,'ZP0','LDX',3],[0xB6,'ZPY','LDX',4],[0xAE,'ABS','LDX',4],[0xBE,'ABY','LDX',4],
      [0xA0,'IMM','LDY',2],[0xA4,'ZP0','LDY',3],[0xB4,'ZPX','LDY',4],[0xAC,'ABS','LDY',4],[0xBC,'ABX','LDY',4],
      [0x85,'ZP0','STA',3],[0x95,'ZPX','STA',4],[0x8D,'ABS','STA',4],[0x9D,'ABX','STA',5],[0x99,'ABY','STA',5],[0x81,'IZX','STA',6],[0x91,'IZY','STA',6],
      [0x86,'ZP0','STX',3],[0x96,'ZPY','STX',4],[0x8E,'ABS','STX',4],
      [0x84,'ZP0','STY',3],[0x94,'ZPX','STY',4],[0x8C,'ABS','STY',4],
      [0xAA,'IMP','TAX',2],[0xA8,'IMP','TAY',2],[0x8A,'IMP','TXA',2],[0x98,'IMP','TYA',2],
      [0xBA,'IMP','TSX',2],[0x9A,'IMP','TXS',2],[0x48,'IMP','PHA',3],[0x08,'IMP','PHP',3],[0x68,'IMP','PLA',4],[0x28,'IMP','PLP',4],
      [0x29,'IMM','AND',2],[0x25,'ZP0','AND',3],[0x35,'ZPX','AND',4],[0x2D,'ABS','AND',4],[0x3D,'ABX','AND',4],[0x39,'ABY','AND',4],[0x21,'IZX','AND',6],[0x31,'IZY','AND',5],
      [0x09,'IMM','ORA',2],[0x05,'ZP0','ORA',3],[0x15,'ZPX','ORA',4],[0x0D,'ABS','ORA',4],[0x1D,'ABX','ORA',4],[0x19,'ABY','ORA',4],[0x01,'IZX','ORA',6],[0x11,'IZY','ORA',5],
      [0x49,'IMM','EOR',2],[0x45,'ZP0','EOR',3],[0x55,'ZPX','EOR',4],[0x4D,'ABS','EOR',4],[0x5D,'ABX','EOR',4],[0x59,'ABY','EOR',4],[0x41,'IZX','EOR',6],[0x51,'IZY','EOR',5],
      [0x69,'IMM','ADC',2],[0x65,'ZP0','ADC',3],[0x75,'ZPX','ADC',4],[0x6D,'ABS','ADC',4],[0x7D,'ABX','ADC',4],[0x79,'ABY','ADC',4],[0x61,'IZX','ADC',6],[0x71,'IZY','ADC',5],
      [0xE9,'IMM','SBC',2],[0xE5,'ZP0','SBC',3],[0xF5,'ZPX','SBC',4],[0xED,'ABS','SBC',4],[0xFD,'ABX','SBC',4],[0xF9,'ABY','SBC',4],[0xE1,'IZX','SBC',6],[0xF1,'IZY','SBC',5],
      [0xC9,'IMM','CMP',2],[0xC5,'ZP0','CMP',3],[0xD5,'ZPX','CMP',4],[0xCD,'ABS','CMP',4],[0xDD,'ABX','CMP',4],[0xD9,'ABY','CMP',4],[0xC1,'IZX','CMP',6],[0xD1,'IZY','CMP',5],
      [0xE0,'IMM','CPX',2],[0xE4,'ZP0','CPX',3],[0xEC,'ABS','CPX',4],
      [0xC0,'IMM','CPY',2],[0xC4,'ZP0','CPY',3],[0xCC,'ABS','CPY',4],
      [0xE6,'ZP0','INC',5],[0xF6,'ZPX','INC',6],[0xEE,'ABS','INC',6],[0xFE,'ABX','INC',7],
      [0xC6,'ZP0','DEC',5],[0xD6,'ZPX','DEC',6],[0xCE,'ABS','DEC',6],[0xDE,'ABX','DEC',7],
      [0xE8,'IMP','INX',2],[0xC8,'IMP','INY',2],[0xCA,'IMP','DEX',2],[0x88,'IMP','DEY',2],
      [0x0A,'IMP','ASL',2],[0x06,'ZP0','ASL',5],[0x16,'ZPX','ASL',6],[0x0E,'ABS','ASL',6],[0x1E,'ABX','ASL',7],
      [0x4A,'IMP','LSR',2],[0x46,'ZP0','LSR',5],[0x56,'ZPX','LSR',6],[0x4E,'ABS','LSR',6],[0x5E,'ABX','LSR',7],
      [0x2A,'IMP','ROL',2],[0x26,'ZP0','ROL',5],[0x36,'ZPX','ROL',6],[0x2E,'ABS','ROL',6],[0x3E,'ABX','ROL',7],
      [0x6A,'IMP','ROR',2],[0x66,'ZP0','ROR',5],[0x76,'ZPX','ROR',6],[0x6E,'ABS','ROR',6],[0x7E,'ABX','ROR',7],
      [0x24,'ZP0','BIT',3],[0x2C,'ABS','BIT',4],
      [0x4C,'ABS','JMP',3],[0x6C,'IND','JMP',5],
      [0x20,'ABS','JSR',6],[0x60,'IMP','RTS',6],[0x40,'IMP','RTI',6],
      [0x90,'REL','BCC',2],[0xB0,'REL','BCS',2],[0xF0,'REL','BEQ',2],[0x30,'REL','BMI',2],[0xD0,'REL','BNE',2],[0x10,'REL','BPL',2],[0x50,'REL','BVC',2],[0x70,'REL','BVS',2],
      [0x18,'IMP','CLC',2],[0x38,'IMP','SEC',2],[0x58,'IMP','CLI',2],[0x78,'IMP','SEI',2],[0xB8,'IMP','CLV',2],[0xD8,'IMP','CLD',2],[0xF8,'IMP','SED',2],
    ]);
  }
}
