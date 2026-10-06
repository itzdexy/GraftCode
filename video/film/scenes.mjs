// The film, scene by scene. Each scene is one take: it sets the stage, starts recording, and
// then acts in time (hold, type, move the camera). See Shoot in film.mjs for what `s` can do.
//
// Camera shots are in the app's own pixels: the point at the middle of the picture, and how
// many screen pixels each app pixel gets. 'wide' is the whole window. The camera never leaves
// the window, so a shot aimed past an edge settles against it.
//
// Two rules keep the tight shots clean. Nothing is cut in half at an edge: a shot either takes
// in the sidebar (262 wide), the header (32 tall) and the bars above the message box, or it
// leaves them out. And a shot is as tight as what it shows, so there is no dead space in it.
//
// The words on screen are the README's own.

const PROMPT = 'The /health endpoint returns 500 when the database is down. Make it report degraded instead, and add a test.';

/** The message box on Code home. */
const homeBox = (s) => s.app.getByRole('textbox', { name: 'Describe a task or ask a question' });

/** Waits until a session's turn has finished. */
const finished = (s, id) => s.until((session) => window.__turns.finished(session) > 0, id);

/**
 * Opens a session that was seeded before the app started. The click is made in the page:
 * this happens before recording, so no pointer needs to travel there.
 */
async function openSession(s, title, message) {
  await s.app.getByRole('navigation').getByText(title, { exact: true }).evaluate((el) => el.click());
  await s.until((text) => document.querySelector('main')?.textContent?.includes(text) === true, message);
  await s.hold(0.6);
}

/** A session that holds one message from the person and is waiting for its turn. */
function seedSession(id, title, text, extra) {
  window.__sessions.seed(id, title, [window.__turns.message(id, 'user', [{ type: 'text', text }], { typed: text })], extra);
}
const seed = (...args) => new Function(`(${seedSession.toString()})(...${JSON.stringify(args)})`);

