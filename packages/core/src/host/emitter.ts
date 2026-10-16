/** Minimal event emitter (the shape of vscode.EventEmitter, without vscode). */

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (value: T) => void) => Disposable;

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
