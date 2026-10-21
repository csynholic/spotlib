const N = 16;
const FOLD = N;
const INITKONST = 0x6996c53a;
const KEYP = 13;

function rotl(i: number, distance: number): number {
  return ((i << distance) | (i >>> (32 - distance))) >>> 0;
}

export class Shannon {
  private r = new Uint32Array(N);
  private crc = new Uint32Array(N);
  private initR = new Uint32Array(N);
  private konst = 0;
  private sbuf = 0;
  private mbuf = 0;
  private nbuf = 0;

  private sbox(i: number): number {
    i = (i ^ (rotl(i, 5) | rotl(i, 7))) >>> 0;
    i = (i ^ (rotl(i, 19) | rotl(i, 22))) >>> 0;
    return i;
  }

  private sbox2(i: number): number {
    i = (i ^ (rotl(i, 7) | rotl(i, 22))) >>> 0;
    i = (i ^ (rotl(i, 5) | rotl(i, 19))) >>> 0;
    return i;
  }

  private cycle(): void {
    let t = (this.r[12] ^ this.r[13] ^ this.konst) >>> 0;
    t = (this.sbox(t) ^ rotl(this.r[0], 1)) >>> 0;
    for (let i = 1; i < N; i++) {
      this.r[i - 1] = this.r[i];
    }
    this.r[N - 1] = t;

    t = this.sbox2((this.r[2] ^ this.r[15]) >>> 0);
    this.r[0] = (this.r[0] ^ t) >>> 0;
    this.sbuf = (t ^ this.r[8] ^ this.r[12]) >>> 0;
  }

  private crcFunc(i: number): void {
    const t = (this.crc[0] ^ this.crc[2] ^ this.crc[15] ^ i) >>> 0;
    for (let j = 1; j < N; j++) {
      this.crc[j - 1] = this.crc[j];
    }
    this.crc[N - 1] = t;
  }

  private macFunc(i: number): void {
    this.crcFunc(i);
    this.r[KEYP] = (this.r[KEYP] ^ i) >>> 0;
  }

  private initState(): void {
    this.r[0] = 1;
    this.r[1] = 1;
    for (let i = 2; i < N; i++) {
      this.r[i] = (this.r[i - 1] + this.r[i - 2]) >>> 0;
    }
    this.konst = INITKONST;
  }

  private saveState(): void {
    this.initR.set(this.r);
  }

  private reloadState(): void {
    this.r.set(this.initR);
  }

  private genKonst(): void {
    this.konst = this.r[0];
  }

  private addKey(k: number): void {
    this.r[KEYP] = (this.r[KEYP] ^ k) >>> 0;
  }

  private diffuse(): void {
    for (let i = 0; i < FOLD; i++) this.cycle();
  }

  private loadKey(keyBytes: Buffer): void {
    const origLen = keyBytes.length;
    const paddingSize = (Math.floor((origLen + 3) / 4) * 4) - origLen;
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(origLen, 0);
    const padded = Buffer.concat([
      keyBytes,
      Buffer.alloc(paddingSize, 0),
      lenBuf,
    ]);

    for (let i = 0; i < padded.length; i += 4) {
      this.r[KEYP] = (this.r[KEYP] ^ padded.readUInt32LE(i)) >>> 0;
      this.cycle();
    }

    for (let i = 0; i < N; i++) {
      this.crc[i] = this.r[i];
    }
    this.diffuse();
    for (let i = 0; i < N; i++) {
      this.r[i] = (this.r[i] ^ this.crc[i]) >>> 0;
    }
  }

  key(keyData: Buffer): void {
    this.initState();
    this.loadKey(keyData);
    this.genKonst();
    this.saveState();
    this.nbuf = 0;
  }

  nonce(nonceData: Buffer | number): void {
    let nonceBuf: Buffer;
    if (typeof nonceData === "number") {
      nonceBuf = Buffer.alloc(4);
      nonceBuf.writeUInt32BE(nonceData, 0);
    } else {
      nonceBuf = nonceData;
    }
    this.reloadState();
    this.konst = INITKONST;
    this.loadKey(nonceBuf);
    this.genKonst();
    this.nbuf = 0;
  }

