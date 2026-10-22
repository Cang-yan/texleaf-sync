import { OverleafBackend, type Entity } from "./backend.js";
import type { TexleafConfig } from "./config.js";
import { TexPageBackend } from "./texpage-backend.js";

export interface ProjectBackend {
  authenticate(): Promise<void>;
  projectName(projectId: string): Promise<string | undefined>;
  projectIdentity?(projectId: string): Promise<{ projectName: string; ownerKey?: string; versionNo?: string }>;
  downloadSnapshot(projectId: string, destDir: string): Promise<void>;
  writeTextFile(projectId: string, projectPath: string, content: string): Promise<void>;
  uploadBinaryFile(projectId: string, projectPath: string, content: Buffer): Promise<void>;
  createFolder(projectId: string, projectPath: string): Promise<Entity>;
  deletePath(projectId: string, projectPath: string): Promise<void>;
  movePath(projectId: string, oldPath: string, newPath: string): Promise<void>;
}

export function createProjectBackend(repoRoot: string, config: TexleafConfig): ProjectBackend {
  return config.project.platform === "texpage"
    ? new TexPageBackend(repoRoot, config)
    : new OverleafBackend(repoRoot, config);
}
