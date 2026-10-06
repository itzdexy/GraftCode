/**
 * What no document can hold: the formats are XML, which forbids control
 * characters other than tab and line breaks, and half of a broken pair.
 * A file with one in it does not open at all, so they are dropped.
 */
// eslint-disable-next-line no-control-regex
const UNWRITABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|\p{Cs}/gu;

export function writable(text: string): string {
  return text.replace(UNWRITABLE, '');
}
