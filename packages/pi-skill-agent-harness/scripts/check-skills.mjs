// Validates the shipped skills so a broken front matter fails CI.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const skillsDir = resolve(import.meta.dirname, "..", "skills");
const errors = [];

for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(skillsDir, entry.name, "SKILL.md");
  let source;
  try {
    source = readFileSync(file, "utf-8");
  } catch {
    errors.push(`${entry.name}: missing SKILL.md`);
    continue;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  if (!match) {
    errors.push(`${entry.name}: SKILL.md must start with a front matter block`);
    continue;
  }
  const [front] = match;
  const name = /^name:\s*(.+)$/m.exec(front)?.[1].trim();
  const description = /^description:\s*(.+)$/m.exec(front)?.[1].trim();
  if (name !== entry.name)
    errors.push(`${entry.name}: front matter name must match the directory`);
  if (!description)
    errors.push(`${entry.name}: front matter needs a description`);
  if (!source.slice(match[0].length).trim())
    errors.push(`${entry.name}: SKILL.md body is empty`);
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
