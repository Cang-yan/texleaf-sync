# texleaf-sync

English: [README.md](README.md)

## 快速开始

### 1. 安装 CLI

需要 Node.js 20 或更新版本。

**自动搜索 Chrome 配置并查找、导入 Cookie 的功能仅支持 macOS。**
Windows 和 Linux 请通过 `texleaf auth login` 手动填充 Cookie。

通过 release URL 安装：

```bash
npm install -g https://github.com/Cang-yan/texleaf-sync/releases/download/v0.1.4/texleaf-sync-0.1.4.tgz
texleaf --version
```

或者安装已经下载到本地的 release tarball：

```bash
npm install -g ./texleaf-sync-0.1.4.tgz
texleaf --version
```

从源码构建：

```bash
git clone https://github.com/Cang-yan/texleaf-sync.git
cd texleaf-sync
npm install
npm run build
npm link
texleaf --version
```

### 2. 登录一次

运行交互式登录，然后选择目标：

```bash
texleaf auth login
```

提示中可以选择：

- `1`：`cstcloud`，中科院 CAS Cloud Overleaf Community Edition，
  `https://latex.cstcloud.cn`。交互式登录会提示输入 `latex-session` 和
  `overleaf.sid`。
- `2`：`overleaf`，`https://www.overleaf.com`。交互式登录会提示输入
  `overleaf_session2`。
- `3`：`texpage`，`https://www.texpage.com`。从 Chrome 导入时使用 `SESSIONID` Cookie。
- `4`：自定义 Overleaf Community Edition host。
- `5`：**From Chrome**，仅在 macOS 显示。自动检查 `cstcloud`、`overleaf` 和 `texpage`，
  验证后保存各平台的有效会话。

