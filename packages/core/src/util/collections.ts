/** Small shared helpers (avoid copy-on-append group-bys and duplicated path checks). */

export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** `rel` is `dir` itself or inside it (forward-slash relative paths; "" = root). */
export function withinDir(dir: string, rel: string): boolean {
  return dir === "" || rel === dir || rel.startsWith(`${dir}/`);
}

/** Bounded concurrency for async tasks (FIFO hand-off; never exceeds `max`). */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
