// cartridge.js
export class Cartridge {
  constructor(bytes) {
    this.bytes = bytes;
    this.parseINES();
  }

  parseINES(){
    const b = this.bytes;
    if (b[0] !== 0x4E || b[1] !== 0x45 || b[2] !== 0x53 || b[3] !== 0x1A) throw new Error('Not an iNES file');
    const prgBanks = b[4], chrBanks = b[5];
    const flag6 = b[6], flag7 = b[7];
    const mapper = (flag7 & 0xF0) | (flag6 >> 4);
    this.mapperId = mapper & 0xFF;
    this.mirror = (flag6 & 0x01) ? 'vertical' : 'horizontal';
    this.hasTrainer = !!(flag6 & 0x04);
    let off = 16;
    if (this.hasTrainer) off += 512;
    const prgSize = prgBanks * 16384;
    const chrSize = chrBanks * 8192;
    this.prg = b.slice(off, off + prgSize);
    off += prgSize;
    this.chr = chrSize ? b.slice(off, off + chrSize) : new Uint8Array(8192);
    this.chrRAM = chrSize === 0;
    this.sram = new Uint8Array(0x2000);

    // instantiate minimal mappers (0..4)
    const m = this.mapperId;
    if (m === 0) this.mapperInstance = new Mapper0(this);
    else if (m === 1) this.mapperInstance = new Mapper1(this);
    else if (m === 2) this.mapperInstance = new Mapper2(this);
    else if (m === 3) this.mapperInstance = new Mapper3(this);
    else if (m === 4) this.mapperInstance = new Mapper4(this);
    else this.mapperInstance = new Mapper0(this); // fallback
  }

  // Outer API used by Bus when mapper isn't present
  read(addr){
    if (addr >= 0x8000) {
      return this.prg[addr - 0x8000];
    }
    return 0;
  }
}

