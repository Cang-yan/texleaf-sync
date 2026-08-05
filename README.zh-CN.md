# texleaf-sync

## 快速开始

### 1. 安装 CLI

需要 Node.js 20 或更新版本。

从当前仓库安装：

```bash
git clone https://github.com/Cang-yan/texleaf-sync.git
cd texleaf-sync
npm install
npm run build
npm link
texleaf --version
```

`npm link` 会把 `texleaf` 命令暴露到全局，同时保持当前 checkout 可编辑。之后源码有
更新时，再运行一次 `npm run build` 即可。

从 release tarball 安装：

```bash
npm install -g https://github.com/Cang-yan/texleaf-sync/releases/download/v0.1.0/texleaf-sync-0.1.0.tgz
texleaf --version
```

### 2. 登录一次

中科院 CAS Cloud Overleaf Community Edition 内置为 `cstcloud` 平台。交互式登录会
提示输入 `latex-session` 和 `overleaf.sid`，然后把 session 保存到
`~/.texleaf/sessions/cstcloud.json`。

```bash
texleaf auth login --platform cstcloud
texleaf auth status --platform cstcloud
```

也可以把浏览器里复制出来的 Cookie header 通过标准输入传入：

```bash
printf '%s' 'latex-session=...; overleaf.sid=...' | \
  texleaf auth login --platform cstcloud --cookie-stdin
```

### 3. Clone 一个 Overleaf 项目

打开 Overleaf 项目页面，从 URL 里复制项目 ID：

```text
https://latex.cstcloud.cn/project/67ab12cd34ef567890abcdef
```

然后把它下载成一个按项目标题命名的本地 Git 仓库：

```bash
cd ~/papers
texleaf clone --platform cstcloud 67ab12cd34ef567890abcdef
cd PROJECT_NAME_FROM_OVERLEAF
```

兼容旧写法：

```bash
texleaf clone --platform cstcloud --project-id 67ab12cd34ef567890abcdef
```

### 4. 编辑、审查、推送

```bash
texleaf pull
# 如果 pull 暂存了远端变更：
git diff --cached
git commit -m "overleaf: import latest remote snapshot"

$EDITOR main.tex
git diff
git add -A
git commit -m "revise paper"

texleaf push --dry-run
texleaf push
```

`texleaf push --dry-run` 只打印本地推送计划，不写入 Overleaf。`texleaf push` 会先做
freshness pull，拒绝脏工作区和未解决冲突，写入后再重新下载远端快照验证。

## 它做什么

`texleaf-sync` 是一个 TypeScript CLI，用来把 Overleaf Community Edition 项目同步
到本地 Git 仓库。

CLI 命令是 `texleaf`，项目内元数据目录是 `.texleaf/`，可以和其他工具共存。本地
Git 是安全层：Overleaf 会被导入到一个受管理的分支，冲突交给正常 Git 流程处理，
只有已经 commit 的本地改动才会写回 Overleaf。

English: [README.md](README.md)

## 当前状态

当前版本：CLI `0.1.0`。

主要命令：

- `texleaf auth login`：保存已知平台或自定义 host 的浏览器 Cookie。
- `texleaf auth status`：验证已保存 session。
- `texleaf auth logout`：删除已保存 session。
- `texleaf clone`：下载 Overleaf 项目并创建本地 Git 仓库。
- `texleaf pull`：导入最新 Overleaf 快照，并通过 Git 合并。
- `texleaf status`：查看本地同步状态和待推送操作。
- `texleaf status --json`：输出机器可读的状态 JSON。
- `texleaf verify`：下载最新远端快照并与本地目录比较。
- `texleaf push`：把已提交的本地改动写回 Overleaf，并重新验证。
- `texleaf push --dry-run`：只打印写入计划，不修改 Overleaf。

## 认证

已知平台的 session 会全局保存到 `~/.texleaf/sessions/`：

- `--platform cstcloud` 使用 `https://latex.cstcloud.cn`，需要
  `latex-session` 和 `overleaf.sid`。
- `--platform overleaf` 使用 `https://www.overleaf.com`，需要
  `overleaf_session2`。

自定义 Overleaf Community Edition host 可以传 `--host`，并提供完整 Cookie header：

```bash
printf '%s' 'sharelatex.sid=...' | \
  texleaf auth login --host https://overleaf.example.com --cookie-stdin
```

优先使用 `--cookie-stdin` 或交互式输入。Session cookie 代表账号访问权限：不要把它
发到 issue、粘进日志，也不要提交 `.texleaf/session.json` 或
`~/.texleaf/sessions/` 下的文件。

对于 `https://latex.cstcloud.cn`，CLI 默认关闭 TLS 校验，因为该部署在本地 CLI
websocket 客户端中可能出现证书链校验失败。其他 host 只有在明确知道信任边界时才
使用 `--insecure`。

## 完整工作流

### 拉取最新远端快照

如果其他人可能在线改过项目，编辑前先运行：

```bash
texleaf pull
```

如果远端变更被暂存，先审查并提交：

```bash
git diff --cached
git commit -m "overleaf: import latest remote snapshot"
```

### 本地编辑并提交

```bash
$EDITOR main.tex
git diff
git add -A
git commit -m "revise paper"
```

### 推送回 Overleaf

先预览：

```bash
texleaf push --dry-run
```

再写入：

```bash
texleaf push
```

写入前，`texleaf push` 会导入 freshness snapshot，并要求本地分支仍然匹配受管理的
远端基线。如果发现更新的 Overleaf 变更，它会通过 Git 暂存这些变更并停止，等你审查
并提交合并结果后再重试。

### 查看状态或验证

```bash
texleaf status
texleaf verify
```

如果希望发现差异时仍返回 0，可以使用 `texleaf verify --allow-diff`。

## 配置

示例 `.texleaf/config.json`：

```json
{
  "project": {
    "host": "https://latex.cstcloud.cn",
    "projectId": "67ab12cd34ef567890abcdef",
    "projectName": "my-paper",
    "platform": "cstcloud"
  },
  "backend": {
    "timeoutMs": 16000,
    "sslVerify": false
  },
  "git": {
    "mainBranch": "main",
    "remoteBranch": "texleaf-remote"
  },
  "auth": {
    "profile": "default",
    "sessionFile": "/Users/you/.texleaf/sessions/cstcloud.json"
  },
  "sync": {
    "snapshotDir": ".texleaf/snapshots",
    "lockFile": ".texleaf/lock",
    "lastSyncedFile": ".texleaf/last_synced_commit",
    "lastRemoteSnapshotFile": ".texleaf/last_remote_snapshot_commit"
  },
  "ignore": {
    "patterns": [
      ".git/",
      ".gitignore",
      ".env",
      ".texleaf/"
    ]
  }
}
```

`.texleaf/config.json` 记录项目和平台绑定。受管理的 `texleaf-remote` 分支保存最近
一次导入的 Overleaf 快照。

不要提交 Cookie 或 `.texleaf/` 中的本地同步元数据。

## 开发

```bash
npm install
npm run build
npm test
node dist/cli.js --help
```

## 打包 CLI

构建可分发的 npm tarball：

```bash
npm pack
ls -lh texleaf-sync-*.tgz
```

tarball 会包含 `dist/`、README 和 LICENSE，可用
`npm install -g ./texleaf-sync-0.1.0.tgz` 安装。
