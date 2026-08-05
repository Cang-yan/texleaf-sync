export class TexleafError extends Error {
  constructor(message: string, readonly code = "TEXLEAF_ERROR") {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends TexleafError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
  }
}

export class AuthError extends TexleafError {
  constructor(message: string) {
    super(message, "AUTH_ERROR");
  }
}

export class BackendError extends TexleafError {
  constructor(message: string) {
    super(message, "BACKEND_ERROR");
  }
}

export class GitError extends TexleafError {
  constructor(message: string) {
    super(message, "GIT_ERROR");
  }
}

export class DirtyWorktreeError extends TexleafError {
  constructor(message = "Working tree has uncommitted changes. Commit or stash them, then retry.") {
    super(message, "DIRTY_WORKTREE");
  }
}

export class SyncConflictError extends TexleafError {
  constructor(readonly files: string[]) {
    super(
      [
        "Sync conflict detected.",
        "Conflicted files:",
        ...files.map((file) => `  - ${file}`),
        "",
        "Resolve conflicts locally, commit the result, then run:",
        "  texleaf push"
      ].join("\n"),
      "SYNC_CONFLICT"
    );
  }
}
