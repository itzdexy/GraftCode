# Try Graft 0.6.27

1. Open **Settings → About** and confirm version **0.6.27**. In
   **Appearance → Motion**, choose **On** to see the animations. Choose Reduced
   to verify that controls appear immediately without staggered delays.
2. Select a provider/model and send a simple greeting. A coherent answer checks
   your actual endpoint. If raw model control tokens appear, try a different
   model or correct that endpoint's chat template; the warning preserves the
   original response and its copy button.
3. Open a disposable project in Code. Ask Graft to read a file, propose a small
   change and run the project's checks. Review its permission request and diff.
   Stop a running request and confirm any partial output remains visible.
4. Open **More actions → Files**. Open two text files, choose **Edit file**, edit
   one, and switch tabs. Close the dirty tab and reopen it from **Unsaved drafts**.
   Wait for **Draft backed up on this device**, restart Graft and reopen the
   session: tabs, modes and the draft should return. Ctrl/Cmd+S saves; external
   changes must produce a conflict rather than being silently overwritten.
5. For a trusted TypeScript/JavaScript project, put the cursor on a symbol.
   Use **Check types**, **F12**, **Shift+F12**, and **Symbol info**. Queries use
   the current draft, and references navigate to their actual files/positions.
   In a code session of that project, ask Graft where a function you name is
   defined and who calls it: its steps should read "Found the symbol …" and
   "Looked up the uses at …", and the answer should name the right file and line.
6. In a code session of a trusted TypeScript project with its packages installed,
   ask Graft to make a small change that would not compile (assign a string to a
   number). The edit's row should read "1 problem", list it under the diff, and
   Graft should fix it in its next step. Turn **Settings → Models → Check edits
   for errors** off and repeat: the row has no problems and nothing is listed.
7. In the same session, press the eye under the message box and try **Normal**,
   **Thinking**, **Verbose** and **Summary**. Open a step group and an edit: the
   diff names its file and marks the changed words. Press **Undo** on the
   **Edited files** card of the last turn and check the dialog opens on **Files
   only** and says the conversation stays. Send another message: the card of the
   earlier turn no longer offers Undo.
8. Run `!echo ghp_0123456789abcdefghijklmnopqrstuvwxyz0` (a made-up token): the
   command line and its output show it covered; the eye on the output reveals it.
   Ask Graft to write that token into a file: the approval shows it as it is, and
   afterwards the edit's diff covers it, with an eye in the diff's header.
   Type a few words without sending, restart Graft and reopen the session: the
   words are still in the message box.
9. In **Settings → Permissions**, set **Tokens per turn** to its smallest choice and
   give a code session a task that reads several files. The turn should pause with
   the number it reached and a **Continue** button, and go on when you press it. Set
   it back to **No limit** afterwards.
10. Open **Settings → Usage** after a few requests: today's bar, and a row for each
   model with its requests, tokens and cost.
11. In a chat, type `/`: the commands a chat can use are listed, and `/model` opens the
   model menu.
12. Open **Settings** and type `motion` in **Search settings**: "Motion" is listed with
   its page, Appearance. Press Enter: that page opens with the setting in view and
   marked for a moment. Type something that is nowhere: "No setting matches."
13. In a code session, have the agent run a command that takes a while (`sleep 30`),
    allow it, and end Graft from the task manager while it runs. Start Graft again and
    open the session: a note says what was cut off, and when you write again the agent
    is told the outcome is unknown instead of "not run".
14. In **Customize → Integrations**, open a connected MCP server and set one of its
    tools to **Never**: a call to it is refused without a prompt, in any mode. Add a
    server and look at what it gets from this computer's environment.
15. In a code session, type `/diagram how a request reaches the database` (or anything
    your project has). Graft reads the diagram-design skill without asking, asks before
    it writes the page, and when the turn ends the diagram is shown under its reply.
    Press **Open**: the diagram opens large; try **Zoom in** and **Fit**. **Copy image**
    then paste into another app; **Save as…** once as PNG and once as SVG. This needs a
    capable model: a small one may not follow the skill.
16. In a chat (not incognito), ask for a diagram of something. Its steps read "Read the
    diagram-design skill" and "Created …html", the file is listed under **Files from this
    reply**, and the diagram is drawn below it. **Save as…** offers Downloads.
