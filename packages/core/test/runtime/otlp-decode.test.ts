import protobuf from "protobufjs";
import { describe, expect, it } from "vitest";
import { decodeTraceRequest, decodeTraceRequestJson, OtlpDecodeError, type AttrValue, type RawResourceSpans } from "../../src/runtime/otlp-decode.js";

/** opentelemetry-proto v1 subset (field numbers as published), used as an independent encoder. */
const SCHEMA = {
  nested: {
    AnyValue: {
      oneofs: { value: { oneof: ["stringValue", "boolValue", "intValue", "doubleValue", "arrayValue", "kvlistValue", "bytesValue"] } },
      fields: {
        stringValue: { type: "string", id: 1 },
        boolValue: { type: "bool", id: 2 },
        intValue: { type: "int64", id: 3 },
        doubleValue: { type: "double", id: 4 },
        arrayValue: { type: "ArrayValue", id: 5 },
        kvlistValue: { type: "KeyValueList", id: 6 },
        bytesValue: { type: "bytes", id: 7 },
      },
    },
    ArrayValue: { fields: { values: { rule: "repeated", type: "AnyValue", id: 1 } } },
    KeyValueList: { fields: { values: { rule: "repeated", type: "KeyValue", id: 1 } } },
    KeyValue: { fields: { key: { type: "string", id: 1 }, value: { type: "AnyValue", id: 2 } } },
    Resource: { fields: { attributes: { rule: "repeated", type: "KeyValue", id: 1 }, droppedAttributesCount: { type: "uint32", id: 2 } } },
    InstrumentationScope: { fields: { name: { type: "string", id: 1 }, version: { type: "string", id: 2 }, attributes: { rule: "repeated", type: "KeyValue", id: 3 } } },
    Event: { fields: { timeUnixNano: { type: "fixed64", id: 1 }, name: { type: "string", id: 2 }, attributes: { rule: "repeated", type: "KeyValue", id: 3 } } },
    Link: { fields: { traceId: { type: "bytes", id: 1 }, spanId: { type: "bytes", id: 2 }, flags: { type: "fixed32", id: 6 } } },
    Status: { fields: { message: { type: "string", id: 2 }, code: { type: "int32", id: 3 } } },
    Span: {
      fields: {
        traceId: { type: "bytes", id: 1 },
        spanId: { type: "bytes", id: 2 },
        traceState: { type: "string", id: 3 },
        parentSpanId: { type: "bytes", id: 4 },
        name: { type: "string", id: 5 },
        kind: { type: "int32", id: 6 },
        startTimeUnixNano: { type: "fixed64", id: 7 },
        endTimeUnixNano: { type: "fixed64", id: 8 },
        attributes: { rule: "repeated", type: "KeyValue", id: 9 },
        droppedAttributesCount: { type: "uint32", id: 10 },
        events: { rule: "repeated", type: "Event", id: 11 },
        links: { rule: "repeated", type: "Link", id: 13 },
        status: { type: "Status", id: 15 },
        flags: { type: "fixed32", id: 16 },
        // not in OTLP: unknown fields the decoder must skip
        futureString: { type: "string", id: 90 },
        futureFixed32: { type: "fixed32", id: 91 },
        futureFixed64: { type: "fixed64", id: 92 },
        futureVarint: { type: "uint64", id: 93 },
      },
    },
    ScopeSpans: { fields: { scope: { type: "InstrumentationScope", id: 1 }, spans: { rule: "repeated", type: "Span", id: 2 }, schemaUrl: { type: "string", id: 3 } } },
    ResourceSpans: { fields: { resource: { type: "Resource", id: 1 }, scopeSpans: { rule: "repeated", type: "ScopeSpans", id: 2 }, schemaUrl: { type: "string", id: 3 } } },
    ExportTraceServiceRequest: { fields: { resourceSpans: { rule: "repeated", type: "ResourceSpans", id: 1 } } },
  },
};
const root = protobuf.Root.fromJSON(SCHEMA);
const Request = root.lookupType("ExportTraceServiceRequest");

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Gen = { pb: Record<string, unknown>; expected: AttrValue };

