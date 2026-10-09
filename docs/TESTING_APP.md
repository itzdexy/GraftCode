# Try Graft 0.6.15

1. Open **Settings → About** and confirm version **0.6.15**. In
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

The tests use isolated profiles and a local mock model endpoint. To run them from
the repository:

```sh
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

Windows packaging: `npm run dist:win`. The packaged smoke tests also check SQLite,
bundled search, the editor, TypeScript language server and a real terminal:

```powershell
$env:GRAFT_PACKAGED_EXE = (Resolve-Path 'dist/win-unpacked/Graft.exe').Path
npx playwright test tests/e2e/packaged.spec.ts
```

Results and limitations for this upgrade are in `UPGRADE_TEST_REPORT.md`.
