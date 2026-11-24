/**
 * 单元层用的 electron 桩。
 *
 * 只提供被导入时就会求值的成员（目前只有 `protocol`），业务代码在单元用例里
 * 不会真的绑定 handler；需要新的成员时再补，保持桩最小。
 */
export const protocol = {
  registerSchemesAsPrivileged: () => undefined,
  handle: () => undefined
}

export const session = {
  fromPartition: () => undefined
}
