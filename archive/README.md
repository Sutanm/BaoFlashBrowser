# archive/ — 历史留存，不参与构建与测试

这个目录存放**已从当前实现中退役、但按用户要求保留**的内容。

## 规则

- **不会被任何东西自动读取**。`vitest.config.ts` 的 `include` 是 `tests/**`，
  `esbuild`/`vite` 的入口都在 `src/`，因此这里的内容不参与测试、构建或打包。
- **每个子目录必须自带 README**，说明：它是什么、为什么退役、当时误导过什么、
  真正验证当前实现的东西在哪里。没有说明的归档无法判断能否信任，等于没有归档。
- **不要把归档内容移回 `src/` 或 `tests/`**。退役的理由都写在各自的 README 里，
  移回去会立刻恢复当初的问题。
- 需要复活其中某个测试时，做法是**迁移**到 `tests/` 并改为导入 `src/`，
  而不是原地取消归档（`archive/tests-electron-userscripts-demo/README.md` 里
  `scheduler.test.ts` 就是这样一个先例）。

## 内容

| 目录 | 原位置 | 说明 |
| --- | --- | --- |
| `tests-electron-userscripts-demo/` | `tests/electron/userscripts/` | 用户脚本运行时的移植对照副本。其 `*.test.ts` 因相对导入只验证同目录的冻结副本（`preload/gm-api.ts` 仅为生产源码的 56%），曾在默认 `npm test` 中提供 11 个文件 / 100 项**虚假信心**测试。详见该目录 README。 |
