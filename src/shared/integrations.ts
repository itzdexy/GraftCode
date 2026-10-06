/**
 * Integrations: well-known MCP servers Graft can add in one step, from
 * Settings → MCP servers. The launch commands come from each project's own
 * documentation; main resolves them per platform (see main/mcp/integrations.ts),
 * so the renderer only ever names an integration, never a command.
 */

export type IntegrationCategory = 'Game engines and 3D' | 'Design and browser' | 'Developer tools' | 'Reverse engineering';

/** A runtime the server needs on this computer: uv runs Python servers, Node runs npm ones. */
export type IntegrationRuntime = 'uv' | 'node';

export interface IntegrationField {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  /** Kept in the encrypted key store (the settings file only refers to it) and never shown again. */
  secret?: boolean;
  optional?: boolean;
  /** env: an environment variable of a local server; bearer: an `Authorization: Bearer …` header of a remote one. */
  kind: 'env' | 'bearer';
}

export type IntegrationLaunch = { type: 'stdio'; command: string; args: string[] } | { type: 'http'; url: string };

export interface Integration {
  id: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  /** Server name in the MCP settings (tools show as mcp__<name>__<tool>). */
  serverName: string;
  /** Per platform; a missing platform means the app isn't available there. `{LOCALAPPDATA}` is filled in by main. */
  launch: Partial<Record<'win32' | 'darwin' | 'linux', IntegrationLaunch>>;
  runtime?: IntegrationRuntime;
  /** What to do in the other app first, in order. `code` spans are shown as code. */
  steps: string[];
  fields?: IntegrationField[];
  /** The remote server signs in with OAuth on first use. */
  signIn?: boolean;
  /**
   * What to check when the app doesn't answer, or connects without offering
   * tools: usually that the other app is open with its side of the bridge on.
   */
  troubleshoot?: string;
  docs: string;
}

const uvx = (...args: string[]): IntegrationLaunch => ({ type: 'stdio', command: 'uvx', args });
const npx = (...args: string[]): IntegrationLaunch => ({ type: 'stdio', command: 'npx', args: ['-y', ...args] });
const everywhere = (launch: IntegrationLaunch) => ({ win32: launch, darwin: launch, linux: launch });

