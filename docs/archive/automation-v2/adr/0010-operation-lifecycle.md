# ADR-010：RunHandle、取消完成与资源屏障

> 状态：Accepted  
> 日期：2026-08-30

## Context

旧系统active/probe/authoring/cache/timer分散，surface wait在session前不可取消，debug/assistant依赖fire-and-forget status。

## Decision

每次执行先创建Operation/Run owner，再解析target/surface。`start`返回RunHandle；`completion`表达最终结果；`cancel()`返回Promise且只有在所属viewport/CDP/frame/provider/input/timer资源清理后完成。shutdown取消所有owner并等待零live resource。不同调用不得隐式共享Runner；幂等使用显式key。

## Consequences

- status、history、logs绑定RunId。
- surface等待可取消。
- 需要resource registry与zero-live-resource测试。

## Rejected

- cancel只发AbortSignal立即返回。
- 同package/tab自动复用同一个Runner。
