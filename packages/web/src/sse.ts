import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { HostPrompt, HostToWebview } from "@project-atlas/core";

/**
 * Server → browser pushes for one project (Server-Sent Events).
 *
 *   connect ─▶ snapshot (init, runtimeState, analysisState, open prompts) ─▶ live pushes
 *   analysisState: latest wins, at most every 100 ms per hub (progress floods are coalesced)
 *   heartbeat comment every 15 s; `retry: 2000` so the browser reconnects (and gets a snapshot)
 */

const HEARTBEAT_MS = 15_000;
const COALESCE_MS = 100;

export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pendingState: HostToWebview | undefined;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  /** Called when the last client leaves (idle tracking). */
  onEmpty: (() => void) | undefined;

  get size(): number {
    return this.clients.size;
  }

  connect(res: ServerResponse, snapshot: HostToWebview[]): void {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 2000\n\n");
    for (const m of snapshot) write(res, m);
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
      if (this.clients.size === 0) {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        this.onEmpty?.();
      }
    });
    this.heartbeat ??= setInterval(() => {
      for (const c of this.clients) c.write(": ping\n\n");
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  broadcast(message: HostToWebview): void {
    if (message.type === "analysisState") {
      this.pendingState = message;
      this.stateTimer ??= setTimeout(() => {
        this.stateTimer = undefined;
        const m = this.pendingState;
        this.pendingState = undefined;
        if (m) for (const c of this.clients) write(c, m);
      }, COALESCE_MS);
      return;
    }
    // A later state flush must not overtake an earlier terminal message ordering-wise: flush first.
    if (this.pendingState && (message.type === "init" || message.type === "error")) {
      for (const c of this.clients) write(c, this.pendingState);
      this.pendingState = undefined;
    }
    for (const c of this.clients) write(c, message);
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.stateTimer) clearTimeout(this.stateTimer);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}

function write(res: ServerResponse, message: HostToWebview): void {
  // JSON never contains a raw newline, so one data line per event is safe.
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Questions the host logic waits for (AI cost, clone confirmation, service pick, notices with
 * actions), answered from any open tab of the project. Unanswered → undefined after the timeout,
 * which every caller treats as "declined".
 */
export class PromptBroker {
  private readonly open = new Map<string, { prompt: HostPrompt; resolve: (answer: string[] | null) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly hub: EventHub,
    private readonly timeoutMs = 10 * 60_000,
  ) {}

  ask(prompt: DistributiveOmit<HostPrompt, "id">): Promise<string[] | null> {
    const id = randomBytes(9).toString("base64url");
    const full = { ...prompt, id } as HostPrompt;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, null), this.timeoutMs);
      timer.unref?.();
      this.open.set(id, { prompt: full, resolve, timer });
      this.hub.broadcast({ type: "prompt", prompt: full });
    });
  }

  /** A notice nobody has to answer: shown once, not replayed to later tabs. */
  notice(level: "info" | "warning" | "error", message: string): void {
    this.hub.broadcast({ type: "prompt", prompt: { id: randomBytes(9).toString("base64url"), kind: "notify", level, message, actions: [] } });
  }

  answer(id: string, answer: string[] | null): void {
    this.settle(id, Array.isArray(answer) ? answer.filter((a): a is string => typeof a === "string").slice(0, 100) : null);
  }

  /** Prompts still waiting (replayed to a tab that connects later). */
  pending(): HostToWebview[] {
    return [...this.open.values()].map((p) => ({ type: "prompt", prompt: p.prompt }));
  }

  cancelAll(): void {
    for (const id of [...this.open.keys()]) this.settle(id, null);
  }

  private settle(id: string, answer: string[] | null): void {
    const entry = this.open.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.open.delete(id);
    entry.resolve(answer);
    this.hub.broadcast({ type: "promptClosed", id });
  }
}
