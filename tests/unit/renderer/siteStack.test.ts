import { describe, expect, it } from 'vitest';
import { STACK_CHOICES, stackHint, stackToStart } from '../../../src/renderer/src/features/sites/stack';

describe('what a new site is built with', () => {
  it('is a TypeScript project unless plain was chosen last time', () => {
    expect(stackToStart(null, true)).toBe('react-ts');
    expect(stackToStart('react-ts', true)).toBe('react-ts');
    expect(stackToStart('plain', true)).toBe('plain');
    // Something this version does not know (written by a later one, or by hand) is no choice at all.
    expect(stackToStart('svelte', true)).toBe('react-ts');
  });

  it('is plain on a computer without npm, whatever was chosen before: a project could not be installed there', () => {
    expect(stackToStart(null, false)).toBe('plain');
    expect(stackToStart('react-ts', false)).toBe('plain');
  });

  it('offers the two in that order, by names a person would use', () => {
    expect(STACK_CHOICES.map((c) => [c.value, c.label])).toEqual([
      ['react-ts', 'React + TypeScript'],
      ['plain', 'Plain HTML']
    ]);
  });

  it('says what each one means, and what is missing when a project cannot be built here', () => {
    expect(stackHint('react-ts', true)).toMatch(/components in \.tsx/);
    expect(stackHint('react-ts', true)).toMatch(/asks before it installs packages or builds/);
    expect(stackHint('plain', true)).toMatch(/No build, nothing to install/);
    expect(stackHint('plain', false)).toMatch(/Node\.js/);
    expect(stackHint('plain', false)).toMatch(/nodejs\.org/);
  });
});
