import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { setVsCodeApiForTesting } from "../src/vscode.js";

// jsdom lacks these; React Flow needs them to mount.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const g = globalThis as Record<string, unknown>;
g.ResizeObserver ??= ResizeObserverStub;
g.DOMMatrixReadOnly ??= class {
  m22 = 1;
  constructor(_transform?: string) {}
};

afterEach(() => {
  cleanup();
  setVsCodeApiForTesting(undefined);
  window.innerWidth = 1024;
});
