import { describe, expect, it } from 'vitest';
import { inTense } from '../../../src/renderer/src/features/session/verbs';

describe('a command’s description in the tense that fits', () => {
  it('reads as under way while the command runs and as done afterwards', () => {
    expect(inTense('Run the unit tests', false)).toBe('Running the unit tests');
    expect(inTense('Run the unit tests', true)).toBe('Ran the unit tests');
    expect(inTense('Typecheck the main process', true)).toBe('Typechecked the main process');
    expect(inTense('Show recent history', true)).toBe('Showed recent history');
    expect(inTense('List files in the current folder', false)).toBe('Listing files in the current folder');
    expect(inTense('Install package dependencies', true)).toBe('Installed package dependencies');
  });

  it('knows the verbs that do not simply take -ed', () => {
    expect(inTense('Find the config file', true)).toBe('Found the config file');
    expect(inTense('Build the app', true)).toBe('Built the app');
    expect(inTense('Stop the dev server', false)).toBe('Stopping the dev server');
    expect(inTense('Copy the fixtures', true)).toBe('Copied the fixtures');
    expect(inTense('Verify the output', true)).toBe('Verified the output');
    expect(inTense('Compare both files', false)).toBe('Comparing both files');
    expect(inTense('Format the sources', true)).toBe('Formatted the sources');
    expect(inTense('Read package.json', true)).toBe('Read package.json');
  });

  it('accepts a description written in the third person or in lower case', () => {
    expect(inTense('Runs the unit tests', true)).toBe('Ran the unit tests');
    expect(inTense('Searches for TODO comments', false)).toBe('Searching for TODO comments');
    expect(inTense('check git status', true)).toBe('Checked git status');
  });

  it('leaves a description alone when it does not open with a verb it knows', () => {
    expect(inTense('Final verification', true)).toBe('Final verification');
    expect(inTense('Running the tests', true)).toBe('Running the tests');
    expect(inTense('npm test', true)).toBe('npm test');
    expect(inTense('', false)).toBe('');
    // A word that names a thing here, not an action.
    expect(inTense('Test results for the parser', true)).toBe('Test results for the parser');
    expect(inTense('Build output of the last run', false)).toBe('Build output of the last run');
    expect(inTense('List of open ports', true)).toBe('List of open ports');
    // The whole word has to match: "Runtime" does not open with "Run".
    expect(inTense('Runtime check', true)).toBe('Runtime check');
  });
});
