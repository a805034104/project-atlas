/**
 * OTLP/HTTP trace payload decoding (ExportTraceServiceRequest), protobuf and JSON.
 *
 *   bytes ─▶ ProtoReader (varint / fixed32 / fixed64 / length-delimited, bounds-checked)
 *        ─▶ ResourceSpans[] ─▶ ScopeSpans[] ─▶ Span ─▶ RawSpan (ids hex, nanos bigint)
 *
 * Hand-written against opentelemetry-proto v1 field numbers. Unknown fields of
 * every wire type are skipped, AnyValue nesting is capped (kvlist/array), and
 * every length is checked against the buffer, so a hostile local process cannot
 * crash or stall the extension host with a crafted payload.
 */

export type AttrValue = string | number | boolean | bigint | AttrValue[] | { [key: string]: AttrValue } | Uint8Array;

export interface RawEvent {
  name: string;
  timeUnixNano: bigint;
  attributes: Record<string, AttrValue>;
}

export interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer */
  kind: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Record<string, AttrValue>;
  events: RawEvent[];
  /** 0 unset, 1 ok, 2 error */
  statusCode: number;
  flags?: number;
}

export interface RawScopeSpans {
  scope: { name: string; version?: string };
  spans: RawSpan[];
}

export interface RawResourceSpans {
  resource: Record<string, AttrValue>;
  scopeSpans: RawScopeSpans[];
}

export class OtlpDecodeError extends Error {}

const MAX_ANY_VALUE_DEPTH = 8;
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

class ProtoReader {
  pos: number;
  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new OtlpDecodeError("truncated varint");
      const b = this.buf[this.pos++] as number;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new OtlpDecodeError("varint longer than 10 bytes");
  }

  varint32(): number {
    return Number(BigInt.asUintN(32, this.varint()));
  }

  tag(): { field: number; wire: number } {
    const t = this.varint();
    const field = Number(t >> 3n);
    if (field === 0) throw new OtlpDecodeError("field number 0");
    return { field, wire: Number(t & 7n) };
  }

  fixed64(): bigint {
    if (this.pos + 8 > this.end) throw new OtlpDecodeError("truncated fixed64");
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getBigUint64(0, true);
  }

  double(): number {
    if (this.pos + 8 > this.end) throw new OtlpDecodeError("truncated double");
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  fixed32(): number {
    if (this.pos + 4 > this.end) throw new OtlpDecodeError("truncated fixed32");
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    this.pos += 4;
    return view.getUint32(0, true);
  }

  /** Sub-reader over a length-delimited field. */
  sub(): ProtoReader {
    const len = this.varint();
    if (len > BigInt(this.end - this.pos)) throw new OtlpDecodeError("length exceeds buffer");
    const start = this.pos;
    this.pos += Number(len);
    return new ProtoReader(this.buf, start, this.pos);
  }

  bytes(): Uint8Array {
    const r = this.sub();
    return this.buf.subarray(r.pos, r.end);
  }

  string(): string {
    return UTF8.decode(this.bytes());
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        if (this.pos + 8 > this.end) throw new OtlpDecodeError("truncated fixed64");
        this.pos += 8;
        return;
      case WIRE_LEN:
        this.sub();
        return;
      case WIRE_FIXED32:
        if (this.pos + 4 > this.end) throw new OtlpDecodeError("truncated fixed32");
        this.pos += 4;
        return;
      default:
        throw new OtlpDecodeError(`unsupported wire type ${wire}`);
    }
  }

  /** Iterate fields; `handle` returns false for fields it does not consume (they are skipped). */
  each(handle: (field: number, wire: number) => boolean): void {
    while (!this.done) {
      const { field, wire } = this.tag();
      if (!handle(field, wire)) this.skip(wire);
    }
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: false });

