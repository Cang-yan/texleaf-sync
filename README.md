# texleaf-sync

中文文档: [README.zh-CN.md](README.zh-CN.md)

## Quick Start

### 1. Install the CLI

Node.js 20 or newer is required.

Install from a release URL:

```bash
npm install -g https://github.com/Cang-yan/texleaf-sync/releases/download/v0.1.1/texleaf-sync-0.1.1.tgz
texleaf --version
```

Or install a downloaded release tarball:

```bash
npm install -g ./texleaf-sync-0.1.1.tgz
texleaf --version
```

Build from source:

```bash
git clone https://github.com/Cang-yan/texleaf-sync.git
cd texleaf-sync
npm install
npm run build
npm link
texleaf --version
```

### 2. Log in once

Run interactive login and choose a target:

```bash
texleaf auth login
```

The prompt offers:

- `1` for `cstcloud`, CAS Cloud Overleaf Community Edition at
  `https://latex.cstcloud.cn`. The interactive login asks for `latex-session`
  and `overleaf.sid`.
- `2` for `overleaf`, `https://www.overleaf.com`. The interactive login asks for
  `overleaf_session2`.
- `3` for a custom Overleaf Community Edition host.

Known-platform sessions are saved under `~/.texleaf/sessions/`. Custom-host
sessions are saved to `.texleaf/session.json` in the current directory unless
`--session-file` is provided.

If you already know the target, `--platform cstcloud`, `--platform overleaf`,
or `--host http://localhost` can skip the selection prompt.

### 3. Clone an Overleaf project

Open the project in Overleaf and copy the ID from the URL:

```text
https://latex.cstcloud.cn/project/67ab12cd34ef567890abcdef
```

Then clone it into a project-named local Git repository:

```bash
cd ~/papers
texleaf clone --platform cstcloud 67ab12cd34ef567890abcdef
cd PROJECT_NAME_FROM_OVERLEAF
```

The compatibility form also works:

```bash
texleaf clone --platform cstcloud --project-id 67ab12cd34ef567890abcdef
```

For a self-hosted Overleaf Community Edition deployment, pass the base URL with
`--host`:

```bash
cd ~/papers
texleaf clone --host http://localhost 67ab12cd34ef567890abcdef
cd PROJECT_NAME_FROM_OVERLEAF
```

If you saved the custom-host session somewhere else, pass the same
`--session-file` to both `auth login` and `clone`.

### 4. Edit, review, and push

```bash
texleaf pull
# if pull staged remote changes:
git diff --cached
git commit -m "overleaf: import latest remote snapshot"

$EDITOR main.tex
git diff
git add -A
git commit -m "revise paper"

texleaf push --dry-run
texleaf push
```

`texleaf push --dry-run` prints the local push plan without writing to
Overleaf. `texleaf push` performs a freshness pull first, refuses dirty
worktrees and unresolved conflicts, then verifies the remote snapshot after
writing.

## What It Does

`texleaf-sync` is a TypeScript CLI for syncing an Overleaf Community Edition
project with a local Git repository.

The CLI command is `texleaf`, and project metadata lives under `.texleaf/` so
it can coexist with other tools. Local Git remains the safety layer: Overleaf
is imported into a managed branch, normal Git review handles conflicts, and
writes back to Overleaf only happen from committed local changes.

## Current Status

Current version: CLI `0.1.1`.

Important commands:

- `texleaf auth login` saves a reusable Overleaf session.
- `texleaf auth status` validates the saved session.
- `texleaf auth logout` deletes a saved session.
- `texleaf clone` downloads an Overleaf project into a new local Git repository.
- `texleaf pull` imports the latest Overleaf snapshot and merges it through Git.
- `texleaf status` shows local sync state and pending push operations.
- `texleaf status --json` prints machine-readable status.
- `texleaf verify` compares the latest Overleaf snapshot with the local tree.
- `texleaf push` applies committed local changes back to Overleaf and verifies
  the result.
- `texleaf push --dry-run` prints the write plan without changing Overleaf.

## Authentication

Known platforms store global sessions under `~/.texleaf/sessions/`:

- `--platform cstcloud` uses `https://latex.cstcloud.cn` and expects
  `latex-session` plus `overleaf.sid`.
- `--platform overleaf` uses `https://www.overleaf.com` and expects
  `overleaf_session2`.

For custom Overleaf Community Edition hosts, pass `--host`. Password login is
usually the simplest path for local Docker and self-hosted deployments; pass
`--email` and let the CLI prompt for the password.

If password login is blocked by SSO, captcha, or another local policy, run
cookie login interactively and paste the browser Cookie header when prompted.
Self-hosted Community Edition deployments commonly use `sharelatex.sid`, but
the exact cookie name can vary with local configuration, so use the browser's
actual Cookie header for that host.

Session cookies grant access to your account: never post them in issues, paste
them into logs, or commit `.texleaf/session.json` or files under
`~/.texleaf/sessions/`.

For `https://latex.cstcloud.cn`, TLS verification is disabled by default because
that deployment's certificate chain can fail in local CLI websocket clients.
Use `--insecure` for another host only when you understand the trust boundary.

## End-to-End Workflow

### Pull the latest remote snapshot

Run `pull` before editing when other people may have changed the online project:

```bash
texleaf pull
```

If remote changes are staged, review and commit them:

```bash
git diff --cached
git commit -m "overleaf: import latest remote snapshot"
```

### Edit locally and commit

```bash
$EDITOR main.tex
git diff
git add -A
git commit -m "revise paper"
```

### Push back to Overleaf

Preview first:

```bash
texleaf push --dry-run
```

Then write:

```bash
texleaf push
```

Before writing, `texleaf push` imports a freshness snapshot and requires the
local branch to still match the managed remote baseline. If newer Overleaf
changes appear, it stages them through Git and stops so you can review and
commit the merge before trying again.

### Check status or verify

```bash
texleaf status
texleaf verify
```

Use `texleaf verify --allow-diff` when you want a zero exit code while still
printing differences.

## Configuration

Example `.texleaf/config.json`:

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

`.texleaf/config.json` records the project/platform binding. The managed
`texleaf-remote` branch stores the latest imported Overleaf snapshot.

Never commit cookies or local sync metadata under `.texleaf/`.

## Development

When working from a linked source checkout, rebuild after source changes so the
global `texleaf` command sees the latest compiled files.

```bash
npm install
npm run build
npm link
npm test
node dist/cli.js --help
```

## Packaging The CLI

To build a distributable npm tarball:

```bash
npm pack
ls -lh texleaf-sync-*.tgz
```

The tarball contains `dist/`, the READMEs, and the license file. It can be
installed with `npm install -g ./texleaf-sync-0.1.1.tgz`.
