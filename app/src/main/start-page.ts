import { shellThemes } from '../shared/shell-theme'

const { light, dark } = shellThemes

export const START_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>新标签页</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.55 "Segoe UI", system-ui, sans-serif; }
  body { margin: 0; background: light-dark(${light.colorNeutralBackground2}, ${dark.colorNeutralBackground2}); color: light-dark(${light.colorNeutralForeground1}, ${dark.colorNeutralForeground1}); }
  main { box-sizing: border-box; max-width: 42rem; margin: 0 auto; padding: clamp(2.5rem, 24vh, 12rem) 1.5rem 2.5rem; text-align: center; }
  h1 { margin: 0 0 .5em; font-size: clamp(1.65rem, 5vw, 2.3rem); font-weight: 650; letter-spacing: -.025em; }
  p { margin: 0; color: light-dark(${light.colorNeutralForeground3}, ${dark.colorNeutralForeground3}); }
</style>
<main>
  <h1>BaoFlashBrowser Next</h1>
  <p>在地址栏输入网址开始浏览。</p>
</main>
</html>
`)