export const INTEGRATIONS: readonly Integration[] = [
  {
    id: 'blender',
    name: 'Blender',
    category: 'Game engines and 3D',
    description: 'Build and change scenes: objects, materials, lighting and Python scripts in a running Blender.',
    serverName: 'blender',
    troubleshoot: 'Check that Blender is open and its add-on server is running: in the 3D viewport press N, open the MCP tab and start the server.',
    launch: everywhere(uvx('mcp-for-blender')),
    runtime: 'uv',
    steps: [
      'Install the Blender add-on: run `uvx mcp-for-blender install-addon` in a terminal.',
      'In Blender, open Edit → Preferences → Add-ons, search for “MCP for Blender” and turn it on.',
      'In the 3D viewport press `N`, open the MCP for Blender tab and click Start MCP Server.'
    ],
    docs: 'https://github.com/ahujasid/blender-mcp'
  },
  {
    id: 'roblox-studio',
    name: 'Roblox Studio',
    category: 'Game engines and 3D',
    description: 'Explore the place, write and run Luau, and playtest in the Studio you have open.',
    serverName: 'roblox_studio',
    troubleshoot: 'Studio shares its tools only while it is open with Enable Studio as MCP server turned on (Assistant → … → Manage MCP Servers). Studio may also be serving the MCP client of another app; close that one, then click Reconnect.',
    launch: {
      win32: { type: 'stdio', command: 'cmd.exe', args: ['/c', '{LOCALAPPDATA}\\Roblox\\mcp.bat'] },
      darwin: { type: 'stdio', command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', args: [] }
    },
    steps: [
      'Open Roblox Studio and its Assistant panel.',
      'Click … → Manage MCP Servers and turn on Enable Studio as MCP server.',
      'Keep Studio open while Graft works. With several Studio windows open, the agent asks which one to use.'
    ],
    docs: 'https://create.roblox.com/docs/studio/mcp'
  },
  {
    id: 'unity',
    name: 'Unity',
    category: 'Game engines and 3D',
    description: 'Manage scenes, GameObjects, scripts and assets, and read the console of the open Unity Editor.',
    serverName: 'unity',
    troubleshoot: 'Check that the Unity Editor is open and Window → MCP for Unity shows the bridge running.',
    launch: everywhere(uvx('--from', 'mcpforunityserver', 'mcp-for-unity', '--transport', 'stdio')),
    runtime: 'uv',
    steps: [
      'In Unity, open Window → Package Manager, click + → Add package from git URL and paste `https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main`.',
      'Open Window → MCP for Unity and check that the bridge is running.'
    ],
    docs: 'https://coplaydev.github.io/unity-mcp/'
  },
  {
    id: 'godot',
    name: 'Godot',
    category: 'Game engines and 3D',
    description: 'Run and debug Godot projects, read their output, and create scenes and nodes.',
    serverName: 'godot',
    troubleshoot: 'Check that Godot 4 is installed and your project folder is the one the server was set up with.',
    launch: everywhere(npx('@coding-solo/godot-mcp')),
    runtime: 'node',
    steps: ['Install Godot 4. Graft finds it on its own in most setups; if it doesn’t, give the path to the Godot executable below.'],
    fields: [{ key: 'GODOT_PATH', label: 'Godot executable (optional)', placeholder: 'C:\\Godot\\Godot_v4.exe', optional: true, kind: 'env' }],
    docs: 'https://github.com/Coding-Solo/godot-mcp'
  },
  {
    id: 'figma',
    name: 'Figma',
    category: 'Design and browser',
    description: 'Read frames, components and design tokens from the file open in the Figma desktop app.',
    serverName: 'figma',
    troubleshoot: 'Check that the Figma desktop app is open, with the MCP server turned on in its preferences.',
    launch: { win32: { type: 'http', url: 'http://127.0.0.1:3845/mcp' }, darwin: { type: 'http', url: 'http://127.0.0.1:3845/mcp' } },
    steps: [
      'Open the Figma desktop app and a design file.',
      'Switch to Dev Mode (`Shift+D`) and click Enable desktop MCP server in the inspect panel.',
      'Figma’s hosted server only accepts apps it has approved, so Graft uses the desktop server, which needs a Dev or Full seat.'
    ],
    docs: 'https://developers.figma.com/docs/figma-mcp-server/local-server-installation/'
  },
  {
    id: 'playwright',
    name: 'Playwright browser',
    category: 'Design and browser',
    description: 'A real browser the agent can drive: open pages, click, type, read them and take screenshots.',
    serverName: 'playwright',
    launch: everywhere(npx('@playwright/mcp@latest')),
    runtime: 'node',
    steps: ['Nothing to set up: the first start downloads the server and a browser.'],
    docs: 'https://github.com/microsoft/playwright-mcp'
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Developer tools',
    description: 'Issues, pull requests, reviews, code search and Actions runs, beyond what the gh command covers.',
    serverName: 'github',
    launch: everywhere({ type: 'http', url: 'https://api.githubcopilot.com/mcp/' }),
    steps: ['Create a fine-grained personal access token at github.com/settings/personal-access-tokens with access to the repositories Graft should use.'],
    fields: [{ key: 'token', label: 'Personal access token', placeholder: 'github_pat_…', secret: true, kind: 'bearer' }],
    docs: 'https://github.com/github/github-mcp-server'
  },
  {
    id: 'context7',
    name: 'Context7',
    category: 'Developer tools',
    description: 'Current documentation and examples for thousands of libraries, so code follows today’s APIs.',
    serverName: 'context7',
    launch: everywhere({ type: 'http', url: 'https://mcp.context7.com/mcp' }),
    steps: ['Works without a key. A free key from context7.com/dashboard raises the rate limits.'],
    fields: [{ key: 'token', label: 'API key (optional)', secret: true, optional: true, kind: 'bearer' }],
    docs: 'https://context7.com/docs'
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Developer tools',
    description: 'Look into errors and issues from your Sentry projects while you fix them.',
    serverName: 'sentry',
    launch: everywhere({ type: 'http', url: 'https://mcp.sentry.dev/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server to connect your Sentry account.'],
    docs: 'https://docs.sentry.io/product/sentry-mcp/'
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'Developer tools',
    description: 'Find, create and update issues and projects in your Linear workspace.',
    serverName: 'linear',
    launch: everywhere({ type: 'http', url: 'https://mcp.linear.app/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server to connect your Linear workspace.'],
    docs: 'https://linear.app/docs/mcp'
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Developer tools',
    description: 'Search, read and write pages and databases in your Notion workspace.',
    serverName: 'notion',
    launch: everywhere({ type: 'http', url: 'https://mcp.notion.com/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server to connect your Notion workspace.'],
    docs: 'https://developers.notion.com/docs/mcp'
  },
  {
    id: 'ghidra',
    name: 'Ghidra',
    category: 'Reverse engineering',
    description: 'Study compiled programs: import a binary, decompile its functions to C, follow cross-references and call graphs, search strings, and rename things as you learn what they are.',
    serverName: 'ghidra',
    troubleshoot:
      'Check that the folder below is the one Ghidra is installed in (it contains ghidraRun) and that the Java JDK Ghidra asks for is installed. The first start is slow: it downloads the server and starts Ghidra.',
    // The launch from the server's own documentation; it reads where Ghidra is from GHIDRA_INSTALL_DIR.
    launch: everywhere(uvx('pyghidra-mcp', '--transport', 'stdio')),
    runtime: 'uv',
    steps: [
      'Install Ghidra from its releases page, `github.com/NationalSecurityAgency/ghidra/releases`, with the Java JDK that page asks for.',
      'Give the folder Ghidra is installed in below: the one that contains `ghidraRun`.',
      'Ask Graft to import a program and decompile it. Type `/decompile` for the one-function-at-a-time workflow that checks each result.'
    ],
    fields: [{ key: 'GHIDRA_INSTALL_DIR', label: 'Ghidra folder', placeholder: 'C:\\ghidra_PUBLIC', help: 'The folder that contains ghidraRun.', kind: 'env' }],
    docs: 'https://github.com/clearbluejar/pyghidra-mcp'
  }
];

export const INTEGRATION_CATEGORIES: readonly IntegrationCategory[] = ['Game engines and 3D', 'Design and browser', 'Developer tools', 'Reverse engineering'];

/** How to install a runtime, per platform. */
export const RUNTIME_HELP: Record<IntegrationRuntime, { name: string; install: Record<'win32' | 'darwin' | 'linux', string> }> = {
  uv: {
    name: 'uv',
    install: {
      win32: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
      darwin: 'brew install uv',
      linux: 'curl -LsSf https://astral.sh/uv/install.sh | sh'
    }
  },
  node: {
    name: 'Node.js',
    install: { win32: 'winget install OpenJS.NodeJS.LTS', darwin: 'brew install node', linux: 'Install Node.js 18 or later from nodejs.org or your package manager' }
  }
};
