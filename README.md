# texleaf-sync

中文文档: [README.zh-CN.md](README.zh-CN.md)

## Quick Start

### 1. Install the CLI

Node.js 20 or newer is required.

**Automatic Chrome profile discovery and cookie import are available only on
macOS.** On Windows and Linux, enter cookies manually with `texleaf auth login`.

Install from a release URL:

```bash
npm install -g https://github.com/Cang-yan/texleaf-sync/releases/download/v0.1.4/texleaf-sync-0.1.4.tgz
texleaf --version
```

Or install a downloaded release tarball:

```bash
npm install -g ./texleaf-sync-0.1.4.tgz
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
- `4` for **From Chrome** on macOS. This checks both `cstcloud` and `overleaf`
  and saves each valid session automatically.

If Chrome has valid sessions for both platforms, login finishes immediately.
If neither can be imported, the CLI asks you to enter cookies manually and
returns to this menu. If only some are imported, it lists the missing platforms
and offers **Enter cookies manually** (return to this menu) or **Finish**.
macOS may ask for access to the `Chrome Safe Storage` Keychain item. See
[Authentication](#authentication) for profile selection and troubleshooting.

Known-platform sessions are saved under `~/.texleaf/sessions/`. Custom-host
sessions are saved to `.texleaf/session.json` in the current directory unless
`--session-file` is provided.

If you already know the target, `--platform cstcloud`, `--platform overleaf`,
or `--host http://localhost` can skip the selection prompt.

### 3. Clone an Overleaf project

Open the project in Overleaf and copy the project URL:

```text
https://latex.cstcloud.cn/project/67ab12cd34ef567890abcdef
```

Then clone it into a project-named local Git repository:

```bash
cd ~/papers
texleaf clone https://latex.cstcloud.cn/project/67ab12cd34ef567890abcdef
cd PROJECT_NAME_FROM_OVERLEAF
```

`texleaf clone` parses the URL host and project id. These official URLs are
recognized:

```bash
texleaf clone https://latex.cstcloud.cn/project/6a72a92ee92000863e4de8a1
texleaf clone https://www.overleaf.com/project/697aee96f59bdd00852659f7
texleaf clone https://cn.overleaf.com/project/697aee96f59bdd00852659f7
```

The raw project id form still works when you provide the target platform or
host yourself:

```bash
texleaf clone --platform cstcloud 67ab12cd34ef567890abcdef
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

Current version: CLI `0.1.4`.

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

On macOS, `--from-chrome` imports saved cookies from Google Chrome without
copying their values into the terminal:

```bash
texleaf auth login --from-chrome
texleaf auth login --platform cstcloud --from-chrome
texleaf auth login --platform overleaf --from-chrome --chrome-profile "Profile 1"
```

Without `--platform` or `--host`, `--from-chrome` starts the same all-platform
check as the menu option. It saves a separate file for each platform under
`~/.texleaf/sessions/`, honoring `--profile`, and requests the Keychain password
at most once per scan. Use `--session-file` only with an explicit `--platform`
or `--host` for Chrome import. In a noninteractive terminal, an incomplete
all-platform import exits with an error after saving any successful sessions.

The CLI searches `Default` and `Profile N` in Chrome's standard user data
directory. If several profiles contain matching cookies, specify one using
`--chrome-profile "Default"`, `--chrome-profile "Profile 1"`, or an absolute
profile directory path. This is separate from `--profile`, which names the
saved texleaf session.

The importer reads the cookie database in read-only mode, filters by the target
host, expiry, and application path, and excludes partitioned cookies. For known
platforms it imports only the session cookie names listed above. It decrypts
cookies using macOS Keychain and validates the session before saving it with
owner-only permissions. Cookie values are never printed. The encryption format
follows [Chromium's macOS Keychain implementation](https://chromium.googlesource.com/chromium/src/+/main/components/os_crypt/async/browser/keychain_key_provider.mm).

Log in to the target site in Chrome first. Allow `Chrome Safe Storage` access
when macOS prompts. If cookies cannot be found or the database is locked, quit
Chrome and retry so its cookies are flushed to disk. The import is a snapshot;
rerun the command after the session expires. Chrome import currently supports
macOS only and uses the system `sqlite3` and `security` commands. On other systems,
or if Keychain access is denied, use the interactive cookie login below.

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

Before writing, `texleaf push` imports a freshness snapshot and checks it
against the merge base of the current branch and the managed remote branch.
Only when the remote actually has newer Overleaf content does it stage those
changes through Git and stop, so you can review and commit the merge before
trying again. Unpushed local commits alone never block the push.

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
installed with `npm install -g ./texleaf-sync-0.1.4.tgz`.
