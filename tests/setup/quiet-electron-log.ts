import log from 'electron-log';

/**
 * 单测环境静音 electron-log 的文件传输。
 *
 * 背景：electron-log 在纯 Node（vitest）下会按 package.json 的 name 解析日志路径，
 * 直接写真实的 `%APPDATA%\bao-flash-browser\logs\main.log`。后果是单测里用 mock 路径
 * 制造的失败（例如 `/mock/password-autofill-key.json.legacy.bak`、假后端的
 * `key unavailable kind=…`）会混进真机日志 —— 2026-09-21 排查密码本问题时就被这类
 * 噪声误导过（把单测的 unwrap 失败当成真机故障）。
 *
 * 只关文件与 console 传输，不影响测试对自身 console 的断言。
 */
try {
  log.transports.file.level = false;
} catch { /* 某些环境下 transport 不可用，忽略 */ }
