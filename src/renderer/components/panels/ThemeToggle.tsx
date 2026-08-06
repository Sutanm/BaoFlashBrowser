import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '@renderer/hooks/useTheme';
import { useI18nContext } from '@renderer/i18n/i18n-react';

interface ThemeToggleProps {
  width?: number;
  height?: number;
}

const skyColorNight = [23, 29, 51];
const skyColorDay = [65, 132, 196];
const moonColor = [194, 201, 211];
const sunColor = [255, 193, 30];

const STAR_PATHS = [
  'M207,0s0,25.11-16.74,41.86S148.45,58.6,148.45,58.6s25.11,0,41.86,16.74S207,117.19,207,117.19s0-25.11,16.74-41.86S265.65,58.6,265.65,58.6s-25.11,0-41.86-16.74S207,0,207,0Z',
  'M631.34,73.48s0,23.92-15.94,39.86-39.86,15.94-39.86,15.94,23.92,0,39.86,15.94,15.94,39.86,15.94,39.86,0-23.92,15.94-39.86,39.86-15.94,39.86-15.94-23.92,0-39.86-15.94S631.34,73.48,631.34,73.48Z',
  'M275.37,203.25s0,19.13-12.76,31.89-31.89,12.76-31.89,12.76,19.13,0,31.89,12.76,12.76,31.89,12.76,31.89,0-19.13,12.76-31.89S320,247.89,320,247.89s-19.13,0-31.89-12.76S275.37,203.25,275.37,203.25Z',
  'M44.65,88.49s0,19.13-12.76,31.89S0,133.13,0,133.13s19.13,0,31.89,12.76,12.76,31.89,12.76,31.89,0-19.13,12.76-31.89,31.89-12.76,31.89-12.76-19.13,0-31.89-12.76S44.65,88.49,44.65,88.49Z',
  'M504.56,333.95s0,19.13-12.76,31.89-31.89,12.76-31.89,12.76,19.13,0,31.89,12.76,12.76,31.89,12.76,31.89,0-19.13,12.76-31.89,31.89-12.76,31.89-12.76-19.13,0-31.89-12.76S504.56,333.95,504.56,333.95Z',
  'M597.85,229.68s0,9.57-6.38,15.94S575.53,252,575.53,252s9.57,0,15.94,6.38,6.38,15.94,6.38,15.94,0-9.57,6.38-15.94S620.18,252,620.18,252s-9.57,0-15.94-6.38S597.85,229.68,597.85,229.68Z',
  'M431.62,88.49s0,9.57-6.38,15.94-15.94,6.38-15.94,6.38,9.57,0,15.94,6.38,6.38,15.94,6.38,15.94,0-9.57,6.38-15.94,15.94-6.38,15.94-6.38-9.57,0-15.94-6.38S431.62,88.49,431.62,88.49Z',
  'M375.94,190.55s0,9.57-6.38,15.94-15.94,6.38-15.94,6.38,9.57,0,15.94,6.38,6.38,15.94,6.38,15.94,0-9.57,6.38-15.94,15.94-6.38,15.94-6.38-9.57,0-15.94-6.38S375.94,190.55,375.94,190.55Z',
  'M85,258.51s0,9.57-6.38,15.94-15.94,6.38-15.94,6.38,9.57,0,15.94,6.38S85,303.15,85,303.15s0-9.57,6.38-15.94,15.94-6.38,15.94-6.38-9.57,0-15.94-6.38S85,258.51,85,258.51Z',
  'M22.32,346s0,9.57-6.38,15.94S0,368.36,0,368.36s9.57,0,15.94,6.38,6.38,15.94,6.38,15.94,0-9.57,6.38-15.94,15.94-6.38,15.94-6.38-9.57,0-15.94-6.38S22.32,346,22.32,346Z',
  'M230.72,378.59s0,9.57-6.38,15.94-15.94,6.38-15.94,6.38,9.57,0,15.94,6.38,6.38,15.94,6.38,15.94,0-9.57,6.38-15.94S253,400.92,253,400.92s-9.57,0-15.94-6.38S230.72,378.59,230.72,378.59Z',
];

