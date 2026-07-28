import React, { useEffect, useState } from 'react';

interface ZoomOverlayProps {
  level: number;
  visible: boolean;
}

const ZoomOverlay: React.FC<ZoomOverlayProps> = ({ level, visible }) => {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (visible) {
      setShow(true);
      const t = setTimeout(() => setShow(false), 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [visible, level]);

  if (!show) return null;

  return React.createElement('div', {
    className: 'zoom-indicator',
  }, `${Math.round(level * 100)}%`);
};

export default ZoomOverlay;