function genValue(r: () => number, depth: number): Gen {
  const pick = Math.floor(r() * (depth < 3 ? 7 : 5));
  switch (pick) {
    case 0: {
      const s = `v${Math.floor(r() * 1e6)}-测试`;
      return { pb: { stringValue: s }, expected: s };
    }
    case 1: {
      const b = r() < 0.5;
      return { pb: { boolValue: b }, expected: b };
    }
    case 2: {
      const big = r() < 0.3;
      const n = big ? 9007199254740993n + BigInt(Math.floor(r() * 1000)) : BigInt(Math.floor((r() - 0.5) * 1e9));
      return { pb: { intValue: protobuf.util.Long.fromString(n.toString()) }, expected: big ? n : Number(n) };
    }
    case 3: {
      const d = (r() - 0.5) * 1e6;
      return { pb: { doubleValue: d }, expected: d };
    }
    case 4: {
      const bytes = new Uint8Array([1, 2, Math.floor(r() * 255)]);
      return { pb: { bytesValue: bytes }, expected: bytes };
    }
    case 5: {
      const items = Array.from({ length: 1 + Math.floor(r() * 3) }, () => genValue(r, depth + 1));
      return { pb: { arrayValue: { values: items.map((i) => i.pb) } }, expected: items.map((i) => i.expected) };
    }
    default: {
      const kvs = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => ({ key: `k${i}`, v: genValue(r, depth + 1) }));
      return { pb: { kvlistValue: { values: kvs.map((kv) => ({ key: kv.key, value: kv.v.pb })) } }, expected: Object.fromEntries(kvs.map((kv) => [kv.key, kv.v.expected])) };
    }
  }
}

function genAttributes(r: () => number): { pb: unknown[]; expected: Record<string, AttrValue> } {
  const n = Math.floor(r() * 5);
  const pb: unknown[] = [];
  const expected: Record<string, AttrValue> = {};
  for (let i = 0; i < n; i++) {
    const key = `attr.${i}.${Math.floor(r() * 100)}`;
    const v = genValue(r, 0);
    pb.push({ key, value: v.pb });
    expected[key] = v.expected;
  }
  return { pb, expected };
}

const bytesOf = (r: () => number, n: number) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256) | 1);
const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function genRequest(seed: number): { buf: Uint8Array; expected: RawResourceSpans[] } {
  const r = rng(seed);
  const pbResource: unknown[] = [];
  const expected: RawResourceSpans[] = [];
  for (let i = 0; i < 1 + Math.floor(r() * 2); i++) {
    const res = genAttributes(r);
    const scopes: unknown[] = [];
    const scopesExpected: RawResourceSpans["scopeSpans"] = [];
    for (let j = 0; j < 1 + Math.floor(r() * 2); j++) {
      const spans: unknown[] = [];
      const spansExpected: RawResourceSpans["scopeSpans"][number]["spans"] = [];
      for (let k = 0; k < 1 + Math.floor(r() * 4); k++) {
        const traceId = bytesOf(r, 16);
        const spanId = bytesOf(r, 8);
        const parent = r() < 0.7 ? bytesOf(r, 8) : undefined;
        const start = 1_760_000_000_000_000_000n + BigInt(Math.floor(r() * 1e9));
        const end = start + BigInt(Math.floor(r() * 1e8));
        const attrs = genAttributes(r);
        const ev = genAttributes(r);
        const flags = Math.floor(r() * 0xffffffff);
        spans.push({
          traceId,
          spanId,
          ...(parent ? { parentSpanId: parent } : {}),
          name: `span-${k}`,
          kind: k % 6,
          startTimeUnixNano: protobuf.util.Long.fromString(start.toString(), true),
          endTimeUnixNano: protobuf.util.Long.fromString(end.toString(), true),
          attributes: attrs.pb,
          events: [{ timeUnixNano: protobuf.util.Long.fromString(start.toString(), true), name: "exception", attributes: ev.pb }],
          links: [{ traceId: bytesOf(r, 16), spanId: bytesOf(r, 8), flags: 1 }],
          status: { code: k % 3, message: "boom" },
          flags,
          futureString: "x",
          futureFixed32: 7,
          futureFixed64: protobuf.util.Long.fromNumber(9, true),
          futureVarint: protobuf.util.Long.fromNumber(300, true),
        });
        spansExpected.push({
          traceId: hexOf(traceId),
          spanId: hexOf(spanId),
          ...(parent ? { parentSpanId: hexOf(parent) } : {}),
          name: `span-${k}`,
          kind: k % 6,
          startTimeUnixNano: start,
          endTimeUnixNano: end,
          attributes: attrs.expected,
          events: [{ name: "exception", timeUnixNano: start, attributes: ev.expected }],
          statusCode: k % 3,
          flags,
        });
      }
      scopes.push({ scope: { name: `io.opentelemetry.s${j}`, version: "2.31.1" }, spans });
      scopesExpected.push({ scope: { name: `io.opentelemetry.s${j}`, version: "2.31.1" }, spans: spansExpected });
    }
    pbResource.push({ resource: { attributes: res.pb }, scopeSpans: scopes });
    expected.push({ resource: res.expected, scopeSpans: scopesExpected });
  }
  const message = Request.fromObject({ resourceSpans: pbResource });
  return { buf: Request.encode(message).finish(), expected };
}