export const scenes = [
  {
    // The app's own splash, then what Graft is.
    name: 'intro',
    async run(s) {
      await s.stage('intro', 'An open-source coding agent that runs on your own keys.');
      s.record();
      await s.hold(3.25);
      await s.stage('leave');
      await s.hold(0.35);
    }
  },
  {
    // A task from typing it to the report: read, edit, run the tests.
    name: 'code',
    async run(s) {
      await s.open();
      await homeBox(s).focus();
      await s.stage('show', true);
      await s.stage('caption', 'Works in your project.', 'It reads the code, edits files and runs your tests.');
      s.record();
      await s.hold(0.4);
      // In on the message box: from the gap above "Start with" down to the window's edge.
      await s.move({ x: 831, y: 500, zoom: 1.9 }, 1.4);
      await s.hold(0.6);
      await s.type(PROMPT, 0.5);
      await s.hold(0.4);
      await s.press('Enter');
      // Up to where the work appears: the transcript from under the header.
      await s.move({ x: 831, y: 261, zoom: 1.95 }, 0.9);
      await s.hold(1.1);
      await s.move({ x: 831, y: 250, zoom: 2.05 }, 5, 'linear');
      // Back to the whole window as the report comes in, so it lands in full view.
      await s.until(() => document.querySelector('main')?.textContent?.includes('Fixed.') === true);
      await s.hold(0.25);
      await s.move('wide', 1.6);
      await finished(s, 's-4');
      await s.hold(1.5);
    }
  },
  {
    // In Ask mode a command waits for a yes. Then the five modes.
    name: 'ask',
    seed: seed('s-log', 'Add request logging', 'Add structured request logging.', { permissionMode: 'ask' }),
    async run(s) {
      await s.open(1150, 600);
      await openSession(s, 'Add request logging', 'Add structured request logging.');
      await s.stage('show', false);
      await s.stage('caption', 'Asks before it acts.', 'Five permission modes, from approving each edit to running on its own.');
      s.record();
      await s.hold(0.3);
      await s.app.evaluate(() => window.__turns.resume('s-log', 'logging'));
      await s.hold(0.85);
      // In on the request as it rises: everything right of the sidebar, down to the window's edge.
      await s.move({ x: 709, y: 372, zoom: 1.92 }, 1.2);
      await s.until(() => document.querySelector('[role="alertdialog"]') !== null);
      await s.hold(2.0);
      // The pointer starts below the window and comes in over its bottom edge.
      await s.showPointer(1040, 640);
      await s.pointTo(s.app.getByRole('button', { name: /Allow once/ }), 0.65);
      await s.hold(0.1);
      await s.click();
      await s.move('wide', 1.3);
      await finished(s, 's-log');
      await s.hold(0.35);
      await s.pointTo(s.app.getByRole('button', { name: /^Permission mode/ }), 0.7);
      await s.hold(0.1);
      await s.click();
      await s.hold(1.9);
    }
  },
  {
    // A change breaks a test; the project's checks catch it and the agent fixes it.
    name: 'checks',
    seed: seed('s-word', 'Report the database state', 'Make /health say healthy instead of up.'),
    async run(s) {
      await s.open();
      await openSession(s, 'Report the database state', 'Make /health say healthy instead of up.');
      // The transcript and nothing else: from under the header to above the git bar.
      await s.cut({ x: 831, y: 320, zoom: 1.53 });
      await s.stage('show', false);
      await s.stage('caption', 'Checks its own work.', 'Your checks run after every change. A failure goes back to the agent.');
      s.record();
      await s.hold(0.3);
      await s.app.evaluate(() => window.__turns.resume('s-word', 'wording'));
      await finished(s, 's-word');
      await s.hold(1.1);
    }
  },
  {
    // One task run as a group: three readers side by side, an implementer, two reviewers.
    name: 'agents',
    seed: seed('s-rate', 'Rate limit the public API', 'Add rate limiting to the public API.'),
    async run(s) {
      // A window whose main area, from under the header, has the picture's shape: the shot
      // below shows all of it, so the panel is never cut by an edge.
      await s.open(1350, 600);
      await openSession(s, 'Rate limit the public API', 'Add rate limiting to the public API.');
      // The panel's own "Widen panel" button, pressed ahead of time: the graph gets the room.
      const toggle = s.app.getByRole('button', { name: 'Agents', exact: true });
      await toggle.evaluate((el) => el.click());
      await s.hold(0.4);
      await s.app.getByRole('button', { name: 'Widen panel' }).evaluate((el) => el.click());
      await s.hold(0.2);
      await toggle.evaluate((el) => el.click());
      await s.hold(0.5);
      await s.cut({ x: 809, y: 318, zoom: 1.553 });
      await s.stage('show', false);
      await s.stage('caption', 'Splits work between agents.', 'Explorers, an implementer and reviewers, each with its own context and model.');
      s.record();
      await s.hold(0.3);
      await s.app.evaluate(() => window.__turns.resume('s-rate', 'group'));
      await finished(s, 's-rate');
      await s.hold(1.0);
    }
  },
  {
    // Settings → Providers → Add provider: the catalog the app ships with, then a local one.
    name: 'providers',
    async run(s) {
      await s.open(1150, 600);
      await homeBox(s).focus();
      await s.press('Control+Shift+P');
      await s.hold(0.4);
      await s.app.getByRole('combobox', { name: 'Command' }).fill('settings providers');
      await s.hold(0.3);
      await s.press('Enter');
      await s.hold(0.8);
      await s.app.getByRole('button', { name: 'Add provider' }).evaluate((el) => el.click());
      await s.until(() => document.querySelectorAll('[role="listbox"][aria-label="Providers"] [role="option"]').length > 100);
      await s.hold(0.8);
      await s.stage('show', false);
      await s.stage('caption', 'Runs on your keys and your models.', '200+ providers, or models running on your own computer.');
      s.record();
      await s.hold(1.1);
      // Down the list far enough to show how long it is, landing on a row's edge.
      const list = s.app.getByRole('listbox', { name: 'Providers' });
      const distance = await list.evaluate((el) => [...el.querySelectorAll('[role="option"]')].find((row) => row.textContent.startsWith('GMI Cloud')).offsetTop - el.querySelector('[role="option"]').offsetTop);
      await s.scroll(list, distance, 2.6);
      await s.hold(0.5);
      await s.type('ollama', 2.4);
      await s.hold(1.7);
    }
  },
  {
    // The same session in each of the six palettes.
    name: 'palettes',
    async run(s) {
      await s.open();
      await homeBox(s).focus();
      await s.type(PROMPT, 0.2);
      await s.press('Enter');
      await finished(s, 's-4');
      await s.hold(1.5);
      await s.app.evaluate(() => document.activeElement.blur());
      await s.stage('show', false);
      await s.stage('caption', 'Six palettes, light and dark.', 'Graft, Midnight, Slate, Grove, Dune and High contrast, with seven accent colours.');
      s.record();
      await s.hold(0.85);
      for (const [palette, theme] of [['midnight', 'dark'], ['slate', 'dark'], ['grove', 'light'], ['dune', 'light'], ['contrast', 'dark'], ['graft', 'dark']]) {
        await s.app.evaluate(([p, t]) => window.__sessions.setAppearance({ palette: p, theme: t }), [palette, theme]);
        await s.hold(0.5);
      }
      await s.hold(0.35);
    }
  },
  {
    // The name again, what it costs, and where to get it.
    name: 'outro',
    async run(s) {
      await s.stage('outro', 'Free and open source. For Windows, macOS and Linux.', 'github.com/itzdexy/GraftCode');
      s.record();
      await s.hold(4.4);
    }
  }
];
