/**
 * The tense of a command's description. A model describes a command the way
 * it would ask for it ("Run the unit tests"); the transcript says what is
 * happening ("Running the unit tests") and then what happened ("Ran the unit
 * tests"). Only verbs listed here change, so a description that opens with
 * anything else stays as written. Pure, so it is unit-tested without a DOM.
 */

/** Verbs whose forms the rules below would get wrong: [under way, done]. */
const IRREGULAR: Record<string, [string, string]> = {
  build: ['Building', 'Built'],
  commit: ['Committing', 'Committed'],
  debug: ['Debugging', 'Debugged'],
  drop: ['Dropping', 'Dropped'],
  find: ['Finding', 'Found'],
  format: ['Formatting', 'Formatted'],
  get: ['Getting', 'Got'],
  grep: ['Grepping', 'Grepped'],
  make: ['Making', 'Made'],
  put: ['Putting', 'Put'],
  read: ['Reading', 'Read'],
  rebuild: ['Rebuilding', 'Rebuilt'],
  rerun: ['Rerunning', 'Reran'],
  reset: ['Resetting', 'Reset'],
  run: ['Running', 'Ran'],
  scan: ['Scanning', 'Scanned'],
  see: ['Seeing', 'Saw'],
  send: ['Sending', 'Sent'],
  set: ['Setting', 'Set'],
  skip: ['Skipping', 'Skipped'],
  stop: ['Stopping', 'Stopped'],
  strip: ['Stripping', 'Stripped'],
  tag: ['Tagging', 'Tagged'],
  take: ['Taking', 'Took'],
  write: ['Writing', 'Wrote'],
  zip: ['Zipping', 'Zipped']
};

/** Verbs that follow the rules: drop a final e before -ing, add -d after it, turn a consonant and y into -ied. */
const REGULAR = new Set(
  (
    'add analyze apply bump capture check clean clone collect compare compile configure confirm convert copy count create delete deploy ' +
    'determine diff disable display download dump enable ensure examine execute extract fetch filter gather generate identify inspect install ' +
    'kill launch lint list load locate look measure merge move open parse print probe publish pull push query record remove rename render ' +
    'reproduce restart restore revert review save search show sort stage start summarize sync tail test trace try typecheck uninstall update ' +
    'upgrade use validate verify view wait watch'
  ).split(' ')
);

/** Words that name a thing as often as an action ("Test results", "Build output", "List of ports")… */
const ALSO_A_THING = new Set(['build', 'count', 'diff', 'dump', 'format', 'lint', 'list', 'query', 'record', 'review', 'scan', 'search', 'set', 'sort', 'test', 'trace']);
/** …which they do when one of these follows. */
const MAKES_IT_A_THING = new Set(['of', 'result', 'results', 'output', 'report', 'summary', 'suite', 'coverage', 'script', 'run', 'runs', 'log', 'logs']);

function forms(verb: string): [string, string] | null {
  const irregular = IRREGULAR[verb];
  if (irregular) return irregular;
  if (!REGULAR.has(verb)) return null;
  const cap = verb.charAt(0).toUpperCase() + verb.slice(1);
  if (cap.endsWith('e')) return [`${cap.slice(0, -1)}ing`, `${cap}d`];
  if (/[^aeiou]y$/.test(cap)) return [`${cap}ing`, `${cap.slice(0, -1)}ied`];
  return [`${cap}ing`, `${cap}ed`];
}

/** "Run the tests" as "Running the tests" (`done` false) or "Ran the tests" (`done` true); unchanged when its first word is no verb listed here. */
export function inTense(description: string, done: boolean): string {
  const match = /^([A-Za-z]+)(?=$|\s)/.exec(description);
  if (!match?.[1]) return description;
  const word = match[1].toLowerCase();
  // "Runs", "Searches" and "Copies" are the same verbs in the third person.
  const verb = [word, word.replace(/s$/, ''), word.replace(/es$/, ''), word.replace(/ies$/, 'y')].find((candidate) => forms(candidate) !== null);
  const found = verb === undefined ? null : forms(verb);
  if (verb === undefined || !found) return description;
  const rest = description.slice(match[1].length);
  const next = /^\s+([A-Za-z]+)/.exec(rest)?.[1]?.toLowerCase();
  if (ALSO_A_THING.has(verb) && next !== undefined && MAKES_IT_A_THING.has(next)) return description;
  return (done ? found[1] : found[0]) + rest;
}
