/**
 * Integrations: well-known MCP servers Graft can add in one step, from
 * Settings → MCP servers. The launch commands come from each project's own
 * documentation; main resolves them per platform (see main/mcp/integrations.ts),
 * so the renderer only ever names an integration, never a command.
 */

export type IntegrationCategory =
  | 'Game engines, 3D and sound'
  | 'Design and front end'
  | 'Docs and code knowledge'
  | 'Developer tools'
  | 'Cloud, payments and analytics'
  | 'Databases and data'
  | 'Research and the web'
  | 'Plans and notes'
  | 'Memory and reasoning'
  | 'Reverse engineering';

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
  /** Environment a local server always gets, whatever is typed (Zotero's server reads the desktop app's own API only when told to). */
  env?: Record<string, string>;
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
    category: 'Game engines, 3D and sound',
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
    category: 'Game engines, 3D and sound',
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
    category: 'Game engines, 3D and sound',
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
    category: 'Game engines, 3D and sound',
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
    category: 'Design and front end',
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
    category: 'Design and front end',
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
    category: 'Docs and code knowledge',
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
    category: 'Plans and notes',
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
    category: 'Plans and notes',
    description: 'Search, read and write pages and databases in your Notion workspace.',
    serverName: 'notion',
    launch: everywhere({ type: 'http', url: 'https://mcp.notion.com/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server to connect your Notion workspace.'],
    docs: 'https://developers.notion.com/docs/mcp'
  },
  // ---- Game engines, 3D and sound ----
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    category: 'Game engines, 3D and sound',
    description: 'Voices, sound effects and music for games and videos: speak a script, design or clone a voice, transcribe a recording.',
    serverName: 'elevenlabs',
    launch: everywhere(uvx('elevenlabs-mcp')),
    runtime: 'uv',
    steps: ['Create an API key at elevenlabs.io (Profile → API keys) and paste it below. What it makes is paid with your ElevenLabs credits.'],
    fields: [{ key: 'ELEVENLABS_API_KEY', label: 'API key', secret: true, kind: 'env' }],
    docs: 'https://github.com/elevenlabs/elevenlabs-mcp'
  },
  // ---- Design and front end ----
  {
    id: 'figma-files',
    name: 'Figma files',
    category: 'Design and front end',
    description: 'Read any Figma file you have a link to (frames, layout, styles and images) with a personal access token. No Dev seat or desktop app needed.',
    serverName: 'figma_files',
    launch: everywhere(npx('figma-developer-mcp', '--stdio')),
    runtime: 'node',
    steps: ['Create a personal access token in Figma: Settings → Security → Personal access tokens, with read access to file content.', 'Paste it below, then give Graft the link to a file or a frame.'],
    fields: [{ key: 'FIGMA_API_KEY', label: 'Personal access token', placeholder: 'figd_…', secret: true, kind: 'env' }],
    docs: 'https://github.com/GLips/Figma-Context-MCP'
  },
  {
    id: 'shadcn',
    name: 'shadcn/ui',
    category: 'Design and front end',
    description: 'Browse, search and add components from shadcn/ui and other registries to a React project.',
    serverName: 'shadcn',
    launch: everywhere(npx('shadcn@latest', 'mcp')),
    runtime: 'node',
    steps: ['Use it in a project set up for shadcn/ui, with a components.json. Run `npx shadcn@latest init` there first if it isn’t.'],
    docs: 'https://ui.shadcn.com/docs/mcp'
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    category: 'Design and front end',
    description: 'Debug a page in Chrome as you would in DevTools: console messages, network requests, performance traces and screenshots.',
    serverName: 'chrome_devtools',
    // Without the flag the server sends usage statistics to Google.
    launch: everywhere(npx('chrome-devtools-mcp@latest', '--no-usage-statistics')),
    runtime: 'node',
    steps: ['Install Google Chrome. The server opens a Chrome window of its own, with a separate profile.'],
    docs: 'https://github.com/ChromeDevTools/chrome-devtools-mcp'
  },
  {
    id: 'nextjs-devtools',
    name: 'Next.js DevTools',
    category: 'Design and front end',
    description: 'Your running Next.js app as the agent sees it: its errors, routes and logs, with the Next.js docs at hand.',
    serverName: 'nextjs_devtools',
    launch: everywhere(npx('next-devtools-mcp@latest')),
    runtime: 'node',
    steps: ['Start the app with `npm run dev`: the server finds the running Next.js dev server.'],
    docs: 'https://github.com/vercel/next-devtools-mcp'
  },
  {
    id: 'svelte',
    name: 'Svelte',
    category: 'Design and front end',
    description: 'The Svelte and SvelteKit docs, and a checker that suggests fixes for the components the agent writes.',
    serverName: 'svelte',
    launch: everywhere({ type: 'http', url: 'https://mcp.svelte.dev/mcp' }),
    steps: ['Nothing to set up.'],
    docs: 'https://svelte.dev/docs/mcp/overview'
  },
  {
    id: 'astro-docs',
    name: 'Astro docs',
    category: 'Design and front end',
    description: 'Search the current Astro documentation while building an Astro site.',
    serverName: 'astro_docs',
    launch: everywhere({ type: 'http', url: 'https://mcp.docs.astro.build/mcp' }),
    steps: ['Nothing to set up.'],
    docs: 'https://docs.astro.build/en/guides/build-with-ai/'
  },
  {
    id: 'webflow',
    name: 'Webflow',
    category: 'Design and front end',
    description: 'Read and change your Webflow sites: pages, CMS collections and items, assets and settings.',
    serverName: 'webflow',
    launch: everywhere({ type: 'http', url: 'https://mcp.webflow.com/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server and choose the sites Graft may use.'],
    docs: 'https://developers.webflow.com/mcp/reference/overview'
  },
  // ---- Docs and code knowledge ----
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    category: 'Docs and code knowledge',
    description: 'Ask about any public GitHub repository and get answers from documentation written from its code.',
    serverName: 'deepwiki',
    launch: everywhere({ type: 'http', url: 'https://mcp.deepwiki.com/mcp' }),
    steps: ['Nothing to set up. It covers public repositories.'],
    docs: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp'
  },
  {
    id: 'microsoft-learn',
    name: 'Microsoft Learn',
    category: 'Docs and code knowledge',
    description: 'Search and read Microsoft’s official documentation: .NET and C#, Azure, Windows, PowerShell, TypeScript and more.',
    serverName: 'microsoft_learn',
    launch: everywhere({ type: 'http', url: 'https://learn.microsoft.com/api/mcp' }),
    steps: ['Nothing to set up.'],
    docs: 'https://learn.microsoft.com/en-us/training/support/mcp'
  },
  {
    id: 'aws-knowledge',
    name: 'AWS documentation',
    category: 'Docs and code knowledge',
    description: 'Search AWS documentation, API references and architecture guidance, kept current by AWS.',
    serverName: 'aws_knowledge',
    launch: everywhere({ type: 'http', url: 'https://knowledge-mcp.global.api.aws' }),
    steps: ['Nothing to set up.'],
    docs: 'https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server'
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare docs',
    category: 'Docs and code knowledge',
    description: 'Search Cloudflare’s documentation: Workers, Pages, R2, D1, KV and the rest of the platform.',
    serverName: 'cloudflare_docs',
    launch: everywhere({ type: 'http', url: 'https://docs.mcp.cloudflare.com/mcp' }),
    steps: ['Nothing to set up.'],
    docs: 'https://github.com/cloudflare/mcp-server-cloudflare'
  },
  {
    id: 'shopify-dev',
    name: 'Shopify Dev',
    category: 'Docs and code knowledge',
    description: 'Shopify’s developer docs and API schemas for apps, themes and storefronts, with checks for the GraphQL the agent writes.',
    serverName: 'shopify_dev',
    launch: everywhere(npx('@shopify/dev-mcp@latest')),
    runtime: 'node',
    steps: ['Nothing to set up.'],
    docs: 'https://shopify.dev/docs/apps/build/devmcp'
  },
  // ---- Developer tools ----
  {
    id: 'semgrep',
    name: 'Semgrep',
    category: 'Developer tools',
    description: 'Scan the code the agent writes for security bugs and secrets with Semgrep’s rules.',
    serverName: 'semgrep',
    launch: everywhere({ type: 'http', url: 'https://mcp.semgrep.ai/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server to connect your Semgrep account.'],
    docs: 'https://github.com/semgrep/mcp'
  },
  {
    id: 'circleci',
    name: 'CircleCI',
    category: 'Developer tools',
    description: 'Find out why a build failed, read test results and flaky tests, and rerun pipelines.',
    serverName: 'circleci',
    launch: everywhere(npx('@circleci/mcp-server-circleci@latest')),
    runtime: 'node',
    steps: ['Create a personal API token in CircleCI: User Settings → Personal API Tokens.'],
    fields: [{ key: 'CIRCLECI_TOKEN', label: 'Personal API token', secret: true, kind: 'env' }],
    docs: 'https://github.com/CircleCI-Public/mcp-server-circleci'
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    category: 'Developer tools',
    description: 'Inspect and manage the cluster your kubeconfig points to: pods, deployments, services, logs and Helm charts.',
    serverName: 'kubernetes',
    launch: everywhere(npx('mcp-server-kubernetes')),
    runtime: 'node',
    steps: ['Set kubectl up with a context for the cluster; `kubectl config current-context` names the one the server uses.'],
    docs: 'https://github.com/Flux159/mcp-server-kubernetes'
  },
  // ---- Cloud, payments and analytics ----
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'Cloud, payments and analytics',
    description: 'Build on your Cloudflare account: Workers, KV namespaces, R2 buckets, D1 databases and Hyperdrive.',
    serverName: 'cloudflare',
    launch: everywhere({ type: 'http', url: 'https://bindings.mcp.cloudflare.com/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server to connect your Cloudflare account.'],
    docs: 'https://github.com/cloudflare/mcp-server-cloudflare'
  },
  {
    id: 'netlify',
    name: 'Netlify',
    category: 'Cloud, payments and analytics',
    description: 'Create, deploy and manage Netlify sites, with their environment variables, forms and extensions.',
    serverName: 'netlify',
    launch: everywhere(npx('@netlify/mcp')),
    runtime: 'node',
    steps: ['Create a personal access token in Netlify: User settings → Applications → Personal access tokens.'],
    fields: [{ key: 'NETLIFY_PERSONAL_ACCESS_TOKEN', label: 'Personal access token', secret: true, kind: 'env' }],
    docs: 'https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/'
  },
  {
    id: 'render',
    name: 'Render',
    category: 'Cloud, payments and analytics',
    description: 'Create and manage Render services, Postgres databases and key-value stores, and read their logs and metrics.',
    serverName: 'render_com',
    launch: everywhere({ type: 'http', url: 'https://mcp.render.com/mcp' }),
    steps: ['Create an API key in Render: Account settings → API keys.'],
    fields: [{ key: 'token', label: 'API key', placeholder: 'rnd_…', secret: true, kind: 'bearer' }],
    docs: 'https://render.com/docs/mcp-server'
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Cloud, payments and analytics',
    description: 'Work with your Stripe account (customers, products, prices, payment links, invoices) and search Stripe’s docs.',
    serverName: 'stripe',
    launch: everywhere({ type: 'http', url: 'https://mcp.stripe.com' }),
    steps: ['Create a restricted key in the Stripe Dashboard (Developers → API keys) with only the permissions Graft needs. A test-mode key keeps it away from real money.'],
    fields: [{ key: 'token', label: 'Restricted API key', placeholder: 'rk_test_…', secret: true, kind: 'bearer' }],
    docs: 'https://docs.stripe.com/mcp'
  },
  {
    id: 'posthog',
    name: 'PostHog',
    category: 'Cloud, payments and analytics',
    description: 'Product analytics from your PostHog projects: trends, funnels, feature flags, experiments and errors.',
    serverName: 'posthog',
    launch: everywhere({ type: 'http', url: 'https://mcp.posthog.com/mcp' }),
    steps: ['Create a personal API key in PostHog (Settings → Personal API keys) with the MCP Server preset.'],
    fields: [{ key: 'token', label: 'Personal API key', placeholder: 'phx_…', secret: true, kind: 'bearer' }],
    docs: 'https://posthog.com/docs/model-context-protocol'
  },
  // ---- Databases and data ----
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'Databases and data',
    description: 'Manage Supabase projects: tables and migrations, SQL, edge functions, logs and branches.',
    serverName: 'supabase',
    launch: everywhere({ type: 'http', url: 'https://mcp.supabase.com/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server to connect your Supabase account. Point it at a development project, not production.'],
    docs: 'https://supabase.com/docs/guides/getting-started/mcp'
  },
  {
    id: 'neon',
    name: 'Neon',
    category: 'Databases and data',
    description: 'Serverless Postgres on Neon: create projects and branches, run SQL, and try migrations on a branch first.',
    serverName: 'neon',
    launch: everywhere({ type: 'http', url: 'https://mcp.neon.tech/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server to connect your Neon account.'],
    docs: 'https://neon.com/docs/ai/neon-mcp-server'
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'Databases and data',
    description: 'Explore a Postgres database, run read-only queries, check its health and find the indexes it needs.',
    serverName: 'postgres',
    launch: everywhere(uvx('postgres-mcp', '--access-mode=restricted')),
    runtime: 'uv',
    steps: ['Give the connection string of the database. The server runs in restricted mode: its queries only read.'],
    fields: [{ key: 'DATABASE_URI', label: 'Connection string', placeholder: 'postgresql://user:password@localhost:5432/dbname', secret: true, kind: 'env' }],
    docs: 'https://github.com/crystaldba/postgres-mcp'
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    category: 'Databases and data',
    description: 'Query and explore the collections of a MongoDB database. Read-only unless you change it.',
    serverName: 'mongodb',
    launch: everywhere(npx('mongodb-mcp-server@latest', '--readOnly')),
    runtime: 'node',
    steps: ['Give the connection string of the database. The server starts read-only; take `--readOnly` out of its arguments in Customize to allow writes.'],
    fields: [{ key: 'MDB_MCP_CONNECTION_STRING', label: 'Connection string', placeholder: 'mongodb://localhost:27017/mydb', secret: true, kind: 'env' }],
    docs: 'https://github.com/mongodb-js/mongodb-mcp-server'
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'Databases and data',
    description: 'Read and write a Redis database: strings, hashes, lists, sets, sorted sets, streams and vector search.',
    serverName: 'redis',
    launch: everywhere(uvx('--from', 'redis-mcp-server@latest', 'redis-mcp-server')),
    runtime: 'uv',
    steps: ['Leave the fields empty for a Redis on this computer at port 6379.'],
    fields: [
      { key: 'REDIS_HOST', label: 'Host (optional)', placeholder: 'localhost', optional: true, kind: 'env' },
      { key: 'REDIS_PORT', label: 'Port (optional)', placeholder: '6379', optional: true, kind: 'env' },
      { key: 'REDIS_PWD', label: 'Password (optional)', secret: true, optional: true, kind: 'env' }
    ],
    docs: 'https://github.com/redis/mcp-redis'
  },
  {
    id: 'duckdb',
    name: 'DuckDB',
    category: 'Databases and data',
    description: 'Analyze CSV, Parquet and JSON files with SQL in an in-memory DuckDB, or open a .duckdb file.',
    serverName: 'duckdb',
    launch: everywhere(uvx('mcp-server-motherduck', '--db-path', ':memory:', '--read-write', '--allow-switch-databases')),
    runtime: 'uv',
    steps: ['Nothing to set up. Ask Graft to query a data file with SQL.'],
    docs: 'https://github.com/motherduckdb/mcp-server-motherduck'
  },
  // ---- Research and the web ----
  {
    id: 'huggingface',
    name: 'Hugging Face',
    category: 'Research and the web',
    description: 'Search models, datasets, papers and Spaces on the Hugging Face Hub, and run Gradio apps.',
    serverName: 'huggingface',
    launch: everywhere({ type: 'http', url: 'https://huggingface.co/mcp' }),
    steps: ['Works without a token. A token from huggingface.co/settings/tokens raises the limits and reaches your private repositories.'],
    fields: [{ key: 'token', label: 'Access token (optional)', placeholder: 'hf_…', secret: true, optional: true, kind: 'bearer' }],
    docs: 'https://huggingface.co/settings/mcp'
  },
  {
    id: 'arxiv',
    name: 'arXiv',
    category: 'Research and the web',
    description: 'Search arXiv, download papers and read them in full.',
    serverName: 'arxiv',
    launch: everywhere(uvx('arxiv-mcp-server')),
    runtime: 'uv',
    steps: ['Nothing to set up. Downloaded papers are kept in ~/.arxiv-mcp-server/papers.'],
    docs: 'https://github.com/blazickjp/arxiv-mcp-server'
  },
  {
    id: 'paper-search',
    name: 'Paper search',
    category: 'Research and the web',
    description: 'Search arXiv, PubMed, bioRxiv, medRxiv, Semantic Scholar, OpenAlex, CORE and more at once, and download open-access papers.',
    serverName: 'paper_search',
    launch: everywhere(uvx('paper-search-mcp')),
    runtime: 'uv',
    steps: ['Nothing to set up. Free keys for Semantic Scholar and CORE raise their rate limits (see the docs for the variables).'],
    docs: 'https://github.com/openags/paper-search-mcp'
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    category: 'Research and the web',
    description: 'Search Wikipedia and read articles, their summaries and sections.',
    serverName: 'wikipedia',
    launch: everywhere(uvx('wikipedia-mcp')),
    runtime: 'uv',
    steps: ['Nothing to set up.'],
    docs: 'https://github.com/rudra-ravi/wikipedia-mcp'
  },
  {
    id: 'zotero',
    name: 'Zotero',
    category: 'Research and the web',
    description: 'Search your Zotero library and read its items, notes and annotations, to cite them as you write.',
    serverName: 'zotero',
    launch: everywhere(uvx('--from', 'zotero-mcp-server', 'zotero-mcp')),
    runtime: 'uv',
    env: { ZOTERO_LOCAL: 'true' },
    steps: ['In Zotero 7 or later, open Settings → Advanced and tick “Allow other applications on this computer to communicate with Zotero”.', 'Keep Zotero open while Graft works.'],
    troubleshoot: 'Check that Zotero is open and lets other applications on this computer talk to it (Settings → Advanced).',
    docs: 'https://github.com/54yyyu/zotero-mcp'
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    category: 'Research and the web',
    description: 'Answers from the web with their sources, and deep research, through Perplexity’s Sonar models.',
    serverName: 'perplexity',
    launch: everywhere({ type: 'http', url: 'https://api.perplexity.ai/mcp' }),
    steps: ['Create an API key at perplexity.ai/account/api. Searches are paid with your Perplexity API credits.'],
    fields: [{ key: 'token', label: 'API key', placeholder: 'pplx-…', secret: true, kind: 'bearer' }],
    docs: 'https://docs.perplexity.ai/guides/mcp-server'
  },
  {
    id: 'exa',
    name: 'Exa',
    category: 'Research and the web',
    description: 'Web search made for agents: find pages, code examples and company facts, and fetch their content.',
    serverName: 'exa',
    launch: everywhere({ type: 'http', url: 'https://mcp.exa.ai/mcp' }),
    steps: ['Nothing to set up: it works without a key, at a free rate limit.'],
    docs: 'https://docs.exa.ai/reference/exa-mcp'
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    category: 'Research and the web',
    description: 'Search the web, news, images and videos with Brave’s own independent index.',
    serverName: 'brave_search',
    launch: everywhere(npx('@brave/brave-search-mcp-server', '--transport', 'stdio')),
    runtime: 'node',
    steps: ['Get an API key at brave.com/search/api; the free plan is enough to start.'],
    fields: [{ key: 'BRAVE_API_KEY', label: 'API key', secret: true, kind: 'env' }],
    docs: 'https://github.com/brave/brave-search-mcp-server'
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    category: 'Research and the web',
    description: 'Scrape and crawl websites into clean Markdown, map a site’s pages and extract structured data.',
    serverName: 'firecrawl',
    launch: everywhere(npx('firecrawl-mcp')),
    runtime: 'node',
    steps: ['Create an API key at firecrawl.dev.'],
    fields: [{ key: 'FIRECRAWL_API_KEY', label: 'API key', placeholder: 'fc-…', secret: true, kind: 'env' }],
    docs: 'https://github.com/firecrawl/firecrawl-mcp-server'
  },
  {
    id: 'tavily',
    name: 'Tavily',
    category: 'Research and the web',
    description: 'Search, extract and crawl the web with Tavily, made for research agents.',
    serverName: 'tavily',
    launch: everywhere(npx('tavily-mcp@latest')),
    runtime: 'node',
    steps: ['Create an API key at app.tavily.com; it comes with free credits each month.'],
    fields: [{ key: 'TAVILY_API_KEY', label: 'API key', placeholder: 'tvly-…', secret: true, kind: 'env' }],
    docs: 'https://github.com/tavily-ai/tavily-mcp'
  },
  // ---- Plans and notes ----
  {
    id: 'atlassian',
    name: 'Jira and Confluence',
    category: 'Plans and notes',
    description: 'Search, read and update Jira issues and Confluence pages with your own Atlassian permissions.',
    serverName: 'atlassian',
    launch: everywhere({ type: 'http', url: 'https://mcp.atlassian.com/v2/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server to connect your Atlassian site.'],
    docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/'
  },
  {
    id: 'asana',
    name: 'Asana',
    category: 'Plans and notes',
    description: 'Find, create and update tasks, projects and goals in your Asana workspace.',
    serverName: 'asana',
    launch: everywhere({ type: 'http', url: 'https://mcp.asana.com/v2/mcp' }),
    signIn: true,
    steps: ['After you add it, click Sign in next to the server to connect your Asana workspace.'],
    docs: 'https://developers.asana.com/docs/using-asanas-mcp-server'
  },
  {
    id: 'airtable',
    name: 'Airtable',
    category: 'Plans and notes',
    description: 'Read and write the records of your Airtable bases, and look at their tables and fields.',
    serverName: 'airtable',
    launch: everywhere(npx('airtable-mcp-server')),
    runtime: 'node',
    steps: [
      'Create a personal access token at airtable.com/create/tokens with the scopes `schema.bases:read` and `data.records:read` (add `data.records:write` to let Graft change records), and give it the bases Graft may use.'
    ],
    fields: [{ key: 'AIRTABLE_API_KEY', label: 'Personal access token', placeholder: 'pat…', secret: true, kind: 'env' }],
    docs: 'https://github.com/domdomegg/airtable-mcp-server'
  },
  // ---- Memory and reasoning ----
  {
    id: 'memory',
    name: 'Memory',
    category: 'Memory and reasoning',
    description: 'A knowledge graph the agent keeps across sessions: people, projects and facts, and how they connect.',
    serverName: 'memory',
    launch: everywhere(npx('@modelcontextprotocol/server-memory')),
    runtime: 'node',
    steps: ['Nothing to set up. The graph is a file on this computer.'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory'
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential thinking',
    category: 'Memory and reasoning',
    description: 'A tool for thinking a hard problem through step by step, revising and branching, for models that don’t reason on their own.',
    serverName: 'sequential_thinking',
    launch: everywhere(npx('@modelcontextprotocol/server-sequential-thinking')),
    runtime: 'node',
    steps: ['Nothing to set up.'],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking'
  },
  // ---- Reverse engineering ----
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

export const INTEGRATION_CATEGORIES: readonly IntegrationCategory[] = [
  'Game engines, 3D and sound',
  'Design and front end',
  'Docs and code knowledge',
  'Developer tools',
  'Cloud, payments and analytics',
  'Databases and data',
  'Research and the web',
  'Plans and notes',
  'Memory and reasoning',
  'Reverse engineering'
];

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