/* Mappers: minimal implementations (same logic as earlier monolithic file) */
class Mapper {
  constructor(cart){ this.cart = cart; }
  prgRead(addr){ return this.cart.prg[addr - 0x8000]; }
  prgWrite(addr,val){}
  chrRead(addr){ return this.cart.chr[addr & (this.cart.chr.length-1)]; }
  chrWrite(addr,val){ if(this.cart.chrRAM) this.cart.chr[addr & (this.cart.chr.length-1)] = val; }
  get mirror(){ return this.cart.mirror; }
}
class Mapper0 extends Mapper {
  prgRead(addr){ if(this.cart.prg.length===0x4000 && addr>=0xC000) return this.cart.prg[addr-0xC000]; return this.cart.prg[addr-0x8000]; }
}
class Mapper1 extends Mapper {
  constructor(c){ super(c); this.shift=0x10; this.ctrl=0x0C; this.prgBank=0; this.chrBank0=0; this.chrBank1=0; }
  writeReg(addr,val){ if(val&0x80){ this.shift=0x10; this.ctrl|=0x0C; return; } const complete = (this.shift & 1); this.shift = (this.shift>>1) | ((val&1)<<4); if(complete){ const reg = (addr>>13)&3; const data = this.shift & 0x1F; this.shift=0x10; if(reg===0){ this.ctrl=data; this.cart.mirror=['horizontal','vertical','single0','single1'][data&3]||'horizontal'; } else if(reg===1){ this.chrBank0=data; } else if(reg===2){ this.chrBank1=data; } else if(reg===3){ this.prgBank=data & 0x0F; } } }
  prgRead(addr){ const mode=(this.ctrl>>2)&3; const bank16=(b)=>b*0x4000; if(mode===0||mode===1){ const base=(this.prgBank&0x0E)*0x4000; return this.cart.prg[base + (addr-0x8000)]; } else if(mode===2){ if(addr<0xC000) return this.cart.prg[(addr-0x8000)]; const base=bank16(this.prgBank); return this.cart.prg[base + (addr-0xC000)]; } else { const base=bank16(this.prgBank); if(addr<0xC000) return this.cart.prg[base + (addr-0x8000)]; return this.cart.prg[this.cart.prg.length-0x4000 + (addr-0xC000)]; } }
  prgWrite(addr,val){ this.writeReg(addr,val); }
  chrRead(addr){ const mode = (this.ctrl>>4)&1; if(mode===0){ const base=(this.chrBank0&0x1E)*0x1000; return this.cart.chr[base + addr]; } else { const base = (addr<0x1000? this.chrBank0: this.chrBank1)*0x1000; return this.cart.chr[base + (addr&0x0FFF)]; } }
  chrWrite(addr,val){ if(this.cart.chrRAM){ const mode=(this.ctrl>>4)&1; if(mode===0){ const base=(this.chrBank0&0x1E)*0x1000; this.cart.chr[base + addr]=val; } else { const base = (addr<0x1000? this.chrBank0: this.chrBank1)*0x1000; this.cart.chr[base + (addr&0x0FFF)]=val; } } }
}
class Mapper2 extends Mapper { constructor(c){ super(c); this.bank=0; } prgRead(addr){ if(addr<0xC000){ const base=this.bank*0x4000; return this.cart.prg[base + (addr-0x8000)]; } return this.cart.prg[this.cart.prg.length-0x4000 + (addr-0xC000)]; } prgWrite(addr,val){ this.bank = val & 0x0F; } }
class Mapper3 extends Mapper { constructor(c){ super(c); this.chrBank=0; } prgRead(addr){ return this.cart.prg[addr-0x8000]; } prgWrite(addr,val){ this.chrBank = val & 0x03; } chrRead(addr){ const base=this.chrBank*0x2000; return this.cart.chr[base + addr]; } }
class Mapper4 extends Mapper {
  constructor(c){ super(c); this.bankSelect=0; this.banks=new Uint8Array(8); this.mirror= c.mirror; this.prgMode=0; this.chrMode=0; }
  prgRead(addr){
    const prgSize=this.cart.prg.length;
    const bank16=(i)=> (i% (prgSize/0x2000)) * 0x2000;
    const last=prgSize-0x2000;
    const bankAt=(slot)=>{ const i = this.banks[slot]; return bank16(i); };
    if(addr<0xA000){ const a = this.prgMode? bankAt(6) : 0; return this.cart.prg[a + (addr-0x8000)]; }
    if(addr<0xC000){ const a = bankAt(7); return this.cart.prg[a + (addr-0xA000)]; }
    if(addr<0xE000){ const a = this.prgMode? 0 : bankAt(6); return this.cart.prg[a + (addr-0xC000)]; }
    return this.cart.prg[last + (addr-0xE000)];
  }
  prgWrite(addr,val){
    if((addr&1)===0){
      if((addr&0x6000)===0x0000){ this.bankSelect=val; this.chrMode=(val>>7)&1; this.prgMode=(val>>6)&1; }
      else if((addr&0x6000)===0x2000){ this.cart.mirror = (val&1)?'horizontal':'vertical'; }
    } else {
      if((addr&0x6000)===0x0000){ const reg= this.bankSelect&7; this.banks[reg]=val; }
    }
  }
  chrRead(addr){
    const chrAt=(i)=> (this.banks[i]*0x400) & (this.cart.chr.length-1);
    if(this.chrMode){
      if(addr<0x0800) return this.cart.chr[chrAt(2) + (addr)];
      if(addr<0x1000) return this.cart.chr[chrAt(3) + (addr-0x0800)];
      if(addr<0x1400) return this.cart.chr[chrAt(4) + (addr-0x1000)];
      if(addr<0x1800) return this.cart.chr[chrAt(5) + (addr-0x1400)];
      if(addr<0x1C00) return this.cart.chr[chrAt(0) + (addr-0x1800)];
      return this.cart.chr[chrAt(1) + (addr-0x1C00)];
    } else {
      if(addr<0x0800) return this.cart.chr[chrAt(0) + (addr)];
      if(addr<0x1000) return this.cart.chr[chrAt(1) + (addr-0x0800)];
      if(addr<0x1400) return this.cart.chr[chrAt(2) + (addr-0x1000)];
      if(addr<0x1800) return this.cart.chr[chrAt(3) + (addr-0x1400)];
      if(addr<0x1C00) return this.cart.chr[chrAt(4) + (addr-0x1800)];
      return this.cart.chr[chrAt(5) + (addr-0x1C00)];
    }
  }
}
