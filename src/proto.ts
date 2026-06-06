const VARINT = 0;
const LENGTH_DELIMITED = 2;
const FIXED32 = 5;

export class ProtoWriter {
  private parts: Buffer[] = [];

  writeVarint(field: number, value: number): this {
    this.writeTag(field, VARINT);
    this.encodeVarint(value);
    return this;
  }

  writeBytes(field: number, data: Buffer): this {
    this.writeTag(field, LENGTH_DELIMITED);
    this.encodeVarint(data.length);
    this.parts.push(data);
    return this;
  }

  writeString(field: number, str: string): this {
    return this.writeBytes(field, Buffer.from(str, "utf-8"));
  }

  writeNested(field: number, fn: (w: ProtoWriter) => void): this {
    const nested = new ProtoWriter();
    fn(nested);
    return this.writeBytes(field, nested.build());
  }

  build(): Buffer {
    return Buffer.concat(this.parts);
  }

  private writeTag(field: number, wireType: number): void {
    this.encodeVarint((field << 3) | wireType);
  }

  private encodeVarint(value: number): void {
    const buf: number[] = [];
    let v = value >>> 0;
    while (v > 0x7f) {
      buf.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    buf.push(v & 0x7f);
    this.parts.push(Buffer.from(buf));
  }
}

export interface ProtoField {
  field: number;
  wireType: number;
  value: Buffer | number;
}

export class ProtoReader {
  private buf: Buffer;
  private pos: number;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.pos = 0;
  }

  hasMore(): boolean {
    return this.pos < this.buf.length;
  }

  readField(): ProtoField {
    const tag = this.readVarint();
    const field = tag >>> 3;
    const wireType = tag & 0x7;

    switch (wireType) {
      case VARINT:
        return { field, wireType, value: this.readVarint() };
      case 1: {
        const f64 = this.buf.subarray(this.pos, this.pos + 8);
        this.pos += 8;
        return { field, wireType, value: f64 as any };
      }
      case LENGTH_DELIMITED: {
        const len = this.readVarint();
        const data = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return { field, wireType, value: data as any };
      }
      case FIXED32: {
        const f32 = this.buf.readUInt32LE(this.pos);
        this.pos += 4;
        return { field, wireType, value: f32 };
      }
      default:
        throw new Error(`Unknown wire type ${wireType}`);
    }
  }

  private readVarint(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      const byte = this.buf[this.pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }
}

export function readAll(buf: Buffer): Map<number, (Buffer | number)[]> {
  const reader = new ProtoReader(buf);
  const fields = new Map<number, (Buffer | number)[]>();
  while (reader.hasMore()) {
    const f = reader.readField();
    const arr = fields.get(f.field) ?? [];
    arr.push(f.value);
    fields.set(f.field, arr);
  }
  return fields;
}
