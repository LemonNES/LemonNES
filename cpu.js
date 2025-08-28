// cpu.js

class CPU {
  constructor(memory) {
    this.memory = memory;

    // Registers
    this.A = 0x00; // Accumulator
    this.X = 0x00; // X Register
    this.Y = 0x00; // Y Register
    this.SP = 0xFD; // Stack Pointer
    this.PC = 0x0000; // Program Counter
    this.status = 0x24; // Processor Status

    this.cycles = 0;
  }

  reset() {
    this.A = 0;
    this.X = 0;
    this.Y = 0;
    this.SP = 0xFD;
    this.status = 0x24;
    this.PC = this.readWord(0xFFFC); // Reset vector
  }

  read(addr) {
    return this.memory.read(addr);
  }

  write(addr, value) {
    this.memory.write(addr, value);
  }

  readWord(addr) {
    const low = this.read(addr);
    const high = this.read(addr + 1);
    return (high << 8) | low;
  }

  setFlag(flag, value) {
    if (value) this.status |= flag;
    else this.status &= ~flag;
  }

  getFlag(flag) {
    return (this.status & flag) !== 0;
  }

  // Status flags
  static FLAGS = {
    C: 1 << 0, // Carry
    Z: 1 << 1, // Zero
    I: 1 << 2, // Interrupt Disable
    D: 1 << 3, // Decimal Mode (unused in NES)
    B: 1 << 4, // Break
    U: 1 << 5, // Unused
    V: 1 << 6, // Overflow
    N: 1 << 7  // Negative
  };

  step() {
    const opcode = this.read(this.PC++);
    return this.execute(opcode);
  }

  execute(opcode) {
    switch (opcode) {
      case 0xA9: // LDA Immediate
        const value = this.read(this.PC++);
        this.A = value;
        this.setFlag(CPU.FLAGS.Z, this.A === 0);
        this.setFlag(CPU.FLAGS.N, this.A & 0x80);
        return 2;

      case 0xAA: // TAX
        this.X = this.A;
        this.setFlag(CPU.FLAGS.Z, this.X === 0);
        this.setFlag(CPU.FLAGS.N, this.X & 0x80);
        return 2;

      case 0xE8: // INX
        this.X = (this.X + 1) & 0xFF;
        this.setFlag(CPU.FLAGS.Z, this.X === 0);
        this.setFlag(CPU.FLAGS.N, this.X & 0x80);
        return 2;

      default:
        console.warn(`Unhandled opcode: ${opcode.toString(16)}`);
        return 2;
    }
  }
}

export default CPU;
getImmediate() {
  return this.read(this.PC++);
}

getZeroPage() {
  return this.read(this.read(this.PC++));
}

getZeroPageAddr() {
  return this.read(this.PC++);
}

getAbsoluteAddr() {
  const addr = this.readWord(this.PC);
  this.PC += 2;
  return addr;
}

getAbsolute() {
  return this.read(this.getAbsoluteAddr());
}
execute(opcode) {
  switch (opcode) {
    case 0xA9: // LDA Immediate
      this.A = this.getImmediate();
      this.setFlag(CPU.FLAGS.Z, this.A === 0);
      this.setFlag(CPU.FLAGS.N, this.A & 0x80);
      return 2;

    case 0x85: // STA Zero Page
      this.write(this.getZeroPageAddr(), this.A);
      return 3;

    case 0x8D: // STA Absolute
      this.write(this.getAbsoluteAddr(), this.A);
      return 4;

    case 0x4C: // JMP Absolute
      this.PC = this.getAbsoluteAddr();
      return 3;

    case 0x00: // BRK
      this.PC++;
      this.pushWord(this.PC);
      this.push(this.status | CPU.FLAGS.B);
      this.setFlag(CPU.FLAGS.I, true);
      this.PC = this.readWord(0xFFFE);
      return 7;

    case 0x69: // ADC Immediate
      this.adc(this.getImmediate());
      return 2;

    case 0xE9: // SBC Immediate
      this.sbc(this.getImmediate());
      return 2;

    case 0x48: // PHA
      this.push(this.A);
      return 3;

    case 0x68: // PLA
      this.A = this.pull();
      this.setFlag(CPU.FLAGS.Z, this.A === 0);
      this.setFlag(CPU.FLAGS.N, this.A & 0x80);
      return 4;

    default:
      console.warn(`Unhandled opcode: ${opcode.toString(16)}`);
      return 2;
  }
}
adc(value) {
  const carry = this.getFlag(CPU.FLAGS.C) ? 1 : 0;
  const result = this.A + value + carry;
  this.setFlag(CPU.FLAGS.C, result > 0xFF);
  this.setFlag(CPU.FLAGS.Z, (result & 0xFF) === 0);
  this.setFlag(CPU.FLAGS.N, result & 0x80);
  this.setFlag(CPU.FLAGS.V, (~(this.A ^ value) & (this.A ^ result)) & 0x80);
  this.A = result & 0xFF;
}

sbc(value) {
  this.adc(~value & 0xFF);
}
push(value) {
  this.write(0x0100 + this.SP--, value);
}

pull() {
  return this.read(0x0100 + ++this.SP);
}

pushWord(value) {
  this.push((value >> 8) & 0xFF);
  this.push(value & 0xFF);
}

pullWord() {
  const low = this.pull();
  const high = this.pull();
  return (high << 8) | low;
}
nmi() {
  this.pushWord(this.PC);
  this.push(this.status);
  this.setFlag(CPU.FLAGS.I, true);
  this.PC = this.readWord(0xFFFA);
}

irq() {
  if (!this.getFlag(CPU.FLAGS.I)) {
    this.pushWord(this.PC);
    this.push(this.status);
    this.setFlag(CPU.FLAGS.I, true);
    this.PC = this.readWord(0xFFFE);
  }
}
