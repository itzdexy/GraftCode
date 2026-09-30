import fs from 'node:fs';
import path from 'node:path';
import { firstParagraph, parseFrontmatter } from './frontmatter';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'project';
}

function scan(dir: string, scope: SkillInfo['scope']): SkillInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    skills.push({
      name: data.name ?? entry.name,
      description: data.description ?? (firstParagraph(body) || 'No description.'),
      path: file,
      scope
    });
  }
  return skills;
}

/** Skills from ~/.graft/skills/<name>/SKILL.md and <project>/.graft/skills/<name>/SKILL.md. Project skills win on name clashes. */
export function loadSkills(graftHome: string, projectRoot: string | null): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const s of scan(path.join(graftHome, 'skills'), 'user')) byName.set(s.name, s);
  if (projectRoot) for (const s of scan(path.join(projectRoot, '.graft', 'skills'), 'project')) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
