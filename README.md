# Typora Note Sync

基于 Typora Community Plugin 的 Git 笔记同步扩展。当前版本：**0.1.2**。

> **AI 辅助开发项目**：本扩展由作者提出需求，通过 ChatGPT / Codex 辅助编写代码、迭代功能及整理发布文档。

## 功能

- 手动拉取：执行 `git pull --rebase --autostash`。
- 提交并推送：执行 `git add -A`、按需 commit、push；不会自动拉取。
- 支持活动栏按钮、命令面板和快捷键，默认提交并推送快捷键为 `Ctrl+Alt+S`。
- 可选启动时拉取、保存后提交并推送、定时提交并推送；默认均关闭。
- 支持时间戳提交信息和自定义模板，显示操作状态与成功/失败通知。

**同步范围是整个 Git 仓库。** 当前版本不支持只提交某个子目录。启用自动同步前，请检查笔记仓库自己的 `.gitignore`，确认待提交内容。

## 环境要求

manifest 声明：Typora ≥ 1.5.0、Typora Community Plugin ≥ 2.7.7，平台为 Windows / Linux。需要已安装 Git，笔记目录已初始化为 Git 仓库并配置远程地址和身份验证。Linux 兼容性未在本次整理中实机验证。

## 安装与升级

1. 从本仓库 Releases 下载 `typora-note-sync-v0.1.2.zip` 安装包。
2. 关闭 Typora，解压得到固定名称的 `typora-note-sync` 文件夹。
3. Windows 下放入 `%USERPROFILE%\.typora\community-plugins\plugins\`。
4. 确认文件直接位于 `typora-note-sync/main.js`、`manifest.json`、`style.css`，不要重复嵌套目录。
5. 重启 Typora，在 Community Plugin 的已安装插件中启用 Note Sync。

升级时替换上述三个文件。插件 ID 保持为 `local.note-sync`，以兼容已有设置。GitHub 自动提供的 Source code ZIP 是仓库源码快照，安装时请优先使用带版本号的安装包。

## 设置和使用

| 设置 | 说明 |
| --- | --- |
| 仓库路径 | Git 仓库目录；留空使用当前 Typora 笔记文件夹 |
| Git 可执行文件 | 默认 `git`，也可填写完整路径 |
| 远程仓库 / 分支 | 默认 `origin`；分支留空自动检测 |
| 时间戳模式 | 例如 `sync: 2026-09-15 20:30:00` |
| 自定义模板 | 支持 `{date}`、`{time}`、`{datetime}`、`{branch}`、`{files}` |
| 启动时拉取 | 启动约 2.5 秒后仅拉取；兼容旧设置键 `autoSyncOnStart` |
| 保存后延迟 | 默认 5 秒 |
| 定时提交并推送 | 0 表示关闭，其他值为分钟 |

先在设置中点击“测试仓库”，再手动测试“手动拉取”和“立即同步”。远端有新提交导致 push 被拒绝时，先手动拉取，再重新同步。插件会尝试在拉取失败时中止 rebase；出现冲突仍需检查 Git 状态并处理文件。

身份验证由本机 Git 处理。不要把访问令牌写入插件代码或远程 URL。

## 开发与打包

本仓库从已安装的 0.1.2 版本整理，`main.js` 是可直接编辑的发布入口；未包含未找到的原始 TypeScript 工程或历史提交。无需安装 npm 依赖。

在仓库根目录运行 PowerShell：

```powershell
./scripts/package.ps1
```

输出位于 `release/`：安装 ZIP 和 SHA-256 校验文件。ZIP 只包含固定插件目录下的三个运行文件。`release/` 不加入 Git；发布时将 ZIP 和校验文件作为 GitHub Release 附件上传，标签应与 manifest 版本一致。

## 许可

当前未指定开源许可证。
