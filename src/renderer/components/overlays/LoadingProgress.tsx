import React, { useEffect, useRef } from 'react';

interface LoadingProgressProps {
  visible: boolean;
}

const LoadingProgress: React.FC<LoadingProgressProps> = ({ visible }) => {
  const barRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    if (visible) {
      bar.style.width = '0%';
      bar.style.opacity = '1';
      bar.style.display = 'block';

      let progress = 0;
      timerRef.current = setInterval(() => {
        progress += Math.random() * 30;
        if (progress > 90) progress = 90;
        bar.style.width = progress + '%';
      }, 200);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      bar.style.width = '100%';
      setTimeout(() => {
        bar.style.opacity = '0';
        setTimeout(() => {
          bar.style.display = 'none';
          bar.style.width = '0%';
        }, 200);
      }, 100);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [visible]);

  return React.createElement('div', {
    ref: barRef as any,
    id: 'loading-progress',
  });
};

export default LoadingProgress;
