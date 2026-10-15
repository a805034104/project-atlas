import { createInterface } from "node:readline/promises";

/**
 * Everything the CLI touches in the outside world, injectable for tests.
 *
 *   stdout  machine output only (JSON with --json, the human report otherwise)
 *   stderr  progress, cost plan, warnings, errors
 *   fetch   the only path to the network (LLM providers); tests pass a fake
 *   ask     y/N prompt; only used when `interactive`
 */

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** stdin and stderr are both TTYs: a y/N prompt can be answered. */
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  fetch: typeof fetch;
}

export function processIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    fetch: globalThis.fetch,
  };
}
