export function info(message: string): void {
  process.stderr.write(`[texleaf] ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`[texleaf] warning: ${message}\n`);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

export class Progress {
  private lastRendered = "";

  constructor(
    private readonly label: string,
    private readonly total?: number
  ) {
    this.render(0);
  }

  update(value: number): void {
    this.render(value);
  }

  finish(value?: number): void {
    if (value !== undefined) this.render(value);
    const total = value ?? this.total;
    const suffix = total === undefined ? "done" : `done (${formatBytes(total)})`;
    this.write(`${this.label}: ${suffix}\n`);
  }

  cancel(): void {
    this.write(`${this.label}: cancelled\n`);
  }

  private render(value: number): void {
    if (!process.stderr.isTTY) {
      if (!this.lastRendered) {
        this.lastRendered = "started";
        info(`${this.label}...`);
      }
      return;
    }
    const current = formatBytes(value);
    const text =
      this.total && this.total > 0
        ? `${this.label}: ${current}/${formatBytes(this.total)}`
        : `${this.label}: ${current}`;
    this.write(text);
  }

  private write(text: string): void {
    if (process.stderr.isTTY) {
      const padded = text.padEnd(this.lastRendered.length, " ");
      process.stderr.write(`\r[texleaf] ${padded}`);
      if (text.endsWith("\n")) {
        this.lastRendered = "";
      } else {
        this.lastRendered = text;
      }
      return;
    }
    if (text.endsWith("\n")) {
      info(text.trimEnd());
    }
  }
}
