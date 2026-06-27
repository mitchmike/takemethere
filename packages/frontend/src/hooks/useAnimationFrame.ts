import { useEffect, useRef } from 'react';

export function useAnimationFrame(callback: (now: number) => void): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    let rafId: number;
    const loop = (now: number) => {
      cbRef.current(now);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);
}
