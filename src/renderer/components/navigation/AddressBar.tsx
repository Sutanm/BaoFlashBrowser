import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';

interface AddressBarProps {
  url: string;
  isLoading: boolean;
  onNavigate: (url: string) => void;
}

const AddressBar = forwardRef<{ focus: () => void }, AddressBarProps>(
  ({ url, isLoading, onNavigate }, ref) => {
    const [value, setValue] = useState(url);
    const inputRef = useRef<HTMLInputElement>(null);

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
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入网址或搜索..."
        className="input-text no-drag"
        spellCheck={false}
        autoComplete="off"
      />
    );
  },
);

AddressBar.displayName = 'AddressBar';
export default AddressBar;
