// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ToggleSwitch from '../src/renderer/components/controls/ToggleSwitch';

afterEach(() => cleanup());

describe('ToggleSwitch', () => {
  it('exposes switch state and requests the inverse value on click', () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} label="Feature" onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Feature' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
