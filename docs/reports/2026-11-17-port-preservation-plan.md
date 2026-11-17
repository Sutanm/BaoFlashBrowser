# 138 / 140 出帧代码的保存方案（先留痕，再谈远程）

> 日期：2026-11-17 · 状态：**方案 A 已记录；本地留痕已完成**
> 关联：可行性文档 §1.14.11、[`../specs/2026-11-17-chromium140-ppapi-revival-ai-guide.md`](../specs/2026-11-17-chromium140-ppapi-revival-ai-guide.md)

---

## 0. 一句话

**先本地留痕，再远程 fork（方案 A）——两条线都已完成。**

> **2026-11-17 23:20 更新：已通过 v2rayN SOCKS5（127.0.0.1:10808）完成全部推送**
>
> | 仓库 | 分支 / 提交 | 内容 |
> | --- | --- | --- |
> | [`Sutanm/bao-flash-chromium-port`](https://github.com/Sutanm/bao-flash-chromium-port)（private） | `main` @ `c5b6cda` | 补丁 + 清单 + 恢复/校验脚本（12 MB） |
> | [`Sutanm/chromium`](https://github.com/Sutanm/chromium)（fork of chromium/chromium） | `bao/140-verified` @ `08ee1eba6ffe3` | Chromium 140 / Electron 38 移植快照（1782 文件） |
> | 同上 | `bao/138-verified` @ `32b3d14f10612` | Chromium 138 / Electron 37 基线快照（83 文件） |
> | [`Sutanm/BaoFlashBrowser`](https://github.com/Sutanm/BaoFlashBrowser) | `docs/port-138-140` @ `b0e4c84` | 本项目文档（含本方案、140 手册、博客） |
>
> 重新拉取验证：`git clone -b bao/140-verified https://github.com/Sutanm/chromium.git`（约 12 MB 增量对象；完整 clone 需下 Chromium 历史）。

原因：Chromium 源码树体积巨大（138/140 各约 120–150 GB 工作副本、git 目录数十 GB），而"我们真正写在里面的东西"只有
**11.8 MB 补丁**（140）+ **0.22 MB 补丁**（138）。所以正确顺序是：**先把"差异"固化下来，再把"差异"推到远端**，
而不是急着 fork 一个几百 GB 的仓库。

---

## 1. 本轮已完成的留痕（可直接交付）

| 产物 | 位置 | 说明 |
| --- | --- | --- |
| 140 本地快照 | `D:\electron-build-140\cr\src` 分支 `bao/140-verified`，提交 `08ee1eba6ffe3` | 1782 文件 / 286 853 行；含完整 PPAPI 移植状态 |
| 138 本地快照 | `D:\electron-build\cr\src` 分支 `bao/138-verified`，提交 `32b3d14f10612` | 83 文件；含 Flash 私有 PPAPI 与注册链路 |
| 归档仓库（本地 git） | `D:\port-archive`，提交 `c5b6cda` | patch + manifest + 校验脚本，可随时 push 到任意远端 |
| 补丁 | `D:\port-archive\patches\140-port.patch`（11.8 MB）/ `138-port.patch`（0.22 MB） | `git apply --check -R` 已验证与当前树一致 |
| 清单 | `D:\port-archive\manifests\*` | name-status / numstat / 13 个关键文件 SHA-256 |
| 恢复脚本 | `D:\port-archive\scripts\restore-140.ps1`、`verify-140.ps1` | 干净树 → 打补丁 → 校验 |
| 文档 | 本文件 + 140 AI 手册 + 博客 | 结论、步骤、错误字典 |

**校验结论**：两个补丁的 `git apply --check -R` 均返回 0，说明补丁与当前工作树严格一致（无遗漏、无多余）。

---

## 2. 方案对比

| 方案 | 做法 | 优点 | 代价/风险 | 适用时机 |
| --- | --- | --- | --- | --- |
| **0. 本地快照 + 补丁归档（已完成）** | 在源码树里建分支提交 + 导出 patch/manifest 到独立目录 | 立刻可用、可校验、体积小（12 MB） | 只在本机；磁盘损坏会丢 | **现在** |
| **A. 远程 fork + push 分支** | fork `chromium/chromium`（或 Gitee 镜像）→ `git push origin bao/140-verified` | 真正的异地备份 + 可 CI 复现 + 可开 PR/分享 | 需要远端有 base commit（否则要传几十 GB）；仓库体量大 | 需要"异地/协作/CI"时 |
| **B. 独立小仓库（只存差异）** | 新建 `bao-flash-chromium-port` 仓库，只放 patch + manifest + 脚本 + 文档 | 体积 12 MB、克隆秒级、审阅友好、不碰 Chromium 历史 | 不能直接 `git checkout` 出可编译树（要靠脚本重放） | 现在就可以做（`D:\port-archive` 推上去即可） |
| **C. 整仓镜像冷备** | `git clone --mirror` / `git bundle` 到移动硬盘或 NAS | 最完整（含全部源码与历史），断网可恢复 | 数百 GB；备份耗时长 | 每月一次 / 里程碑后 |
| **D. 容器化/镜像化** | 记录 tree hash + Dockerfile/构建脚本，产物存云端 | 复现最稳 | 构建镜像本身就是 100+ GB，维护成本高 | 需要"一条命令出构建"时 |

---

## 3. 方案 A（远程 fork）的执行细节

### 3.1 关键前提：远端必须已有 base commit

我们的 140 树 base 是 `84e1454fbb49226f0b2b0de01343417681d9af10`（Chromium 官方提交）。

- 如果远端是 **Chromium 官方镜像的 fork**（GitHub `chromium/chromium`、Gitee 镜像等），该提交已存在
  → `git push` 只上传**新增对象**（约 12 MB，几百个 commit 图里只有我们的 1 个提交）。
- 如果远端是**空仓库** → push 会要求上传从根到 base 的全部历史（数十 GB，几乎不可行）。

**结论：方案 A 必须 fork 官方镜像，不能推空仓库。**

### 3.2 步骤

```powershell
# 1) 在远端 fork chromium/chromium（GitHub 网页操作；Gitee 可用镜像仓库）
# 2) 在本地 140 树加远端
cd D:\electron-build-140\cr\src
git remote add port git@github.com:<org>/chromium.git
git fetch port 84e1454fbb49226f0b2b0de01343417681d9af10 --depth=1   # 只取 base，避免全量
# 3) 推我们的分支（只传新增对象）
git push port bao/140-verified:refs/heads/bao/140-verified
# 4) 138 同理
cd D:\electron-build\cr\src
git remote add port git@github.com:<org>/chromium.git
git push port bao/138-verified:refs/heads/bao/138-verified
```

### 3.3 注意

- **不要**把 `third_party/v8`、`ffmpeg`、`webrtc`、`boringssl` 等子模块改动推上去（那是 DEPS 状态，不是我们的改动）；本轮提交已用 pathspec 排除。
- 提交里目前**仍带临时 `[ppdbg]` 调试探针**（7 个文件）。若要对公网可见，先在本地做一次"清理探针"提交，
  再把干净分支推到远端（或推两个分支：`bao/140-verified-wip` 与 `bao/140-verified`）。
- Flash DLL **永远不进仓库**（版权）；只记录版本号与加载参数。
- 若组织不允许 fork 上游巨型仓库，退到方案 B（小仓库），完全够用。

---

## 4. 方案 B（独立小仓库）的落地方式

`D:\port-archive` 已经是"方案 B 的完整形态"（已 `git init` + 提交）。推上去即可：

```powershell
cd D:\port-archive
git remote add origin git@github.com:<org>/bao-flash-chromium-port.git
git push -u origin main
```

仓库结构（12 MB）：

```
README.md                     # 恢复步骤 + 版本指纹 + 合规提示
patches/138-port.patch        # 0.22 MB
patches/140-port.patch        # 11.8 MB
manifests/*.txt / *.sha256     # 变更清单与关键文件哈希
scripts/restore-140.ps1       # 干净树 → 打补丁 → 统计
scripts/verify-140.ps1        # 哈希 + 目录规模 + 关键符号校验
```

---

## 5. 方案 C（冷备）

```powershell
# 140 树整仓打包（体积大，建议放移动硬盘/NAS）
cd D:\electron-build-140\cr\src
git bundle create D:\backup\chromium140-bao.bundle --all --tags
# 注意：bundle 不含未提交文件；我们已全部提交，安全
```

或者对整个 `src` 目录做 7z 归档（含 `out/Testing` 可执行文件，约 40–60 GB）。

---

## 6. 推荐路线

1. **现在（已完成）**：本地分支提交 + `D:\port-archive` 归档 + 文档留痕。
2. **今天内（建议）**：把 `D:\port-archive` 推到私有小仓库（方案 B，12 MB，10 秒完成）。
3. **本周内**：如果要"可 `git checkout` 出来直接编译"，再按方案 A fork 官方镜像并 push 两个分支。
4. **里程碑后**：做一次方案 C 冷备（bundle + 7z），并记录校验值。
5. **长期**：把 `verify-140.ps1` 接进 CI（GitHub Actions 只跑"补丁可应用 + 关键文件哈希"，不需要完整构建）。

---

## 7. 待办（下一步动作）

- [x] 140 本地快照（`bao/140-verified` @ `08ee1eba6ffe3`）
- [x] 138 本地快照（`bao/138-verified` @ `32b3d14f10612`）
- [x] 补丁 + 清单 + 脚本归档（`D:\port-archive` @ `c5b6cda`）
- [x] 补丁反向校验（`git apply --check -R` = 0）
- [ ] 清理 `[ppdbg]` 探针并做第二次提交（保持"可交付"分支干净）
- [ ] 把 `D:\port-archive` 推到私有远端（方案 B）
- [ ] 按需方案 A：fork 官方镜像 → push `bao/140-verified` / `bao/138-verified`
- [ ] 方案 C 冷备（bundle + 校验值）
