import { describe, expect, it } from 'vitest';
import { bestSystemVoice, speakableText, speechChunks, voiceLabel } from '../../../src/renderer/src/lib/speech';

const voice = (name: string, lang: string, isDefault = false): SpeechSynthesisVoice =>
  ({ name, lang, default: isDefault, localService: true, voiceURI: name });

describe('read aloud', () => {
  it('reads the words, not markup, code blocks, link addresses or citation pills', () => {
    const text = speakableText(
      ['## Plan', '- **Fast** start [x.com](https://x.com/a), see the [docs](https://d.dev).', '```js', 'const a = 1;', '```', 'Run `npm test` | then ship.'].join('\n')
    );
    expect(text).not.toMatch(/[#*`[\]()]|https?:|const a/);
    expect(text).toContain('Plan');
    expect(text).toContain('Fast start, see the docs.');
    expect(text).toContain('npm test');
  });

  it('packs sentences into pieces and splits overlong sentences at spaces', () => {
    expect(speechChunks('One. Two two. Three three three.', 12)).toEqual(['One.', 'Two two.', 'Three three', 'three.']);
    expect(speechChunks('Short one. Another short one.', 100)).toEqual(['Short one. Another short one.']);
    expect(speechChunks('', 50)).toEqual([]);
  });

  it('prefers the chosen voice, else a natural voice in the user’s language', () => {
    const voices = [
      voice('Microsoft David - English (United States)', 'en-US', true),
      voice('Microsoft Zira - English (United States)', 'en-US'),
      voice('Microsoft Aria Online (Natural) - English (United States)', 'en-US'),
      voice('Google Deutsch', 'de-DE')
    ];
    expect(bestSystemVoice(voices, null, 'en-US')?.name).toBe('Microsoft Aria Online (Natural) - English (United States)');
    expect(bestSystemVoice(voices, 'Microsoft Zira - English (United States)', 'en-US')?.name).toBe('Microsoft Zira - English (United States)');
    expect(bestSystemVoice(voices, null, 'de-DE')?.name).toBe('Google Deutsch');
    expect(bestSystemVoice([], null, 'en-US')).toBeNull();
  });

  it('names Kokoro-style voices in words and keeps other voice ids', () => {
    expect(voiceLabel('af_heart')).toBe('Heart (American English, female)');
    expect(voiceLabel('bm_george')).toBe('George (British English, male)');
    expect(voiceLabel('en-US-Harper:MAI-Voice-2')).toBe('en-US-Harper:MAI-Voice-2');
  });
});
