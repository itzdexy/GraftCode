import { unzipSync } from 'fflate';

/** The names of the files inside a zip archive (a .docx, .pptx or .xlsx is one). */
export function zipEntries(file: Buffer): string[] {
  return Object.keys(unzipSync(new Uint8Array(file)));
}

/** One file of a zip archive as text. */
export function zipText(file: Buffer, entry: string): string {
  const data = unzipSync(new Uint8Array(file))[entry];
  if (!data) throw new Error(`No ${entry} in the archive. It holds: ${zipEntries(file).join(', ')}`);
  return Buffer.from(data).toString('utf8');
}
