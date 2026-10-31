// What the Files editor can do beyond typing, each piece of Monaco imported on its own (no language services or
// their workers). The context menu stays out: its Paste needs clipboard reads, which Graft refuses.
// Editing: find and replace, the clipboard, toggle comment (Ctrl+/, Shift+Alt+A), move, copy and delete lines
// (Alt+Up/Down, Shift+Alt+Up/Down, Ctrl+Shift+K), more cursors (Ctrl+Alt+Up/Down, Ctrl+D), word moves and
// deletes, indentation, folding, bracket matching, highlights of the word at the cursor, smart select
// (Shift+Alt+Right/Left), go to the next and previous problem (F8, Shift+F8) and sticky scroll.
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js';
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js';
// What the language server answers through editorProviders.ts: hover (which also shows a problem's message),
// Ctrl+click to the definition and F2 rename.
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/editor/contrib/rename/browser/rename.js';
// Monarch grammars: each registers its file kinds now and loads its rules the first time a file of it opens.
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/scss/register.js';
import 'monaco-editor/languages/definitions/less/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/powershell/register.js';
import 'monaco-editor/languages/definitions/bat/register.js';
import 'monaco-editor/languages/definitions/go/register.js';
import 'monaco-editor/languages/definitions/rust/register.js';
import 'monaco-editor/languages/definitions/java/register.js';
import 'monaco-editor/languages/definitions/kotlin/register.js';
import 'monaco-editor/languages/definitions/cpp/register.js';
import 'monaco-editor/languages/definitions/csharp/register.js';
import 'monaco-editor/languages/definitions/php/register.js';
import 'monaco-editor/languages/definitions/ruby/register.js';
import 'monaco-editor/languages/definitions/sql/register.js';
import 'monaco-editor/languages/definitions/dockerfile/register.js';
import 'monaco-editor/languages/definitions/lua/register.js';
import 'monaco-editor/languages/definitions/swift/register.js';
import 'monaco-editor/languages/definitions/ini/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

// Bundled Vite workers use local URLs allowed by the existing CSP; no CDN/eval is needed.
const editorGlobal = globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker(): Worker } };
editorGlobal.MonacoEnvironment = { getWorker: () => new EditorWorker() };
