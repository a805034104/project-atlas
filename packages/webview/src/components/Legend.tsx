import { useEffect, useRef } from "react";
import type { Provenance } from "@project-atlas/core";
import { useI18n, type StringKey } from "../i18n.js";

export const PROVENANCE_MARK: Record<Provenance, string> = {
  static: "✓",
  "framework-rule": "⚙",
  "ai-inferred": "✨",
  "runtime-observed": "●",
};

interface Row {
  provenance: Provenance | "branch" | "recursion";
  line: StringKey | null;
  lineClass: string;
  mark: string;
  meaning: StringKey;
}

const ROWS: Row[] = [
  { provenance: "static", line: "legend.lineSolid", lineClass: "edge-static", mark: "✓", meaning: "legend.static" },
  {
    provenance: "framework-rule",
    line: "legend.lineSolid",
    lineClass: "edge-framework-rule",
    mark: "⚙",
    meaning: "legend.frameworkRule",
  },
  {
    provenance: "ai-inferred",
    line: "legend.lineDashed",
    lineClass: "edge-ai-inferred",
    mark: "✨ 72%",
    meaning: "legend.aiInferred",
  },
  {
    provenance: "runtime-observed",
    line: "legend.lineDotted",
    lineClass: "edge-runtime-observed",
    mark: "●",
    meaning: "legend.runtimeObserved",
  },
  { provenance: "branch", line: "legend.lineSolid", lineClass: "edge-static", mark: "×N", meaning: "legend.branch" },
  { provenance: "recursion", line: null, lineClass: "", mark: "↺", meaning: "legend.recursion" },
];

/** Provenance legend (spec Pass 6 table). Redundant encoding: line style + mark, never colour alone. */
export function Legend({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  return (
    <section
      className="legend"
      role="dialog"
      aria-modal="false"
      aria-label={t("legend.title")}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <header>
        <h2>{t("legend.title")}</h2>
        <button ref={closeRef} type="button" className="secondary small" onClick={onClose} aria-label={t("legend.close")}>
          ×
        </button>
      </header>
      <table>
        <thead>
          <tr>
            <th scope="col">{t("legend.colProvenance")}</th>
            <th scope="col">{t("legend.colLine")}</th>
            <th scope="col">{t("legend.colMark")}</th>
            <th scope="col">{t("legend.colMeaning")}</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.provenance} data-provenance={r.provenance}>
              <td className="code">{r.provenance}</td>
              <td>
                {r.line ? (
                  <span className="legend-line">
                    <svg width="40" height="8" aria-hidden="true">
                      <line x1="0" y1="4" x2="40" y2="4" className={`edge-path ${r.lineClass}`} />
                    </svg>
                    {t(r.line)}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className="mark">{r.mark}</td>
              <td>{t(r.meaning)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
