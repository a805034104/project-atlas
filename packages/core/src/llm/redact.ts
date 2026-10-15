/**
 * Pre-send redaction (spec「AI 分析流程」step 6, ENG-A21, AC-SEC).
 *
 *   relPath ─▶ isExcludedFromAI? ── yes ─▶ never leaves the machine
 *                    │ no
 *                    ▼
 *   text ─▶ PEM blocks ─▶ per line: credential assignments ─▶ AWS / sk- / JWT
 *        ─▶ high-entropy tokens ─▶ { text with «redacted:kind», findings }
 *
 * Line structure is preserved (a redacted PEM block keeps its newlines) so
 * line numbers cited as evidence stay valid.
 */

export type RedactionKind = "pem" | "credential" | "aws-key" | "api-key" | "jwt" | "high-entropy";

export interface RedactionFinding {
  kind: RedactionKind;
  /** 1-based line number in the original text. */
  line: number;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

const EXCLUDED_BASENAME = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production …
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /^id_rsa/i,
  /\.keystore$/i,
];

export function isExcludedFromAI(relPath: string): boolean {
  const base = relPath.replace(/\\/g, "/").split("/").pop() ?? relPath;
  return EXCLUDED_BASENAME.some((re) => re.test(base));
}

export function marker(kind: RedactionKind): string {
  return `«redacted:${kind}»`;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;

const SECRET_KEY =
  /(password|passwd|secret|token|apikey|api_key|access[_-]?key|private[_-]?key)/i;

/**
 *   key            optional quote, identifier-ish chars containing a secret word
 *   separator      `:` `=` `:=` `=>` (but not `==`)
 *   value          "quoted" | 'quoted' | `quoted` | bare run
 */
const ASSIGNMENT =
  /(["'`]?)([\w.$-]*?(?:password|passwd|secret|token|apikey|api_key|access[_-]?key|private[_-]?key)[\w.-]*)\1(\s*(?::=|=>|:|=(?!=))\s*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`|(\$\{[^}]*\}|[^\s,;#'"`(){}[\]<>]+)(?![^\s,;#'"`(){}[\]<>]|\s*\())/gi;

const BARE_IGNORED = new Set(["null", "nil", "none", "true", "false", "undefined", "''", '""']);

const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const SK_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const CANDIDATE = /[A-Za-z0-9+/=_-]{24,}/g;

export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Base64-ish tokens need > 4.0 bits/char. Hex tops out at exactly 4.0 bits, so
 * hex tokens use > 3.0 bits and length ≥ 32 instead (hashes, hex-encoded keys).
 * Both require letters and digits, which keeps long identifiers and paths out.
 */
export function isHighEntropySecret(token: string): boolean {
  if (token.length < 24) return false;
  if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return false;
  if (/^[0-9a-fA-F]+$/.test(token)) return token.length >= 32 && shannonEntropy(token) > 3.0;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token)) return false;
  return shannonEntropy(token) > 4.0;
}

export function redactText(text: string): RedactionResult {
  const findings: RedactionFinding[] = [];

  // PEM blocks span lines: replace them first, keeping the newline count.
  const withoutPem = text.replace(PEM_BLOCK, (block: string, _label: string, offset: number) => {
    findings.push({ kind: "pem", line: lineAt(text, offset) });
    return marker("pem") + "\n".repeat(countNewlines(block));
  });

  const lines = withoutPem.split("\n");
  const out = lines.map((line, index) => redactLine(line, index + 1, findings));
  findings.sort((a, b) => a.line - b.line);
  return { text: out.join("\n"), findings };
}

/** `scheme://user:pass@host` / `scheme://:pass@host` — credentials in connection URIs (jdbc, redis, mongodb…). */
const URI_USERINFO = /([a-z][\w+.-]*:\/\/)([^\s/@:"'`]*):([^\s/@"'`]+)@/gi;

function redactLine(line: string, lineNo: number, findings: RedactionFinding[]): string {
  let result = line.replace(URI_USERINFO, (whole: string, scheme: string, user: string, pass: string) => {
    if (/^\$\{[^}]*\}$/.test(pass) || pass.startsWith("«redacted:")) return whole;
    findings.push({ kind: "credential", line: lineNo });
    return `${scheme}${user}:${marker("credential")}@`;
  });
  if (SECRET_KEY.test(result)) {
    result = result.replace(
      ASSIGNMENT,
      (
        whole: string,
        quote: string,
        key: string,
        sep: string,
        dq: string | undefined,
        sq: string | undefined,
        bq: string | undefined,
        bare: string | undefined,
      ) => {
        const value = dq ?? sq ?? bq ?? bare ?? "";
        if (value.length === 0) return whole;
        if (bare !== undefined && BARE_IGNORED.has(bare.toLowerCase())) return whole;
        if (/^\$\{[^}]*\}$/.test(value)) return whole; // ${ENV_PLACEHOLDER} carries no secret
        if (value.startsWith("«redacted:")) return whole;
        findings.push({ kind: "credential", line: lineNo });
        const q = dq !== undefined ? '"' : sq !== undefined ? "'" : bq !== undefined ? "`" : "";
        return `${quote}${key}${quote}${sep}${q}${marker("credential")}${q}`;
      },
    );
  }
  result = replaceAll(result, AWS_KEY, "aws-key", lineNo, findings);
  result = replaceAll(result, SK_KEY, "api-key", lineNo, findings);
  result = replaceAll(result, JWT, "jwt", lineNo, findings);
  result = result.replace(CANDIDATE, (token: string) => {
    if (!isHighEntropySecret(token)) return token;
    findings.push({ kind: "high-entropy", line: lineNo });
    return marker("high-entropy");
  });
  return result;
}

function replaceAll(
  line: string,
  pattern: RegExp,
  kind: RedactionKind,
  lineNo: number,
  findings: RedactionFinding[],
): string {
  return line.replace(pattern, () => {
    findings.push({ kind, line: lineNo });
    return marker(kind);
  });
}

function countNewlines(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === "\n") n++;
  return n;
}

function lineAt(text: string, offset: number): number {
  return countNewlines(text.slice(0, offset)) + 1;
}
