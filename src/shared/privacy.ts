import type { ProviderKind } from './schemas/common';

/**
 * How a provider treats what Graft sends it, as far as Graft can tell:
 * - local: a server on this computer, so nothing goes over the internet.
 * - routed: OpenRouter, which Graft restricts per request to providers that
 *   don't train on or keep prompts (see RequestPrivacy).
 * - no-training: the vendor's own API, whose terms leave API data out of training by default.
 * - may-train: Google's Gemini API, which may use data sent with free-tier keys.
 * - unknown: anything else; Graft can't check its policy.
 */
export type DataHandling = 'local' | 'routed' | 'no-training' | 'may-train' | 'unknown';

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

export function isLocalUrl(url: string): boolean {
  return LOCAL_URL.test(url);
}

/** Names that never leave the local network: this computer, the endings routers and companies hand out, and the ones set aside for testing. */
const INSIDE_NAME = /(^|\.)(localhost|localdomain|local|lan|internal|intranet|home|corp|test|invalid|example|home\.arpa)$/;

/** An IPv4 address as its four numbers, or null. */
function ipv4(text: string): number[] | null {
  const parts = text.split('.').map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return parts.length === 4 && parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** This computer (127/8, 0/8), private networks (10/8, 172.16/12, 192.168/16), link-local (169.254/16, where cloud metadata lives) and carrier-grade NAT (100.64/10). */
function privateV4(parts: number[]): boolean {
  const [a = 0, b = 0] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** An IPv6 address as its eight groups, or null. The last two groups may be written as an IPv4 address. */
function ipv6(text: string): number[] | null {
  if (!text.includes(':') || !/^[0-9a-f:.]+$/i.test(text)) return null;
  const gap = text.indexOf('::');
  const groups = (part: string): number[] | null => {
    const out: number[] = [];
    const pieces = part === '' ? [] : part.split(':');
    for (const [i, piece] of pieces.entries()) {
      const tail = piece.includes('.') && i === pieces.length - 1 ? ipv4(piece) : null;
      if (tail) out.push(((tail[0] ?? 0) << 8) | (tail[1] ?? 0), ((tail[2] ?? 0) << 8) | (tail[3] ?? 0));
      else if (/^[0-9a-f]{1,4}$/i.test(piece)) out.push(parseInt(piece, 16));
      else return null;
    }
    return out;
  };
  const head = groups(gap === -1 ? text : text.slice(0, gap));
  const rest = gap === -1 ? [] : groups(text.slice(gap + 2));
  if (!head || !rest) return null;
  if (gap === -1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  return missing >= 1 ? [...head, ...Array.from({ length: missing }, () => 0), ...rest] : null;
}

/** Whether an IP address is this computer's or a private network's, not the public internet's. */
export function isPrivateIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = ipv4(bare);
  if (v4) return privateV4(v4);
  const v6 = ipv6(bare);
  if (!v6) return false;
  const [first = 0, , , , , sixth = 0, seventh = 0, eighth = 0] = v6;
  const leadingZeros = v6.findIndex((group) => group !== 0);
  // "::" (unspecified) and "::1" (this computer).
  if (leadingZeros === -1 || (leadingZeros === 7 && eighth === 1)) return true;
  // fc00::/7 (private networks) and fe80::/10 (link-local).
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
  // An IPv4 address written as IPv6 (::ffff:a.b.c.d, or the older ::a.b.c.d).
  if ((leadingZeros === 5 && sixth === 0xffff) || leadingZeros === 6) return privateV4([seventh >> 8, seventh & 0xff, eighth >> 8, eighth & 0xff]);
  return false;
}

/**
 * Whether an address is on this computer or a private network: a router's
 * page, a service running locally, a cloud machine's metadata. Such a place is
 * not the web. It is known by its number, however that is written (the address
 * parser turns 2130706433 and 0x7f.1 into 127.0.0.1), by its ending, or by
 * being a bare name only the local network can resolve.
 */
export function isPrivateAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return false;
  }
  if (host === '') return false;
  if (host.includes(':') || ipv4(host)) return isPrivateIp(host);
  return INSIDE_NAME.test(host) || !host.includes('.');
}

/** Hosts of the vendor APIs whose terms Graft describes; a different base URL is someone else's server. */
const VENDOR_HOSTS: Partial<Record<ProviderKind, string>> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  gemini: 'generativelanguage.googleapis.com',
  openrouter: 'openrouter.ai'
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function dataHandling(provider: { kind: ProviderKind; baseUrl: string | null }): DataHandling {
  const { kind, baseUrl } = provider;
  if (baseUrl !== null && isLocalUrl(baseUrl)) return 'local';
  if (kind === 'ollama') return baseUrl === null ? 'local' : 'unknown';
  const vendor = VENDOR_HOSTS[kind];
  if (!vendor || (baseUrl !== null && hostOf(baseUrl) !== vendor)) return 'unknown';
  if (kind === 'openrouter') return 'routed';
  return kind === 'gemini' ? 'may-train' : 'no-training';
}