17. Open **Customize → Skills**: diagram-design is listed as **Built in**, with **Show
    folder** and no Edit or Delete.
18. In a chat, ask for an SVG ("code an SVG of a game controller"). The code streams in a
    block; when the reply ends the block shows the drawing. The button beside **Copy**
    shows the code, and again the drawing.
19. In a chat with web search on, ask Graft to research something. While it searches,
    the line above the steps counts: "Searching 12 websites". When it has read pages,
    the **Sources** card shows a small picture beside each page that offers one (a tile
    shimmers until it loads; a page without one keeps its site icon).
20. With an image model set up (**Settings → Images**), ask for a picture. While it is
    made, a grid of dots stands in for it and a line of dots walks across the grid. The
    finished picture comes into focus; click it for the viewer, and try **+**, **−** and
    **0**. With **Appearance → Motion** set to Reduced the grid holds still and the
    picture just appears.
21. In a code session, ask Graft where something in your project is. A file it names in
    its answer (`src/app.ts:42`) is a link: click it and the Files panel opens that file
    in the editor at that line. A name two files share stays plain. On the **Edited
    files** card of a turn that changed something, press **Open** on a row.
22. Ask for a long file to be shown in a code block and for the command that runs the
    tests. The long block shows its first 20 lines and **Show all … lines**; **Wrap
    lines** wraps it. The one-line command has **Type into the terminal**: the Terminal
    panel opens with the line typed and not run, and Enter runs it.
23. Press **Ctrl+F** on a session's page and type a word the conversation has: the count
    reads "1 of 7", every match is marked, **Enter** and **Shift+Enter** step through
    them and **Esc** closes the bar. With the keyboard in the editor or the terminal,
    Ctrl+F is theirs.
24. Ask a model for the quadratic formula, and for what two things cost in dollars. The
    formula is set as an equation; `$5 and $10` stays as written. A reply with a Mermaid
    block has **Draw this** on it, which asks for the diagram to be drawn.
25. Have Graft change a file, open **Changes** (Ctrl+Shift+D) and its diff. Point at a
    line: a **+** appears in the gutter. Write a comment and press Ctrl+Enter: it sits
    under the line and a bar above the message box reads "1 comment". Type `/cost` and
    send: the comment is still waiting. Send an ordinary message: your message in the
    conversation ends with "Comments on the code:" and the line, and the bar is gone.
    In the editor, select two lines and press **Ctrl+Alt+M**.
26. Press **Ctrl+P** in a code session and type part of a file's name; Enter opens it.
    Type a name and `:12`: the editor opens at line 12. In a trusted TypeScript project
    press **Ctrl+T** and type the start of a function's name.
27. In a trusted TypeScript project, have Graft write something that does not compile and
    open **Changes → Problems**: the error is listed with its line; click it. **Ask Graft
    to fix these** fills the message box and sends nothing. In a project that is not
    trusted the tab says so.
28. Open **Settings** from the account menu while a session is open: it opens as a
    window over the session. Press **Esc**: the session is back as it was. Press
    **Forward**: Settings opens again. In **Shortcuts**, start recording a shortcut and
    press Esc: the recording ends and Settings stays.
29. With **Appearance → Motion** set to **On**, go from a session to **New** and back,
    change the theme, and open and close a panel (Ctrl+Shift+D): pages and themes
    cross-fade, and the panel column slides while the conversation moves aside. Set
    Motion to **Reduced** and do the same: nothing moves, and everything still opens.
30. Give a code session a task with several steps and watch its task list: the mark of a
    task pops when it changes state. With two sessions in the sidebar, send a message in
    the lower one: its row travels to the top.

The tests use isolated profiles and a local mock model endpoint. To run them from
the repository:

```sh
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

`npm run verify:docker` runs the same four and the build in a clean Linux container
(needs Docker). Some faults show on one system only, so a change is checked on both.

Windows packaging: `npm run dist:win`. The packaged smoke tests also check SQLite,
bundled search, the editor, TypeScript language server and a real terminal:

```powershell
$env:GRAFT_PACKAGED_EXE = (Resolve-Path 'dist/win-unpacked/Graft.exe').Path
npx playwright test tests/e2e/packaged.spec.ts
```

Results and limitations for this upgrade are in `UPGRADE_TEST_REPORT.md`.
