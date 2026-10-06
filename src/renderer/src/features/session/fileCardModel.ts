/** The kind of icon a file gets in the card of files a reply made. */
export type FileGlyph = 'image' | 'sheet' | 'slides' | 'web' | 'code' | 'document' | 'text';

const CODE_NAME = /\.(ts|tsx|jsx|rs|go|java|c|cpp|cs|rb|php|sh|ps1|sql)$/i;

export function fileGlyph(file: { name: string; mime: string }): FileGlyph {
  const { mime } = file;
  if (mime.startsWith('image/')) return 'image';
  // The office formats come before code: their types hold "xml" too.
  if (/csv|tab-separated|spreadsheetml/.test(mime)) return 'sheet';
  if (mime.includes('presentationml')) return 'slides';
  if (mime === 'application/pdf' || mime.includes('wordprocessingml')) return 'document';
  if (mime === 'text/html') return 'web';
  if (/json|javascript|python|xml|yaml|css/.test(mime) || CODE_NAME.test(file.name)) return 'code';
  return 'text';
}