所有支持的平台都有有效会话时，自动保存并结束。全部无法导入时，提示手动填充并返回此
菜单。部分成功时，先保存成功的平台，列出未导入的平台，再提供“手动填充”
（返回此菜单）和“结束”两个选项。macOS 可能提示授权访问钥匙串中的
`Chrome Safe Storage`。多账号选择和排查方法见[认证](#认证)。

已知平台的 session 会保存到 `~/.texleaf/sessions/`。自定义 host 的 session 默认
保存到当前目录的 `.texleaf/session.json`，除非显式传 `--session-file`。

如果已经知道目标，也可以用 `--platform cstcloud`、`--platform overleaf`、`--platform texpage` 或
`--host http://localhost` 跳过选择提示。

### 3. Clone 一个 Overleaf 项目

打开 Overleaf 项目页面，复制项目 URL：

```text
https://latex.cstcloud.cn/project/67ab12cd34ef567890abcdef
```

然后把它下载成一个按项目标题命名的本地 Git 仓库：

```bash
cd ~/papers
texleaf clone https://latex.cstcloud.cn/project/67ab12cd34ef567890abcdef
cd PROJECT_NAME_FROM_OVERLEAF
```

`texleaf clone` 会从 URL 中解析 host 和 project id。目前这些官方 URL 都能识别：

```bash
texleaf clone https://latex.cstcloud.cn/project/6a72a92ee92000863e4de8a1
texleaf clone https://www.overleaf.com/project/697aee96f59bdd00852659f7
texleaf clone https://cn.overleaf.com/project/697aee96f59bdd00852659f7
texleaf clone https://www.texpage.com/project/user/PROJECT_KEY/VERSION_NO
```

TexPage 项目 URL 同时包含 project key 和当前版本。Clone 会把该版本固定写入
`.texleaf/config.json`；只传 project key 时会从账号项目列表读取当前选中版本。

如果只传 project id，也仍然可以用，但需要自己提供目标平台或 host：

```bash
texleaf clone --platform cstcloud 67ab12cd34ef567890abcdef
```

自部署 Overleaf Community Edition 用 `--host` 传入服务地址：

```bash
cd ~/papers
texleaf clone --host http://localhost 67ab12cd34ef567890abcdef
cd PROJECT_NAME_FROM_OVERLEAF
```

如果自定义 host 的 session 保存在其他位置，`auth login` 和 `clone` 都需要传同一个
`--session-file`。

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

## 当前状态

当前版本：CLI `0.1.4`。

主要命令：

- `texleaf auth login`：保存可复用的 Overleaf session。
- `texleaf auth status`：验证已保存 session。
- `texleaf auth logout`：删除已保存 session。
- `texleaf clone`：下载 Overleaf 项目并创建本地 Git 仓库。
- `texleaf pull`：导入最新 Overleaf 快照，并通过 Git 合并。
- `texleaf status`：查看本地同步状态和待推送操作。
- `texleaf status --json`：输出机器可读的状态 JSON。
- `texleaf verify`：下载最新远端快照并与本地目录比较。
- `texleaf push`：把已提交的本地改动写回 Overleaf，并重新验证。
- `texleaf push --dry-run`：只打印写入计划，不修改 Overleaf。

TexPage 支持项目快照、文本更新，以及新增、替换、移动、重命名和删除文本或二进制文件；
需要时会自动创建父目录。当前 CLI 只同步普通文件和路径，不保留空目录、符号链接或文件权限。
二进制上传使用短期对象存储凭据，不会把 TexPage 会话 Cookie 发送给存储服务。

CLI push 运行期间不要同时在网页端编辑同一 TexPage 项目。两端共用账号操作序号，当前不支持并发编辑。
文本写入要求服务端返回完整 CRDT 历史；若历史不完整，CLI 会在发送操作前拒绝写入。
移动或重命名项目配置的主文件不会同步 TexPage 项目设置；如果编译入口因此不正确，
请在 TexPage 网页端重新选择主文件。一次推送中的远端操作若失败，之前成功的操作可能已经生效；
重试前先拉取或重新 Clone 最新快照。
推送通过验证后，远端快照历史会记录本次上传对应的本地提交，后续 push 不会把已推送的改动再次当作远端新变化。

## 认证

已知平台的 session 会全局保存到 `~/.texleaf/sessions/`：

- `--platform cstcloud` 使用 `https://latex.cstcloud.cn`，需要
  `latex-session` 和 `overleaf.sid`。
- `--platform overleaf` 使用 `https://www.overleaf.com`，需要
  `overleaf_session2`。
- `--platform texpage` 使用 `https://www.texpage.com`，需要 `SESSIONID`。

macOS 上可以用 `--from-chrome` 自动读取 Google Chrome 已保存的 Cookie，无需
在终端粘贴 Cookie 值：

```bash
texleaf auth login --from-chrome
texleaf auth login --platform cstcloud --from-chrome
texleaf auth login --platform overleaf --from-chrome --chrome-profile "Profile 1"
texleaf auth login --platform texpage --from-chrome
```

不指定 `--platform` 或 `--host` 时，`--from-chrome` 会直接开始与菜单相同的全平台
检查。每个平台分别保存到 `~/.texleaf/sessions/`，支持 `--profile`，每轮检查最多
请求一次钥匙串密码。Chrome 导入使用 `--session-file` 时，必须用 `--platform`
或 `--host` 指定单个平台。在非交互环境中，全平台检查会保存成功的会话，并在有
平台未导入时以错误状态退出。

CLI 自动查找 Chrome 默认数据目录中的 `Default` 和 `Profile N`。如果多个配置
都有匹配的 Cookie，用 `--chrome-profile "Default"`、`--chrome-profile "Profile 1"`
或配置目录的绝对路径指定其中一个。它与用于命名 texleaf 会话的 `--profile` 不同。

导入时以只读方式查询 Cookie 数据库，按目标域名、有效期和应用路径筛选，排除分区
Cookie；已知平台只读取上面列出的会话 Cookie。随后通过 macOS 钥匙串解密，验证
登录有效后，才以仅当前用户可读写的权限保存。Cookie 值不会输出到终端。加密格式
依据 [Chromium 的 macOS 钥匙串实现](https://chromium.googlesource.com/chromium/src/+/main/components/os_crypt/async/browser/keychain_key_provider.mm)。

请先在 Chrome 登录目标站点，并在系统提示时允许访问 `Chrome Safe Storage`。
如果找不到 Cookie 或数据库被锁定，退出 Chrome 后重试，以便它将 Cookie 写入磁盘。
导入的是当前会话快照，过期后需要重新运行导入命令。目前自动导入仅支持 macOS，
使用系统自带的 `sqlite3` 和 `security` 命令；其他系统或无法授权钥匙串时，使用下方
的交互式 Cookie 登录方式。

自定义 Overleaf Community Edition host 使用 `--host`。本地 Docker 或自部署服务通常
直接用用户名密码登录最省事；传 `--email` 后，CLI 会提示输入密码。

如果密码登录被 SSO、验证码或本地策略拦住，可以运行交互式 Cookie 登录，并在提示符里
粘贴浏览器 Cookie header。自部署 Community Edition 常见 Cookie 名称是
`sharelatex.sid`，但实际名称可能随本地配置变化：按当前 host 的浏览器 Cookie header
为准。

Session cookie 代表账号访问权限：不要把它发到 issue、粘进日志，也不要提交
`.texleaf/session.json` 或 `~/.texleaf/sessions/` 下的文件。

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

写入前，`texleaf push` 会导入 freshness snapshot，并以当前分支与受管理远端
分支的共同祖先（merge-base）为基准，判断远端是否有新内容。只有远端确实有更新
的 Overleaf 变更时，它才会通过 Git 暂存这些变更并停止，等你审查并提交合并结果
后再重试；本地未推送的提交本身不会阻塞推送。

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

如果使用 `npm link` 链接源码 checkout，源码更新后需要重新构建，才能让全局
`texleaf` 命令使用最新编译结果。

```bash
npm install
npm run build
npm link
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
`npm install -g ./texleaf-sync-0.1.4.tgz` 安装。
