/**
 * Keyboard traversal for graphs (spec Pass 6):
 *   Tab enters the graph (roving tabindex: exactly one node is tabbable),
 *   → follows the first outgoing edge, ← goes back along an incoming edge,
 *   ↓ / ↑ cycle through siblings (other targets of the same caller),
 *   Home jumps to the first node, Enter opens source, Space expands/collapses.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

export interface NavEdge {
  from: string;
  to: string;
}

export interface GraphNavOptions {
  onActivate(id: string): void;
  onToggle?(id: string): void;
  /** Node that should hold the tab stop / receive focus (e.g. a revealed node). */
  focusId?: string | undefined;
}

export interface GraphNav {
  activeId: string | undefined;
  nodeProps(id: string): {
    tabIndex: number;
    ref: (el: HTMLElement | null) => void;
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
    onFocus: () => void;
  };
}

export function useGraphNav(nodeIds: readonly string[], edges: readonly NavEdge[], opts: GraphNavOptions): GraphNav {
  const { out, inc } = useMemo(() => {
    const ids = new Set(nodeIds);
    const out = new Map<string, string[]>();
    const inc = new Map<string, string[]>();
    for (const e of edges) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      const o = out.get(e.from) ?? [];
      if (!o.includes(e.to)) o.push(e.to);
      out.set(e.from, o);
      const i = inc.get(e.to) ?? [];
      if (!i.includes(e.from)) i.push(e.from);
      inc.set(e.to, i);
    }
    return { out, inc };
  }, [nodeIds, edges]);

  const [activeId, setActiveId] = useState<string | undefined>(opts.focusId ?? nodeIds[0]);
  const refs = useRef(new Map<string, HTMLElement>());
  const cameFrom = useRef(new Map<string, string>());
  const pendingFocus = useRef(false);

  // Keep the tab stop on an existing node when the graph changes.
  const current = activeId !== undefined && nodeIds.includes(activeId) ? activeId : nodeIds[0];

  useEffect(() => {
    if (opts.focusId !== undefined && nodeIds.includes(opts.focusId)) setActiveId(opts.focusId);
  }, [opts.focusId, nodeIds]);

  useEffect(() => {
    if (pendingFocus.current && current !== undefined) {
      pendingFocus.current = false;
      refs.current.get(current)?.focus();
    }
  }, [current]);

  const moveTo = useCallback((from: string, to: string | undefined, viaEdge: boolean) => {
    if (to === undefined || to === from) return;
    if (viaEdge) cameFrom.current.set(to, from);
    pendingFocus.current = true;
    setActiveId(to);
    // Focus synchronously too when the element already exists (no re-render needed).
    const el = refs.current.get(to);
    if (el) {
      pendingFocus.current = false;
      el.focus();
    }
  }, []);

  const { onActivate, onToggle } = opts;

  const handleKey = useCallback(
    (id: string, e: KeyboardEvent<HTMLElement>) => {
      const parent = cameFrom.current.get(id) ?? inc.get(id)?.[0];
      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          moveTo(id, out.get(id)?.[0], true);
          break;
        case "ArrowLeft":
          e.preventDefault();
          moveTo(id, parent, false);
          break;
        case "ArrowDown":
        case "ArrowUp": {
          e.preventDefault();
          const siblings = parent !== undefined ? (out.get(parent) ?? []) : [];
          const idx = siblings.indexOf(id);
          if (idx < 0 || siblings.length < 2) break;
          const next = siblings[(idx + (e.key === "ArrowDown" ? 1 : siblings.length - 1)) % siblings.length];
          if (next !== undefined && parent !== undefined) cameFrom.current.set(next, parent);
          moveTo(id, next, false);
          break;
        }
        case "Home":
          e.preventDefault();
          moveTo(id, nodeIds[0], false);
          break;
        case "Enter":
          e.preventDefault();
          onActivate(id);
          break;
        case " ":
        case "Spacebar":
          e.preventDefault();
          onToggle?.(id);
          break;
        default:
          break;
      }
    },
    [inc, out, moveTo, nodeIds, onActivate, onToggle],
  );

  const nodeProps = useCallback(
    (id: string) => ({
      tabIndex: id === current ? 0 : -1,
      ref: (el: HTMLElement | null) => {
        if (el) refs.current.set(id, el);
        else refs.current.delete(id);
      },
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => handleKey(id, e),
      onFocus: () => setActiveId(id),
    }),
    [current, handleKey],
  );

  return { activeId: current, nodeProps };
}
