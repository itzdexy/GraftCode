import { describe, expect, it } from 'vitest';
import { textChanges } from '../../../src/renderer/src/features/panels/textChanges';
import { editorLanguageForPath } from '../../../src/renderer/src/lib/highlight';

const apply = (before: string, changes: ReturnType<typeof textChanges>): string =>
  [...changes].reverse().reduce((text, change) => text.slice(0, change.start) + change.text + text.slice(change.end), before);

describe('the editor’s language for a file', () => {
  it('maps file names to the Monarch grammars the editor loads, and leaves the rest plain text', () => {
    const cases: Record<string, string | undefined> = {
      'src/main.ts': 'typescript', 'App.tsx': 'typescript', 'lib/x.mjs': 'javascript', 'View.jsx': 'javascript',
      'package.json': 'javascript', 'tsconfig.jsonc': 'javascript', 'styles/site.css': 'css', 'a.scss': 'scss', 'theme.less': 'less',
      'index.html': 'html', 'icon.svg': 'xml', 'ci.yml': 'yaml', 'deploy.sh': 'shell', 'build.ps1': 'powershell', 'make.cmd': 'bat',
      'main.go': 'go', 'lib.rs': 'rust', 'App.java': 'java', 'build.gradle.kts': 'kotlin', 'util.c': 'c', 'util.h': 'c',
      'engine.cpp': 'cpp', 'engine.hpp': 'cpp', 'Program.cs': 'csharp', 'index.php': 'php', 'Gemfile.rb': 'ruby', 'schema.sql': 'sql',
      'Dockerfile': 'dockerfile', 'init.lua': 'lua', 'App.swift': 'swift', 'setup.ini': 'ini', 'Cargo.toml': 'ini', 'README.md': 'markdown',
      'tool.py': 'python', 'notes.txt': undefined, 'changes.diff': undefined, 'Makefile': undefined
    };
    for (const [file, language] of Object.entries(cases)) expect([file, editorLanguageForPath(file)]).toEqual([file, language]);
  });
});

describe('putting the file on disk into the editor', () => {
  it('changes only the lines that differ, one change per run, and the changes make the new text', () => {
    const before = 'one\ntwo\nthree\nfour\nfive\n';
    const after = 'one\nTWO\nthree\nfour\nfive\nsix\n';
    const changes = textChanges(before, after);
    expect(changes).toEqual([{ start: 4, end: 8, text: 'TWO\n' }, { start: before.length, end: before.length, text: 'six\n' }]);
    expect(apply(before, changes)).toBe(after);
    expect(textChanges(after, after)).toEqual([]);
  });

  it('keeps Windows line breaks and handles a file emptied or written from nothing', () => {
    for (const [before, after] of [['a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\nd'], ['some text\n', ''], ['', 'new file\n'], ['no break', 'no break at all']]) {
      expect(apply(before!, textChanges(before!, after!))).toBe(after);
    }
  });
});
