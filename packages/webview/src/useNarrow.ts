import { useEffect, useState } from "react";

export const NARROW_PX = 600;

/** True when the panel is narrower than 600px (entrypoint list → select, swimlane → vertical). */
export function useNarrow(): boolean {
  const read = () => (typeof window !== "undefined" ? window.innerWidth < NARROW_PX : false);
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    const onResize = () => setNarrow(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return narrow;
}
