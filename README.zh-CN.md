# texleaf-sync

`texleaf-sync` 是一个用 TypeScript 重写的 Overleaf Community Edition 同步 CLI。

CLI 命令是 `texleaf`，项目内元数据目录是 `.texleaf/`，可以和其他工具共存。

## 安装

```bash
npm install
npm run build
npm link
texleaf --version
```

需要 Node.js 20 或更新版本。

## 快速开始

先登录一次。选择中科院 cstcloud 时，交互式登录会提示输入 `latex-session` 和
`overleaf.sid`，然后把 session 保存到 `~/.texleaf/sessions/cstcloud.json`。

```bash
texleaf auth login
texleaf auth status --platform cstcloud
```

把 Overleaf 项目 clone 到本地 Git 仓库：

```bash
cd ~/papers
texleaf clone --platform cstcloud PROJECT_ID
cd PROJECT_NAME
```

日常编辑流程：

```bash
texleaf pull
# 修改文件
git diff
git add -A
git commit -m "revise paper"
texleaf push --dry-run
texleaf push
```

## 命令

- `texleaf auth login`：保存平台或自定义 host 的浏览器 Cookie。
- `texleaf auth status`：验证已保存 session。
- `texleaf clone`：下载 Overleaf 项目并创建本地 Git 仓库。
- `texleaf pull`：导入远端快照，并通过 Git 合并。
- `texleaf status`：查看本地同步状态和待推送操作。
- `texleaf verify`：下载最新远端快照并与本地目录比较。
- `texleaf push`：把已提交的本地改动写回 Overleaf，并重新验证。

## 设计取舍

这一版刻意保持结构简单：

- 本地 Git 仍是唯一的合并和冲突处理层；
- `texleaf-remote` 保存最近一次导入的 Overleaf 快照；
- `.texleaf/config.json` 记录项目和平台绑定；
- 已知平台 Cookie 全局保存到 `~/.texleaf/sessions/`；
- push 会拒绝脏工作区和未解决冲突；
- 除 `--dry-run` 外，push 写入前会先做 freshness pull。

对于 `https://latex.cstcloud.cn`，CLI 默认关闭 TLS 校验，因为该部署在本地 CLI
websocket 客户端中可能出现证书链校验失败。

不要提交 Cookie 或 `.texleaf/` 中的本地元数据。
