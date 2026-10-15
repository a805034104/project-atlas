import { describe, expect, it } from "vitest";
import { isExcludedFromAI, isHighEntropySecret, redactText } from "../../src/llm/index.js";

describe("isExcludedFromAI", () => {
  it.each([".env", ".env.local", "config/.env.production", "certs/server.pem", "a\\b\\tls.key", "store.p12", "home/id_rsa", "id_rsa.pub", "release.keystore"])(
    "excludes %s",
    (p) => expect(isExcludedFromAI(p)).toBe(true),
  );
  it.each(["README.md", "src/env.ts", "application.yml", "keys.ts", "environment.js"])("keeps %s", (p) =>
    expect(isExcludedFromAI(p)).toBe(false),
  );
});

describe("redactText", () => {
  it("masks credential values in yml, properties, json and source", () => {
    const input = [
      "spring:",
      "  datasource:",
      "    password: s3cr3tP@ss",
      "jwt.secret=abcdefghijklmnop",
      '{"apiKey": "live-key-123", "name": "ok"}',
      'String accessKey = "AK-local-1";',
      "token: ${TOKEN_FROM_ENV}",
      "redis.password=",
      "if (token == null) return;",
      "String token = getToken();",
    ].join("\n");
    const { text, findings } = redactText(input);
    const lines = text.split("\n");
    expect(lines[2]).toBe("    password: «redacted:credential»");
    expect(lines[3]).toBe("jwt.secret=«redacted:credential»");
    expect(lines[4]).toBe('{"apiKey": "«redacted:credential»", "name": "ok"}');
    expect(lines[5]).toBe('String accessKey = "«redacted:credential»";');
    expect(lines[6]).toBe("token: ${TOKEN_FROM_ENV}");
    expect(lines[7]).toBe("redis.password=");
    expect(lines[8]).toBe("if (token == null) return;");
    expect(lines[9]).toBe("String token = getToken();");
    expect(findings).toEqual([
      { kind: "credential", line: 3 },
      { kind: "credential", line: 4 },
      { kind: "credential", line: 5 },
      { kind: "credential", line: 6 },
    ]);
    expect(text).not.toContain("s3cr3tP@ss");
    expect(text).not.toContain("live-key-123");
  });

  it("masks AWS keys, sk- keys and JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = `aws AKIAIOSFODNN7EXAMPLE here\nopenai sk-proj1234567890abcdefXYZ\nAuthorization: Bearer ${jwt}`;
    const { text, findings } = redactText(input);
    expect(text).toContain("aws «redacted:aws-key» here");
    expect(text).toContain("openai «redacted:api-key»");
    expect(text).toContain("Bearer «redacted:jwt»");
    expect(findings.map((f) => f.kind)).toEqual(["aws-key", "api-key", "jwt"]);
  });

  it("replaces PEM blocks but keeps line numbers stable", () => {
    const input = [
      "before",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA1234",
      "abcd",
      "-----END RSA PRIVATE KEY-----",
      "after",
    ].join("\n");
    const { text, findings } = redactText(input);
    expect(text.split("\n")).toHaveLength(6);
    expect(text.split("\n")[1]).toBe("«redacted:pem»");
    expect(text.split("\n")[5]).toBe("after");
    expect(text).not.toContain("MIIEow");
    expect(findings).toEqual([{ kind: "pem", line: 2 }]);
  });

  it("masks high-entropy base64 and hex strings but not identifiers or paths", () => {
    const b64 = "q8Zr2Lx9TfW4mKp7Vb3NcY6dHj1Gs5Ea";
    const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const { text } = redactText(`const blob = ${b64};\nconst digest = ${hex};`);
    expect(text).toContain("const blob = «redacted:high-entropy»;");
    expect(text).toContain("const digest = «redacted:high-entropy»;");

    expect(isHighEntropySecret("AbstractAuthenticationProcessingFilter")).toBe(false);
    expect(isHighEntropySecret("src/main/java/com/ruoyi/system/service")).toBe(false);
    expect(isHighEntropySecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11")).toBe(false);
    const plain = "public class SysUserServiceImpl implements ISysUserService {";
    expect(redactText(plain)).toEqual({ text: plain, findings: [] });
  });
});
