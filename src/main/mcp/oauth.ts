import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { GraftError } from '@shared/errors';
import type { KeyStore } from '../secrets/keyStore';

/**
 * OAuth for remote MCP servers: dynamic client registration, PKCE, a
 * loopback redirect, and tokens kept in the encrypted key store.
 */

const CALLBACK_TIMEOUT_MS = 5 * 60_000;

export class McpOAuthProvider implements OAuthClientProvider {
  private verifier: string | null = null;

  constructor(
    private readonly keys: KeyStore,
    private readonly serverKey: string,
    private readonly redirect: string,
    private readonly openBrowser: (url: string) => Promise<void>
  ) {}

  private id(kind: 'client' | 'tokens'): string {
    return `mcp-oauth:${this.serverKey}:${kind}`;
  }

  private read<T>(kind: 'client' | 'tokens'): T | undefined {
    const raw = this.keys.get(this.id(kind));
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Graft',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read<OAuthClientInformationMixed>('client');
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.keys.set(this.id('client'), JSON.stringify(info));
  }

  tokens(): OAuthTokens | undefined {
    return this.read<OAuthTokens>('tokens');
  }

  saveTokens(tokens: OAuthTokens): void {
    this.keys.set(this.id('tokens'), JSON.stringify(tokens));
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.openBrowser(url.toString());
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new GraftError('oauth_state', 'The sign-in was not started from Graft. Try signing in again.');
    return this.verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') this.keys.delete(this.id('client'));
    if (scope === 'all' || scope === 'tokens') this.keys.delete(this.id('tokens'));
    if (scope === 'all' || scope === 'verifier') this.verifier = null;
  }
}

/** Removes stored OAuth data for a server (when it is deleted). */
export function forgetOAuth(keys: KeyStore, serverKey: string): void {
  keys.delete(`mcp-oauth:${serverKey}:client`);
  keys.delete(`mcp-oauth:${serverKey}:tokens`);
}

export function hasOAuthTokens(keys: KeyStore, serverKey: string): boolean {
  return keys.has(`mcp-oauth:${serverKey}:tokens`);
}

/**
 * A one-shot loopback server for the OAuth redirect. `url` is the redirect
 * URI; `code` resolves with the authorization code (or rejects on error,
 * denial or timeout).
 */
export async function startOAuthCallback(): Promise<{ url: string; code: Promise<string>; close: () => void }> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const value = url.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Graft</title><body style="font-family:system-ui;padding:40px">${
        error ? 'Sign-in was not completed. You can close this tab and try again in Graft.' : 'Signed in. You can close this tab and return to Graft.'
      }</body>`
    );
    if (error) rejectCode(new GraftError('oauth_denied', `The server refused sign-in: ${error}`));
    else if (value) resolveCode(value);
    else rejectCode(new GraftError('oauth_failed', 'The sign-in redirect had no authorization code.'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const timer = setTimeout(() => rejectCode(new GraftError('oauth_timeout', 'Sign-in timed out. Try again.')), CALLBACK_TIMEOUT_MS);
  const close = (): void => {
    clearTimeout(timer);
    server.close();
  };
  void code.then(close, close);
  return { url: `http://127.0.0.1:${port}/callback`, code, close };
}
