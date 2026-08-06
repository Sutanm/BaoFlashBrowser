# Userscript Test Fixtures — 来源记录

> 下载日期:2026-08-04  
> 下载方式:GitHub raw 直链(GreasyFork 有 Cloudflare 反爬,403)  
> 用途:仅本地测试(D 系列真实脚本实测集),保留原始元数据与作者信息。

| 文件 | 脚本 | 来源仓库 | 版本 | 大小 | 档位 |
|---|---|---|---|---|---|
| `mpiv.user.js` | Mouseover Popup Image Viewer | https://github.com/tophf/mpiv (raw: `master/script.user.js`) | 1.4.18 | 130KB | A(主样本) |
| `mouse-gestures.user.js` | Greasemonkey Mouse Gestures | https://github.com/hoothin/UserScripts (raw: `master/Mouse Gestures/Mouse Gestures.user.js`) | 0.70 | 16KB | A/B |
| `picviewer-ce.user.js` | Picviewer CE+ | https://github.com/hoothin/UserScripts (raw: `master/Picviewer CE+/Picviewer CE+.user.js`) | 2026.2.6.1 | 376KB | C(压力/复杂度) |
| `switch-zh-simplified-traditional.user.js` | 簡繁轉換 by Ch'ü Tsê-t'ien | https://github.com/hoothin/UserScripts (raw: `master/Switch Traditional Chinese and Simplified Chinese/...`) | — | 105KB | A |
| `gm-config-cn.js` | GM_config CN(picviewer 依赖库) | 同上仓库 `master/Picviewer CE+/GM_config CN.js` | — | 36KB | D1/D6 依赖 |
| `pvcep_rules.js` | Picviewer CE+ 规则库 | 同上仓库 `master/Picviewer CE+/pvcep_rules.js` | — | 75KB | D1/D6 依赖 |
| `pvcep_lang.js` | Picviewer CE+ 语言库 | 同上仓库 `master/Picviewer CE+/pvcep_lang.js` | — | 197KB | D1/D6 依赖 |

## 能力缺口映射(供 D 系列任务参考)

| 脚本要求 | 当前 demo |
|---|---|
| mpiv:GM_addStyle/getValue/setValue/openInTab/menu/xmlhttpRequest/addElement + GM.* 命名空间 | ✅ 已支持 |
| mpiv:GM_download / GM_setClipboard / GM_getValues | ❌ D2/D3 |
| Mouse Gestures:unsafeWindow(scrollTo/history/open/close) | ❌ D5 页世界桥 |
| Picviewer CE+:GM_config 库注入 + 1.2MB 巨型源码 | ❌ D1(@require)+ 体积/解析压力 |
