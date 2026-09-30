import { GraftError } from '@shared/errors';
import type { Db } from '../db/database';

/** The subset of Electron's safeStorage the key store needs (injected for tests). */
export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface KeyStoreStatus {
  encryptionAvailable: boolean;
  plaintextAllowed: boolean;
}

interface Row {
  blob: Buffer;
  encrypted: number;
}

const KEYRING_MESSAGE =
  "Your system keyring isn't available, so Graft can't encrypt this key. To store it unencrypted on this device, allow plaintext key storage in Settings → Security.";

/**
 * API keys, encrypted at rest with the OS keyring (DPAPI / Keychain / libsecret).
 * Keys only ever leave this class toward provider adapters in the main
 * process; nothing here is exposed over IPC except presence.
 */
export class KeyStore {
  constructor(
    private readonly db: Db,
    private readonly encryptor: Encryptor,
    private readonly plaintextAllowed: () => boolean
  ) {}

  status(): KeyStoreStatus {
    return { encryptionAvailable: this.encryptor.isEncryptionAvailable(), plaintextAllowed: this.plaintextAllowed() };
  }

  set(id: string, secret: string): void {
    if (secret.length === 0) throw new GraftError('empty_secret', 'The key is empty.');
    let blob: Buffer;
    let encrypted: 0 | 1;
    if (this.encryptor.isEncryptionAvailable()) {
      blob = this.encryptor.encryptString(secret);
      encrypted = 1;
    } else if (this.plaintextAllowed()) {
      blob = Buffer.from(secret, 'utf8');
      encrypted = 0;
    } else {
      throw new GraftError('keyring_unavailable', KEYRING_MESSAGE);
    }
    this.db
      .prepare(
        `INSERT INTO secrets (id, blob, encrypted, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, encrypted = excluded.encrypted, updated_at = excluded.updated_at`
      )
      .run(id, blob, encrypted, Date.now());
  }

  get(id: string): string | null {
    const row = this.db.prepare('SELECT blob, encrypted FROM secrets WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    if (row.encrypted === 1) {
      if (!this.encryptor.isEncryptionAvailable()) throw new GraftError('keyring_unavailable', KEYRING_MESSAGE);
      try {
        return this.encryptor.decryptString(row.blob);
      } catch (error) {
        throw new GraftError(
          'key_unreadable',
          'A stored API key could not be decrypted (the OS keyring may have changed). Re-enter it in Settings → Providers.',
          { cause: error }
        );
      }
    }
    if (!this.plaintextAllowed()) throw new GraftError('keyring_unavailable', KEYRING_MESSAGE);
    return row.blob.toString('utf8');
  }

  has(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM secrets WHERE id = ?').get(id) !== undefined;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
  }

  /** Removes unencrypted keys (called when the plaintext opt-in is turned off). Returns the count. */
  purgePlaintext(): number {
    return this.db.prepare('DELETE FROM secrets WHERE encrypted = 0').run().changes;
  }
}
