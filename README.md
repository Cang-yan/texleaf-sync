# texleaf-sync

`texleaf-sync` is a TypeScript CLI for syncing an Overleaf Community Edition
project with a local Git repository.

The CLI command is `texleaf`, and the project metadata lives under `.texleaf/`
so it can coexist with other tools.

## Install

```bash
npm install
npm run build
npm link
texleaf --version
```

Node.js 20 or newer is required.

## Quick Start

Log in once. For CAS Cloud, the interactive login asks for `latex-session` and
`overleaf.sid`, then stores the session at `~/.texleaf/sessions/cstcloud.json`.

```bash
texleaf auth login
texleaf auth status --platform cstcloud
```

Clone an Overleaf project into a local Git repo:

```bash
cd ~/papers
texleaf clone --platform cstcloud PROJECT_ID
cd PROJECT_NAME
```

Normal edit loop:

```bash
texleaf pull
# edit files
git diff
git add -A
git commit -m "revise paper"
texleaf push --dry-run
texleaf push
```

## Commands

- `texleaf auth login` saves browser cookies for a known platform or custom host.
- `texleaf auth status` validates the saved session.
- `texleaf clone` downloads an Overleaf project into a new Git repository.
- `texleaf pull` imports the latest Overleaf snapshot and merges it through Git.
- `texleaf status` shows local sync state and pending push operations.
- `texleaf verify` compares the latest Overleaf snapshot with the local tree.
- `texleaf push` applies committed local changes back to Overleaf and verifies
  the result.

## Design Notes

The sync model intentionally stays small:

- local Git remains the only merge and conflict layer;
- `texleaf-remote` stores the latest imported Overleaf snapshot;
- `.texleaf/config.json` records project/platform binding;
- known-platform cookies are global under `~/.texleaf/sessions/`;
- push refuses dirty worktrees and unresolved conflicts;
- push performs a freshness pull before writing unless `--dry-run` is used.

For `https://latex.cstcloud.cn`, TLS verification is disabled by default because
that deployment's certificate chain can fail in local CLI websocket clients.

## Configuration

Example `.texleaf/config.json`:

```json
{
  "project": {
    "host": "https://latex.cstcloud.cn",
    "projectId": "PROJECT_ID",
    "projectName": "my-paper",
    "platform": "cstcloud"
  },
  "git": {
    "mainBranch": "main",
    "remoteBranch": "texleaf-remote"
  },
  "auth": {
    "sessionFile": "/Users/you/.texleaf/sessions/cstcloud.json"
  }
}
```

Never commit cookies or files under `.texleaf/`.