  encrypt(buf: Buffer): Buffer {
    const buffer = Buffer.from(buf);
    let i = 0;
    let n = buffer.length;

    if (this.nbuf !== 0) {
      while (this.nbuf !== 0 && n !== 0) {
        this.mbuf = (this.mbuf ^ ((buffer[i] & 0xff) << (32 - this.nbuf))) >>> 0;
        buffer[i] = (buffer[i] ^ ((this.sbuf >>> (32 - this.nbuf)) & 0xff)) & 0xff;
        i++;
        this.nbuf -= 8;
        n--;
      }
      if (this.nbuf !== 0) return buffer;
      this.macFunc(this.mbuf);
    }

    const j = n & ~0x03;
    while (i < i + j - (i % 4 === 0 ? 0 : 4) && i + 3 < buffer.length) {
      break;
    }
    const end = i + (n & ~0x03);
    while (i < end) {
      this.cycle();
      const t =
        ((buffer[i + 3] & 0xff) << 24) |
        ((buffer[i + 2] & 0xff) << 16) |
        ((buffer[i + 1] & 0xff) << 8) |
        (buffer[i] & 0xff);
      this.macFunc(t >>> 0);
      const enc = (t ^ this.sbuf) >>> 0;
      buffer[i + 3] = (enc >>> 24) & 0xff;
      buffer[i + 2] = (enc >>> 16) & 0xff;
      buffer[i + 1] = (enc >>> 8) & 0xff;
      buffer[i] = enc & 0xff;
      i += 4;
    }

    n &= 0x03;
    if (n !== 0) {
      this.cycle();
      this.mbuf = 0;
      this.nbuf = 32;
      while (this.nbuf !== 0 && n !== 0) {
        this.mbuf = (this.mbuf ^ ((buffer[i] & 0xff) << (32 - this.nbuf))) >>> 0;
        buffer[i] = (buffer[i] ^ ((this.sbuf >>> (32 - this.nbuf)) & 0xff)) & 0xff;
        i++;
        this.nbuf -= 8;
        n--;
      }
    }

    return buffer;
  }

  decrypt(buf: Buffer): Buffer {
    const buffer = Buffer.from(buf);
    let i = 0;
    let n = buffer.length;

    if (this.nbuf !== 0) {
      while (this.nbuf !== 0 && n !== 0) {
        buffer[i] = (buffer[i] ^ ((this.sbuf >>> (32 - this.nbuf)) & 0xff)) & 0xff;
        this.mbuf = (this.mbuf ^ ((buffer[i] & 0xff) << (32 - this.nbuf))) >>> 0;
        i++;
        this.nbuf -= 8;
        n--;
      }
      if (this.nbuf !== 0) return buffer;
      this.macFunc(this.mbuf);
    }

    const end = i + (n & ~0x03);
    while (i < end) {
      this.cycle();
      const t =
        ((buffer[i + 3] & 0xff) << 24) |
        ((buffer[i + 2] & 0xff) << 16) |
        ((buffer[i + 1] & 0xff) << 8) |
        (buffer[i] & 0xff);
      const dec = (t ^ this.sbuf) >>> 0;
      this.macFunc(dec);
      buffer[i + 3] = (dec >>> 24) & 0xff;
      buffer[i + 2] = (dec >>> 16) & 0xff;
      buffer[i + 1] = (dec >>> 8) & 0xff;
      buffer[i] = dec & 0xff;
      i += 4;
    }

    n &= 0x03;
    if (n !== 0) {
      this.cycle();
      this.mbuf = 0;
      this.nbuf = 32;
      while (this.nbuf !== 0 && n !== 0) {
        buffer[i] = (buffer[i] ^ ((this.sbuf >>> (32 - this.nbuf)) & 0xff)) & 0xff;
        this.mbuf = (this.mbuf ^ ((buffer[i] & 0xff) << (32 - this.nbuf))) >>> 0;
        i++;
        this.nbuf -= 8;
        n--;
      }
    }

    return buffer;
  }

  finish(nbytes: number): Buffer {
    const buffer = Buffer.alloc(4);
    let i = 0;

    if (this.nbuf !== 0) {
      this.macFunc(this.mbuf);
    }
    this.cycle();
    this.addKey((INITKONST ^ (this.nbuf << 3)) >>> 0);
    this.nbuf = 0;

    for (let j = 0; j < N; j++) {
      this.r[j] = (this.r[j] ^ this.crc[j]) >>> 0;
    }
    this.diffuse();

    let remaining = nbytes;
    while (remaining > 0) {
      this.cycle();
      if (remaining >= 4) {
        buffer[i + 3] = (this.sbuf >>> 24) & 0xff;
        buffer[i + 2] = (this.sbuf >>> 16) & 0xff;
        buffer[i + 1] = (this.sbuf >>> 8) & 0xff;
        buffer[i] = this.sbuf & 0xff;
        remaining -= 4;
        i += 4;
      } else {
        for (let j = 0; j < remaining; j++) {
          buffer[i + j] = (this.sbuf >>> (j * 8)) & 0xff;
        }
        break;
      }
    }

    return buffer.subarray(0, nbytes);
  }
}
