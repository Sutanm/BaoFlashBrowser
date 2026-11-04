# ADR-008：JavaScript使用独立sandbox进程与Host Capability Broker

> 状态：Accepted  
> 日期：2026-08-30

## Context

JavaScript需要原生语言表达力，但不能暴露Node、Electron、raw IPC、filesystem或目标页面上下文。Node `vm`不能作为不可信代码安全边界。

## Decision

脚本运行在可销毁的独立sandboxed renderer process：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、禁止导航并使用严格CSP。唯一出口是schema验证的窄bridge。Main中的Host Capability Broker绑定sandbox/package/entrypoint/run/tab/grant并执行权限、预算和所有权检查。

features、manifest permissions、外部user grant和runtime enforcement分别建模。默认无network/filesystem/clipboard/raw IPC/CDP权限。

## Consequences

- 无限循环可通过销毁sandbox进程终止。
- `bao.*`只是Core facade，不是Electron API包装。
- Phase 7需要恶意脚本、逃逸、资源和grant测试。

## Rejected

- main process中`vm.runInContext`。
- 在目标BrowserView page world执行脚本。
- 直接把preload`electronAPI`暴露给脚本。
