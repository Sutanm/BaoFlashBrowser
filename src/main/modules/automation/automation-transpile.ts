import type { AutomationPackageV3 } from '../../../shared/automation/package-v3';
import { getJsCompiler } from '../js-compiler';

/**
 * 转译 TS 前端脚本。
 *
 * 以前直接用 typescript 包的 transpileModule，会把整个编译器（约 8 MB）
 * 打进主进程 bundle；esbuild 已是运行时依赖（js-compiler 负责 ASAR 路径），
 * 转译能力等价，且只做语法剥离、不做类型检查。
 */
function transpileTypeScript(input: string): string {
  try {
    const result = getJsCompiler().transformSync(input, {
      loader: 'ts',
      target: 'es2019',
      // 对齐 TypeScript 在 target < ES2022 时的默认值，避免 class field
      // 从赋值语义变成 defineProperty 语义。
      tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
    });
    // transpileModule 会为脚本补 "use strict"，esbuild 不会；严格模式影响
    // 顶层 this 与隐式全局赋值，必须保持原有语义。
    return /^\s*['"]use strict['"]/u.test(result.code) ? result.code : `'use strict';\n${result.code}`;
  } catch (error) {
    const details = (error as { errors?: Array<{ text?: string; location?: { line: number; column: number } | null }> }).errors;
    if (!details?.length) throw error;
    const message = details
      .map((item) => `${item.location ? `${item.location.line}:${item.location.column} ` : ''}${item.text ?? 'unknown error'}`)
      .join('\n');
    throw new Error(`TypeScript 编译失败：${message}`);
  }
}

export function runtimePackage(source: AutomationPackageV3): AutomationPackageV3 {
  const typescriptEntries = source.manifest.frontends.scripts.filter((entry) => entry.language === 'typescript' || entry.path.endsWith('.ts'));
  if (!typescriptEntries.length) return source;
  const scripts = new Map(source.scripts);
  for (const entry of typescriptEntries) {
    const input = scripts.get(entry.path); if (input === undefined) continue;
    scripts.set(entry.path, transpileTypeScript(input));
  }
  return clonePackage(source, { scripts });
}

export function clonePackage(source: AutomationPackageV3, patch: Partial<AutomationPackageV3>): AutomationPackageV3 {
  return { ...source, ...patch };
}
