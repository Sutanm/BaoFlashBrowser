import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';

interface AddressBarProps {
  url: string;
  isLoading: boolean;
  onNavigate: (url: string) => void;
  onStop: () => void;
  onReload: () => void;
}

const AddressBar = forwardRef<{ focus: () => void }, AddressBarProps>(
  ({ url, isLoading, onNavigate, onStop, onReload }, ref) => {
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
      if (trimmed) {
        onNavigate(trimmed);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSubmit();
        inputRef.current?.blur();
      }
    };

    return (
      <div className="flex items-center gap-1 flex-1">
        {isLoading ? (
          <button
            onClick={onStop}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-sm no-drag"
            title="Stop (Esc)"
          >
            ✕
          </button>
        ) : (
          <button
            onClick={onReload}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-sm no-drag"
            title="Reload (F5)"
          >
            ↻
          </button>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search or enter address"
          className="flex-1 h-7 px-3 text-xs rounded-full bg-gray-100 dark:bg-gray-800 border border-transparent focus:border-blue-400 dark:focus:border-blue-500 outline-none transition-colors text-gray-700 dark:text-gray-200 placeholder-gray-400 no-drag"
          spellCheck={false}
        />
      </div>
    );
  },
);

AddressBar.displayName = 'AddressBar';
export default AddressBar;
