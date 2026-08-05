import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("clone help uses positional project locator", () => {
  const output = execFileSync(process.execPath, ["dist/cli.js", "clone", "--help"], { encoding: "utf8" });
  assert.match(output, /Usage: texleaf clone \[options\] <project> \[directory\]/);
  assert.match(output, /Overleaf project id or project URL/);
  assert.doesNotMatch(output, /--project-id/);
});
