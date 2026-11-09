/** 从二次启动命令行里挑出可打开的 URL（P6）。 */
export function findLaunchUrl(argv: string[]): string | null {
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.startsWith('-')) continue;
    try {
      const parsed = new URL(arg);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:') return arg;
    } catch {
      // 不是 URL：跳过（Electron 的 argv 里还有 exe 路径与开关）
    }
  }
  return null;
}
