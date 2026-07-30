import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';

interface AddressBarProps {
  url: string;
  isLoading: boolean;
  onNavigate: (url: string) => void;
  zoomPercent: number;
}

const AddressBar = forwardRef<{ focus: () => void }, AddressBarProps>(
  ({ url, isLoading, onNavigate, zoomPercent }, ref) => {
    const [value, setValue] = useState(url);
    const [showZoom, setShowZoom] = useState(true);
    const [zoomDisplay, setZoomDisplay] = useState(100);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      setZoomDisplay(zoomPercent);
      setShowZoom(true);
    }, [zoomPercent]);

    useEffect(() => {
      setValue(url);
    }, [url]);

    useImperativeHandle(ref, () => ({
      focus: () => {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
    }));

    const handleSubmit = () => {
      const trimmed = value.trim();
      if (trimmed) onNavigate(trimmed);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSubmit();
        inputRef.current?.blur();
      }
    };

    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', gap: 6 }}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={"输入网址或搜索..."}
          className="input-text no-drag"
          spellCheck={false}
          autoComplete="off"
        />
        <span
          className="zoom-capsule"
          style={{ opacity: showZoom ? 1 : 0, transition: 'opacity 0.2s' }}
        >
          {zoomDisplay}%
        </span>
      </div>
    );
  },
);

AddressBar.displayName = 'AddressBar';
export default AddressBar;
