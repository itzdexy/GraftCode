import fs from 'node:fs';
import path from 'node:path';
import { firstParagraph, parseFrontmatter } from './frontmatter';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'project' | 'builtin';
  /** What Graft says about a skill it ships, printed after the skill's own line in the prompt; null for every other skill. */
  note: string | null;
}

/**
 * What Graft adds to a skill it ships. The skill's own files are upstream's,
 * unchanged, and written for agents in general: the note says what is
 * different here (the copy can't be written to, the diagram is shown in the
 * conversation, the app makes the picture files).
 */
export const BUILTIN_SKILL_NOTES: Readonly<Record<string, string>> = {
  'diagram-design':
    "Graft's copy of this skill is read-only: never write inside its folder. Save each diagram as its own .html file, in docs/diagrams/ unless the user names a place, and say where it is. Graft shows the file as a diagram in the conversation, so don't paste its markup into your reply. The user makes PNG and SVG copies from the diagram's card: don't run the export scripts unless they ask. The scripts need Python 3; when it isn't installed, skip them and go through the checklist by reading the file. Brand colours and fonts go in a profile, as the skill's profiles.md describes."
};

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
    const name = data.name ?? entry.name;
    skills.push({
      name,
      description: data.description ?? (firstParagraph(body) || 'No description.'),
      path: file,
      scope,
      note: scope === 'builtin' ? (BUILTIN_SKILL_NOTES[name] ?? null) : null
    });
  }
  return skills;
}

/**
 * Skills from the folder Graft ships (`builtinDir`), ~/.graft/skills/<name>/SKILL.md and
 * <project>/.graft/skills/<name>/SKILL.md. On a name clash the project's skill wins, then
 * the user's, then the built-in one.
 */
export function loadSkills(graftHome: string, projectRoot: string | null, builtinDir: string | null): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  if (builtinDir) for (const s of scan(builtinDir, 'builtin')) byName.set(s.name, s);
  for (const s of scan(path.join(graftHome, 'skills'), 'user')) byName.set(s.name, s);
  if (projectRoot) for (const s of scan(path.join(projectRoot, '.graft', 'skills'), 'project')) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The folders whose files an agent reads without asking: a skill is instructions it was told to read. */
export function skillReadRoots(graftHome: string, builtinDir: string | null): string[] {
  return [path.join(graftHome, 'skills'), ...(builtinDir ? [builtinDir] : [])];
}