const CLOUD_PATH =
  'M0,528S22.93,365.3,142.56,346.54c74.41-11.67,110.66,37.39,110.66,37.39s24.6-33.27,98.88-45.7C433.43,324.62,491.32,362,491.32,362s9-75.47,108.71-89c99.38-13.52,128.37,51,128.37,51s23.67-20.19,54.81-20.73c40.44-.7,67.84,17.42,67.84,17.42s19.19-39.61,59.54-67.78c40.74-28.44,94.41-29.44,94.41-29.44S983.06,116.78,1081.24,49c114.62-79.19,197.66-38.5,197.66-38.5l-64,731.23L53.19,641.56Z';

const CLOUDS = [
  { leftFactor: 0.15, topFactor: -0.2, widthFactor: 2.45, opacityFactor: 0.4 },
  { leftFactor: 0.25, topFactor: 0.2, widthFactor: 2.35, opacityFactor: 1 },
];

function motionMap(x: number): number {
  return x * x * 3 - x * x * x * 2;
}

function lerp(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}

function rgb(a: number, b: number, c: number): string {
  return [Math.round(a), Math.round(b), Math.round(c)].join(',');
}

const ThemeToggle: React.FC<ThemeToggleProps> = ({ width = 200, height = 80 }) => {
  const { theme, themeMode, setThemeMode } = useTheme();
  const { LL } = useI18nContext();

  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number>(0);
  const target = theme === 'dark' ? 1 : 0;

  useEffect(() => {
    function animate() {
      setProgress((prev) => {
        let next = prev;
        if (prev < target) next = Math.min(prev + 0.01, 1);
        else if (prev > target) next = Math.max(prev - 0.01, 0);
        if (next !== target) rafRef.current = requestAnimationFrame(animate);
        return next;
      });
    }
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target]);

  const t = motionMap(progress);
  const isSystem = themeMode === 'system';
  const isDark = theme === 'dark';
  const gap = Math.max(8, Math.round(height * 0.15));
  const dR = height * 0.36;
  const xMax = width - height;

  const tooltip = theme === 'light' ? LL.settings.themeSwitchToDark() : LL.settings.themeSwitchToLight();

  const handleToggle = () => setThemeMode(theme === 'light' ? 'dark' : 'light');
  const handleSystemToggle = () => {
    if (isSystem) setThemeMode(theme);
    else setThemeMode('system');
  };

  const sky = `rgba(${rgb(lerp(skyColorDay[0], skyColorNight[0], t), lerp(skyColorDay[1], skyColorNight[1], t), lerp(skyColorDay[2], skyColorNight[2], t))}, 1)`;

  return (
    <div className="theme-toggle-wrap">
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label={tooltip}
        title={tooltip}
        onClick={handleToggle}
        className="theme-toggle"
        style={{
          width,
          height,
          background: sky,
          borderRadius: height / 2,
          boxShadow: `${height * 0.1}px ${height * 0.1}px ${height * 0.25}px 0 rgba(0, 0, 0, 0.8) inset, ${-height * 0.1}px ${-height * 0.1}px ${height * 0.25}px 0 rgba(0, 0, 0, 0.3) inset, 0 4px 12px rgba(0, 0, 0, 0.2)`,
        }}
      >
        {CLOUDS.map((cloud, i) => (
          <svg
            key={i}
            className="theme-cloud"
            style={{
              left: height * cloud.leftFactor,
              top: height * cloud.topFactor,
              width: height * cloud.widthFactor,
              animationDuration: `${9 + i * 2.5}s`,
              animationDelay: `${i * -2.8}s`,
            }}
            viewBox="0 0 1278.9 741.68"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d={CLOUD_PATH} fill={`rgba(255, 255, 255, ${cloud.opacityFactor * (1 - t)})`} />
          </svg>
        ))}

        <svg
          className="theme-stars"
          style={{
            left: height * 0.25,
            top: height * 0.115 + (1 - t) * -height * 0.85,
            width: height * 1.2,
            opacity: lerp(0.1, 1, t),
          }}
          viewBox="0 0 687.15 423.24"
          xmlns="http://www.w3.org/2000/svg"
        >
          {STAR_PATHS.map((d, i) => (
            <g key={i} className="theme-star" style={{ animationDelay: `${(i % 5) * 0.7}s` }}>
              <path d={d} fill="rgba(255, 255, 255, 1)" />
            </g>
          ))}
        </svg>

        {[height / 2 - gap + dR * 3, height / 2 - gap + dR * 2, height / 2 - gap + dR, height / 2 - gap].map((r, i) => (
          <div
            key={i}
            className={i === 3 ? 'theme-orb' : undefined}
            style={{
              position: 'absolute',
              top: height / 2 - r,
              left: height / 2 - r + xMax * t,
              width: r * 2,
              height: r * 2,
              background: i === 3 ? `rgba(${rgb(lerp(sunColor[0], moonColor[0], t), lerp(sunColor[1], moonColor[1], t), lerp(sunColor[2], moonColor[2], t))}, 1)` : `rgba(255, 255, 255, ${0.2 - t * 0.1})`,
              borderRadius: r,
              boxShadow: i === 3
                ? `${height * 0.05}px ${height * 0.05}px ${height * 0.1}px 0 rgba(0, 0, 0, 0.4), ${height * 0.08}px ${height * 0.08}px ${height * 0.13}px 0 rgba(255, 255, 230, 0.6) inset, ${-height * 0.08}px ${-height * 0.08}px ${height * 0.013}px 0 rgba(0, 0, 0, ${0.2 + t * 0.2}) inset`
                : '',
            }}
          />
        ))}

        <div style={{ position: 'absolute', top: height * 0.4, left: height * 0.22 + xMax * t, width: height * 0.24, height: height * 0.24, background: `rgba(150, 163, 182, ${t})`, border: `${height * 0.015}px solid rgba(120, 120, 120, ${t * 0.5})`, borderRadius: height, boxShadow: `${height * 0.015}px ${height * 0.015}px ${height * 0.065}px 0 rgba(0, 0, 0, ${t * 0.4}) inset, ${-height * 0.015}px ${-height * 0.015}px ${height * 0.065}px 0 rgba(255, 255, 255, ${t * 0.5}) inset` }} />
        <div style={{ position: 'absolute', top: height * 0.23, left: height * 0.46 + xMax * t, width: height * 0.15, height: height * 0.15, background: `rgba(150, 163, 182, ${t})`, border: `${height * 0.015}px solid rgba(120, 120, 120, ${t * 0.5})`, borderRadius: height, boxShadow: `${height / 100}px ${height / 100}px ${height / 25}px 0 rgba(0, 0, 0, ${t * 0.4}) inset, ${-height / 100}px ${-height / 100}px ${height / 25}px 0 rgba(255, 255, 255, ${t * 0.5}) inset` }} />
        <div style={{ position: 'absolute', top: height * 0.55, left: height * 0.55 + xMax * t, width: height * 0.15, height: height * 0.15, background: `rgba(150, 163, 182, ${t})`, border: `${height * 0.015}px solid rgba(120, 120, 120, ${t * 0.5})`, borderRadius: height, boxShadow: `${height / 100}px ${height / 100}px ${height / 25}px 0 rgba(0, 0, 0, ${t * 0.4}) inset, ${-height / 100}px ${-height / 100}px ${height / 25}px 0 rgba(255, 255, 255, ${t * 0.5}) inset` }} />
      </button>

      <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{LL.settings.system()}</span>
        <button
          type="button"
          role="switch"
          aria-checked={isSystem}
          aria-label={LL.settings.system()}
          className={`toggle-switch ${isSystem ? 'on' : ''}`}
          onClick={handleSystemToggle}
        >
          <span className="toggle-knob" />
        </button>
      </div>
    </div>
  );
};

export default ThemeToggle;