function expectWire(actual: number, expected: number, what: string): void {
  if (actual !== expected) throw new OtlpDecodeError(`${what}: wire type ${actual}, expected ${expected}`);
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function anyValue(r: ProtoReader, depth: number): AttrValue | undefined {
  if (depth > MAX_ANY_VALUE_DEPTH) throw new OtlpDecodeError("AnyValue nested too deeply");
  let value: AttrValue | undefined;
  r.each((field, wire) => {
    switch (field) {
      case 1:
        expectWire(wire, WIRE_LEN, "string_value");
        value = r.string();
        return true;
      case 2:
        expectWire(wire, WIRE_VARINT, "bool_value");
        value = r.varint() !== 0n;
        return true;
      case 3: {
        expectWire(wire, WIRE_VARINT, "int_value");
        const v = BigInt.asIntN(64, r.varint());
        value = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        return true;
      }
      case 4:
        expectWire(wire, WIRE_FIXED64, "double_value");
        value = r.double();
        return true;
      case 5: {
        expectWire(wire, WIRE_LEN, "array_value");
        const arr: AttrValue[] = [];
        const list = r.sub();
        list.each((f, w) => {
          if (f !== 1) return false;
          expectWire(w, WIRE_LEN, "array element");
          const v = anyValue(list.sub(), depth + 1);
          if (v !== undefined) arr.push(v);
          return true;
        });
        value = arr;
        return true;
      }
      case 6: {
        expectWire(wire, WIRE_LEN, "kvlist_value");
        const obj: Record<string, AttrValue> = {};
        const list = r.sub();
        list.each((f, w) => {
          if (f !== 1) return false;
          expectWire(w, WIRE_LEN, "kvlist entry");
          keyValue(list.sub(), obj, depth + 1);
          return true;
        });
        value = obj;
        return true;
      }
      case 7:
        expectWire(wire, WIRE_LEN, "bytes_value");
        value = r.bytes().slice();
        return true;
      default:
        return false;
    }
  });
  return value;
}

function keyValue(r: ProtoReader, into: Record<string, AttrValue>, depth: number): void {
  let key: string | undefined;
  let value: AttrValue | undefined;
  r.each((field, wire) => {
    if (field === 1) {
      expectWire(wire, WIRE_LEN, "key");
      key = r.string();
      return true;
    }
    if (field === 2) {
      expectWire(wire, WIRE_LEN, "value");
      value = anyValue(r.sub(), depth);
      return true;
    }
    return false;
  });
  if (key !== undefined && value !== undefined && key !== "__proto__") into[key] = value;
}

function attributesField(r: ProtoReader, wire: number, into: Record<string, AttrValue>): void {
  expectWire(wire, WIRE_LEN, "attributes");
  keyValue(r.sub(), into, 0);
}

function decodeEvent(r: ProtoReader): RawEvent {
  const event: RawEvent = { name: "", timeUnixNano: 0n, attributes: {} };
  r.each((field, wire) => {
    if (field === 1) {
      expectWire(wire, WIRE_FIXED64, "event time");
      event.timeUnixNano = r.fixed64();
      return true;
    }
    if (field === 2) {
      expectWire(wire, WIRE_LEN, "event name");
      event.name = r.string();
      return true;
    }
    if (field === 3) {
      attributesField(r, wire, event.attributes);
      return true;
    }
    return false;
  });
  return event;
}

function decodeSpan(r: ProtoReader): RawSpan {
  const span: RawSpan = { traceId: "", spanId: "", name: "", kind: 0, startTimeUnixNano: 0n, endTimeUnixNano: 0n, attributes: {}, events: [], statusCode: 0 };
  r.each((field, wire) => {
    switch (field) {
      case 1:
        expectWire(wire, WIRE_LEN, "trace_id");
        span.traceId = hex(r.bytes());
        return true;
      case 2:
        expectWire(wire, WIRE_LEN, "span_id");
        span.spanId = hex(r.bytes());
        return true;
      case 4: {
        expectWire(wire, WIRE_LEN, "parent_span_id");
        const parent = hex(r.bytes());
        if (parent && !/^0+$/.test(parent)) span.parentSpanId = parent;
        return true;
      }
      case 5:
        expectWire(wire, WIRE_LEN, "name");
        span.name = r.string();
        return true;
      case 6:
        expectWire(wire, WIRE_VARINT, "kind");
        span.kind = r.varint32();
        return true;
      case 7:
        expectWire(wire, WIRE_FIXED64, "start_time_unix_nano");
        span.startTimeUnixNano = r.fixed64();
        return true;
      case 8:
        expectWire(wire, WIRE_FIXED64, "end_time_unix_nano");
        span.endTimeUnixNano = r.fixed64();
        return true;
      case 9:
        attributesField(r, wire, span.attributes);
        return true;
      case 11:
        expectWire(wire, WIRE_LEN, "events");
        span.events.push(decodeEvent(r.sub()));
        return true;
      case 15:
        expectWire(wire, WIRE_LEN, "status");
        const status = r.sub();
        status.each((f, w) => {
          if (f !== 3) return false;
          expectWire(w, WIRE_VARINT, "status code");
          span.statusCode = status.varint32();
          return true;
        });
        return true;
      case 16:
        expectWire(wire, WIRE_FIXED32, "flags");
        span.flags = r.fixed32();
        return true;
      default:
        return false;
    }
  });
  if (span.traceId.length !== 32 || span.spanId.length !== 16) throw new OtlpDecodeError("span without valid trace_id / span_id");
  return span;
}

function decodeScopeSpans(r: ProtoReader): RawScopeSpans {
  const ss: RawScopeSpans = { scope: { name: "" }, spans: [] };
  r.each((field, wire) => {
    if (field === 1) {
      expectWire(wire, WIRE_LEN, "scope");
      const s = r.sub();
      s.each((f, w) => {
        if (f === 1) {
          expectWire(w, WIRE_LEN, "scope name");
          ss.scope.name = s.string();
          return true;
        }
        if (f === 2) {
          expectWire(w, WIRE_LEN, "scope version");
          ss.scope.version = s.string();
          return true;
        }
        return false;
      });
      return true;
    }
    if (field === 2) {
      expectWire(wire, WIRE_LEN, "span");
      ss.spans.push(decodeSpan(r.sub()));
      return true;
    }
    return false;
  });
  return ss;
}

function decodeResourceSpans(r: ProtoReader): RawResourceSpans {
  const rs: RawResourceSpans = { resource: {}, scopeSpans: [] };
  r.each((field, wire) => {
    if (field === 1) {
      expectWire(wire, WIRE_LEN, "resource");
      const res = r.sub();
      res.each((f, w) => {
        if (f !== 1) return false;
        attributesField(res, w, rs.resource);
        return true;
      });
      return true;
    }
    if (field === 2) {
      expectWire(wire, WIRE_LEN, "scope_spans");
      rs.scopeSpans.push(decodeScopeSpans(r.sub()));
      return true;
    }
    return false;
  });
  return rs;
}

/** Decode a protobuf ExportTraceServiceRequest. Throws OtlpDecodeError on malformed input. */
export function decodeTraceRequest(buf: Uint8Array): RawResourceSpans[] {
  const out: RawResourceSpans[] = [];
  const r = new ProtoReader(buf);
  r.each((field, wire) => {
    if (field !== 1) return false;
    expectWire(wire, WIRE_LEN, "resource_spans");
    out.push(decodeResourceSpans(r.sub()));
    return true;
  });
  return out;
}

// ── OTLP/JSON ────────────────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function jsonObject(v: Json | undefined): Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
}

