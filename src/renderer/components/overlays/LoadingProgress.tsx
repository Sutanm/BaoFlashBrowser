import React, { useEffect, useRef } from 'react';

interface LoadingProgressProps {
  visible: boolean;
}

const LoadingProgress: React.FC<LoadingProgressProps> = ({ visible }) => {
  const barRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const progressRef = useRef(0);
  const lastTimeRef = useRef(0);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    if (visible) {
      bar.style.transition = 'none';
      bar.style.display = 'block';
      bar.style.width = '0%';
      bar.style.opacity = '1';
      progressRef.current = 0;
      lastTimeRef.current = 0;

      const animate = (timestamp: number) => {
        if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;
        const elapsed = timestamp - lastTimeRef.current;

        // Grow ~25% per second, with slight randomness for natural feel
        const speed = 25 + Math.random() * 10;
        const delta = speed * (elapsed / 1000);
        progressRef.current = Math.min(92, progressRef.current + delta);
        bar.style.width = progressRef.current + '%';

        lastTimeRef.current = timestamp;
        rafRef.current = requestAnimationFrame(animate);
      };

      rafRef.current = requestAnimationFrame(animate);

      return () => {
        cancelAnimationFrame(rafRef.current);
      };
    }
    return undefined;
  }, [visible]);

  const prevVisible = useRef(visible);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    if (prevVisible.current && !visible) {
      cancelAnimationFrame(rafRef.current);

      // Snap to 100% smoothly
      bar.style.transition = 'width 0.3s ease-out';
      bar.style.width = '100%';

      setTimeout(() => {
        bar.style.transition = 'opacity 0.2s ease-out';
        bar.style.opacity = '0';
        setTimeout(() => {
          bar.style.display = 'none';
          bar.style.width = '0%';
          bar.style.transition = 'none';
        }, 200);
      }, 300);
    }

    prevVisible.current = visible;
  }, [visible]);

  return (
    <div ref={barRef} id="loading-progress" />
  );
};

export default LoadingProgress;