/** Normalise Uint8Array values so toEqual compares bytes, not object identity. */
function plain(v: unknown): unknown {
  if (v instanceof Uint8Array) return { bytes: [...v] };
  if (typeof v === "bigint") return { bigint: v.toString() };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

describe("OTLP protobuf decoder", () => {
  it("matches an independent protobufjs encoding on 300 random requests (all AnyValue kinds, unknown fields, int64 > 2^53)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { buf, expected } = genRequest(seed);
      expect(plain(decodeTraceRequest(buf)), `seed ${seed}`).toEqual(plain(expected));
    }
  });

  it("only ever throws OtlpDecodeError on truncated or random input", () => {
    const { buf } = genRequest(42);
    for (let cut = 1; cut < buf.length; cut += Math.max(1, Math.floor(buf.length / 200))) {
      try {
        decodeTraceRequest(buf.subarray(0, cut));
      } catch (error) {
        expect(error, `cut ${cut}`).toBeInstanceOf(OtlpDecodeError);
      }
    }
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const junk = Uint8Array.from({ length: 1 + Math.floor(r() * 64) }, () => Math.floor(r() * 256));
      try {
        decodeTraceRequest(junk);
      } catch (error) {
        expect(error).toBeInstanceOf(OtlpDecodeError);
      }
    }
  });

  it("rejects overlong varints, lengths beyond the buffer and AnyValue nesting deeper than 8", () => {
    expect(() => decodeTraceRequest(Uint8Array.from([0x08, ...Array(11).fill(0xff), 0x01]))).toThrow(OtlpDecodeError);
    expect(() => decodeTraceRequest(Uint8Array.from([0x0a, 0xff, 0xff, 0x03, 0x00]))).toThrow(/length exceeds buffer/);
    let nested: Record<string, unknown> = { stringValue: "leaf" };
    for (let i = 0; i < 10; i++) nested = { arrayValue: { values: [nested] } };
    const deep = Request.encode(
      Request.fromObject({
        resourceSpans: [{ resource: { attributes: [{ key: "deep", value: nested }] }, scopeSpans: [] }],
      }),
    ).finish();
    expect(() => decodeTraceRequest(deep)).toThrow(/nested too deeply/);
  });

  it("rejects spans without valid ids", () => {
    const bad = Request.encode(Request.fromObject({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: "x", traceId: new Uint8Array(3), spanId: new Uint8Array(8) }] }] }] })).finish();
    expect(() => decodeTraceRequest(bad)).toThrow(OtlpDecodeError);
  });

  it("decodes the OTLP/JSON form to the same spans", () => {
    const { buf } = genRequest(9);
    const fromPb = decodeTraceRequest(buf);
    const json = Request.toObject(Request.decode(buf), { longs: String, bytes: String, defaults: false });
    // OTLP/JSON encodes ids as hex (protobufjs gives base64) and AnyValue int64 as strings.
    const toHex = (b64: string) => Buffer.from(b64, "base64").toString("hex");
    const fix = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(fix);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(o)) {
          if ((k === "traceId" || k === "spanId" || k === "parentSpanId") && typeof x === "string") out[k] = toHex(x);
          else if (k === "bytesValue") continue;
          else out[k] = fix(x);
        }
        return out;
      }
      return v;
    };
    const fromJson = decodeTraceRequestJson(JSON.stringify(fix(json)));
    // bytesValue has no OTLP/JSON test fixture here: drop byte values on both sides.
    const dropBytes = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.filter((x) => !(x && typeof x === "object" && "bytes" in x)).map(dropBytes);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => !(x && typeof x === "object" && "bytes" in x)).map(([k, x]) => [k, dropBytes(x)]));
      return v;
    };
    const strip = (rs: RawResourceSpans[]) => dropBytes(plain(rs));
    expect(strip(fromJson)).toEqual(strip(fromPb));
    expect(() => decodeTraceRequestJson("{not json")).toThrow(OtlpDecodeError);
  });
});