function jsonArray(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}

function jsonAnyValue(v: Json | undefined, depth: number): AttrValue | undefined {
  if (depth > MAX_ANY_VALUE_DEPTH) throw new OtlpDecodeError("AnyValue nested too deeply");
  const o = jsonObject(v);
  if (typeof o["stringValue"] === "string") return o["stringValue"];
  if (typeof o["boolValue"] === "boolean") return o["boolValue"];
  if (o["intValue"] !== undefined) {
    const n = BigInt(String(o["intValue"]));
    return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
  }
  if (typeof o["doubleValue"] === "number") return o["doubleValue"];
  if (o["arrayValue"] !== undefined) return jsonArray(jsonObject(o["arrayValue"])["values"]).map((x) => jsonAnyValue(x, depth + 1)).filter((x): x is AttrValue => x !== undefined);
  if (o["kvlistValue"] !== undefined) return jsonAttributes(jsonObject(o["kvlistValue"])["values"], depth + 1);
  return undefined;
}

function jsonAttributes(list: Json | undefined, depth = 0): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const kv of jsonArray(list)) {
    const o = jsonObject(kv);
    const value = jsonAnyValue(o["value"], depth);
    if (typeof o["key"] === "string" && o["key"] !== "__proto__" && value !== undefined) out[o["key"]] = value;
  }
  return out;
}

function nanos(v: Json | undefined): bigint {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    throw new OtlpDecodeError(`bad timestamp ${String(v)}`);
  }
}

/** Decode an OTLP/JSON ExportTraceServiceRequest (ids as hex, int64 as strings). */
export function decodeTraceRequestJson(text: string): RawResourceSpans[] {
  let root: Json;
  try {
    root = JSON.parse(text) as Json;
  } catch (error) {
    throw new OtlpDecodeError(`invalid JSON: ${(error as Error).message}`);
  }
  return jsonArray(jsonObject(root)["resourceSpans"]).map((rsJson) => {
    const rs = jsonObject(rsJson);
    return {
      resource: jsonAttributes(jsonObject(rs["resource"])["attributes"]),
      scopeSpans: jsonArray(rs["scopeSpans"]).map((ssJson) => {
        const ss = jsonObject(ssJson);
        const scope = jsonObject(ss["scope"]);
        return {
          scope: { name: typeof scope["name"] === "string" ? scope["name"] : "", ...(typeof scope["version"] === "string" ? { version: scope["version"] } : {}) },
          spans: jsonArray(ss["spans"]).map((spJson) => {
            const sp = jsonObject(spJson);
            const traceId = String(sp["traceId"] ?? "").toLowerCase();
            const spanId = String(sp["spanId"] ?? "").toLowerCase();
            if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) throw new OtlpDecodeError("span without valid traceId / spanId");
            const parent = String(sp["parentSpanId"] ?? "").toLowerCase();
            const span: RawSpan = {
              traceId,
              spanId,
              name: String(sp["name"] ?? ""),
              kind: Number(sp["kind"] ?? 0) || 0,
              startTimeUnixNano: nanos(sp["startTimeUnixNano"]),
              endTimeUnixNano: nanos(sp["endTimeUnixNano"]),
              attributes: jsonAttributes(sp["attributes"]),
              events: jsonArray(sp["events"]).map((e) => {
                const ev = jsonObject(e);
                return { name: String(ev["name"] ?? ""), timeUnixNano: nanos(ev["timeUnixNano"]), attributes: jsonAttributes(ev["attributes"]) };
              }),
              statusCode: Number(jsonObject(sp["status"])["code"] ?? 0) || 0,
            };
            if (/^[0-9a-f]{16}$/.test(parent) && !/^0+$/.test(parent)) span.parentSpanId = parent;
            if (typeof sp["flags"] === "number") span.flags = sp["flags"];
            return span;
          }),
        };
      }),
    };
  });
}
