import {
  siAirtable,
  siArxiv,
  siAstro,
  siAsana,
  siAtlassian,
  siBitbucket,
  siBlender,
  siBrave,
  siCircleci,
  siClaude,
  siCloudflare,
  siConfluence,
  siDatadog,
  siDiscord,
  siDocker,
  siDropbox,
  siDuckdb,
  siElevenlabs,
  siFigma,
  siFirebase,
  siGithub,
  siGitlab,
  siGmail,
  siGodotengine,
  siGooglecalendar,
  siGooglechrome,
  siGoogledrive,
  siGrafana,
  siHubspot,
  siHuggingface,
  siIntercom,
  siJira,
  siKubernetes,
  siLinear,
  siMixpanel,
  siMongodb,
  siNeon,
  siNetlify,
  siNextdotjs,
  siNotion,
  siObsidian,
  siPerplexity,
  siPosthog,
  siPostgresql,
  siPuppeteer,
  siReddit,
  siRedis,
  siRender,
  siRobloxstudio,
  siSentry,
  siShadcnui,
  siShopify,
  siSketchfab,
  siSpotify,
  siSqlite,
  siStripe,
  siSupabase,
  siSvelte,
  siTelegram,
  siTodoist,
  siTrello,
  siUnity,
  siUnrealengine,
  siVercel,
  siWebflow,
  siWhatsapp,
  siWikipedia,
  siWordpress,
  siYoutube,
  siZapier,
  siZotero
} from 'simple-icons';
import type { McpServerView } from '@shared/schemas/customize';
import { INTEGRATIONS } from '@shared/integrations';

/**
 * The marks of the apps MCP servers connect to (from Simple Icons, CC0), so a
 * connector shows the app it reaches instead of a letter. A server is known by
 * its name, its address or its command.
 */

export interface BrandIcon {
  title: string;
  /** The brand's own color, without the "#". */
  hex: string;
  /** One SVG path in a 24 × 24 box. */
  path: string;
}

/** Words that name an app, longest first where one contains another ("robloxstudio" before "roblox"). */
const BRANDS: ReadonlyArray<readonly [string, BrandIcon]> = [
  ['robloxstudio', siRobloxstudio],
  ['roblox', siRobloxstudio],
  ['blender', siBlender],
  ['unrealengine', siUnrealengine],
  ['unreal', siUnrealengine],
  ['unity', siUnity],
  ['godot', siGodotengine],
  ['sketchfab', siSketchfab],
  ['figma', siFigma],
  ['github', siGithub],
  ['gitlab', siGitlab],
  ['bitbucket', siBitbucket],
  ['sentry', siSentry],
  ['linear', siLinear],
  ['notion', siNotion],
  ['atlassian', siAtlassian],
  ['confluence', siConfluence],
  ['jira', siJira],
  ['asana', siAsana],
  ['trello', siTrello],
  ['todoist', siTodoist],
  ['airtable', siAirtable],
  ['hubspot', siHubspot],
  ['intercom', siIntercom],
  ['zapier', siZapier],
  ['gmail', siGmail],
  ['googlecalendar', siGooglecalendar],
  ['gcal', siGooglecalendar],
  ['googledrive', siGoogledrive],
  ['gdrive', siGoogledrive],
  ['dropbox', siDropbox],
  ['stripe', siStripe],
  ['shopify', siShopify],
  ['supabase', siSupabase],
  ['firebase', siFirebase],
  ['postgres', siPostgresql],
  ['mongodb', siMongodb],
  ['redis', siRedis],
  ['sqlite', siSqlite],
  ['vercel', siVercel],
  ['netlify', siNetlify],
  ['cloudflare', siCloudflare],
  ['docker', siDocker],
  ['datadog', siDatadog],
  ['grafana', siGrafana],
  ['posthog', siPosthog],
  ['mixpanel', siMixpanel],
  ['huggingface', siHuggingface],
  ['puppeteer', siPuppeteer],
  ['chrome', siGooglechrome],
  ['brave', siBrave],
  ['perplexity', siPerplexity],
  ['obsidian', siObsidian],
  ['wordpress', siWordpress],
  ['discord', siDiscord],
  ['telegram', siTelegram],
  ['whatsapp', siWhatsapp],
  ['reddit', siReddit],
  ['youtube', siYoutube],
  ['spotify', siSpotify],
  ['claude', siClaude],
  ['shadcn', siShadcnui],
  ['nextjs', siNextdotjs],
  ['svelte', siSvelte],
  ['astro', siAstro],
  ['webflow', siWebflow],
  ['rendercom', siRender],
  ['circleci', siCircleci],
  ['kubernetes', siKubernetes],
  ['neon', siNeon],
  ['duckdb', siDuckdb],
  ['arxiv', siArxiv],
  ['wikipedia', siWikipedia],
  ['zotero', siZotero],
  ['elevenlabs', siElevenlabs]
];

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function brandIn(text: string): BrandIcon | null {
  const squashed = squash(text);
  if (squashed.length === 0) return null;
  return BRANDS.find(([word]) => squashed.includes(word))?.[1] ?? null;
}

/** A server as far as its icon goes: its name and, when known, how it is reached. */
export type BrandedServer = Pick<McpServerView, 'name'> & { config?: McpServerView['config'] | null };

/** The app a server reaches: by its name first, then its address, then the command that starts it. */
export function brandOf(server: BrandedServer): BrandIcon | null {
  const config = server.config ?? null;
  return (
    brandIn(server.name) ??
    (config?.type === 'http' ? brandIn(hostOf(config.url)) : null) ??
    (config?.type === 'stdio' ? brandIn([config.command, ...config.args].join(' ')) : null)
  );
}

/** A server's name for people: the one it gives itself, else the integration's it was added as, else its own. */
export function connectorName(server: Pick<McpServerView, 'name' | 'title'>): string {
  return server.title ?? INTEGRATIONS.find((integration) => squash(integration.serverName) === squash(server.name))?.name ?? server.name;
}

/**
 * The ink of a mark on its brand's color: white, as app icons draw it (Roblox Studio's blue, Blender's
 * orange, GitHub's black), and black only on a color so light that white would vanish (a yellow, a white).
 */
export function inkOn(hex: string): '#000000' | '#ffffff' {
  const value = Number.parseInt(hex, 16);
  const channel = (shift: number): number => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.5 ? '#000000' : '#ffffff';
}
