import { SITE_STACKS, type SiteStack } from '@shared/schemas/sites';

/** The two things a site can be built with, as the Sites page offers them. */
export const STACK_CHOICES: ReadonlyArray<{ value: SiteStack; label: string; short: string }> = [
  { value: 'react-ts', label: 'React + TypeScript', short: 'TypeScript' },
  { value: 'plain', label: 'Plain HTML', short: 'HTML' }
];

const STACK_KEY = 'graft.sites.stack';

/**
 * What a new site starts as: a TypeScript project, unless plain was chosen last time. Without npm on
 * this computer it is plain whatever was chosen, since a project could not be installed or built.
 */
export function stackToStart(stored: string | null, npm: boolean): SiteStack {
  if (!npm) return 'plain';
  return (SITE_STACKS as readonly string[]).includes(stored ?? '') ? (stored as SiteStack) : 'react-ts';
}

/** One line under the choice: what it means for the site, and for this computer. */
export function stackHint(stack: SiteStack, npm: boolean): string {
  if (!npm) return 'A TypeScript project needs Node.js, which was not found on this computer (nodejs.org has it). Until then sites are plain HTML, CSS and JavaScript.';
  return stack === 'react-ts'
    ? 'A real project: components in .tsx, strict types, styles in modules, a build. Graft asks before it installs packages or builds.'
    : 'HTML, CSS and JavaScript files, served as they are. No build, nothing to install.';
}

/** The choice made last time in this window's storage, if any. */
export function rememberedStack(): string | null {
  try {
    return localStorage.getItem(STACK_KEY);
  } catch {
    // rocky: without storage the choice is not remembered; the default applies.
    return null;
  }
}

export function rememberStack(stack: SiteStack): void {
  try {
    localStorage.setItem(STACK_KEY, stack);
  } catch {
    // rocky: same as above.
  }
}
