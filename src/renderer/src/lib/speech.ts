import { create } from 'zustand';
import type { AppSettings } from '@shared/schemas/appSettings';
import { errorText, invoke } from './ipc';
import { useToasts } from '../stores/toasts';

/**
 * Read aloud, one reply at a time. A natural voice (OpenRouter's speech
 * models, through the main process) plays piece by piece, fetching the next
 * piece while the current one plays; this computer's own voices are the
 * fallback, and incognito chats always use them. Both can be paused,
 * resumed and stopped.
 */
export type SpeechStatus = 'idle' | 'loading' | 'playing' | 'paused';

export const useSpeech = create<{ key: string | null; status: SpeechStatus }>(() => ({ key: null, status: 'idle' }));

type VoiceSettings = AppSettings['voice'];

/** Plain text for speech: code, links' addresses, citations and markup are dropped. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([a-z0-9.-]+\.[a-z]{2,})\]\([^)]*\)/gi, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sentences packed into pieces of up to `max` characters; longer sentences are split at spaces. */
export function speechChunks(text: string, max: number): string[] {
  const sentences = [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)].map((s) => s.segment.trim()).filter(Boolean);
  const pieces = sentences.flatMap((sentence) => {
    if (sentence.length <= max) return [sentence];
    const parts: string[] = [];
    let rest = sentence;
    while (rest.length > max) {
      const cut = rest.lastIndexOf(' ', max);
      const at = cut > max / 2 ? cut : max;
      parts.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) parts.push(rest);
    return parts;
  });
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.length > max) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** This computer's best voice for the language: natural or neural voices first, then the system default. */
export function bestSystemVoice(voices: SpeechSynthesisVoice[], preferred: string | null, language = navigator.language): SpeechSynthesisVoice | null {
  const chosen = preferred ? voices.find((v) => v.name === preferred) : undefined;
  if (chosen) return chosen;
  const base = language.split('-')[0]?.toLowerCase() ?? 'en';
  const score = (v: SpeechSynthesisVoice): number =>
    (v.lang.toLowerCase().startsWith(base) ? 10 : 0) +
    (v.lang.toLowerCase() === language.toLowerCase() ? 2 : 0) +
    (/natural|neural|online|premium|enhanced/i.test(v.name) ? 5 : 0) +
    (/aria|jenny|guy|ava|emma|andrew|brian|samantha|daniel|karen/i.test(v.name) ? 1 : 0) +
    (v.default ? 1 : 0);
  return [...voices].sort((a, b) => score(b) - score(a))[0] ?? null;
}

const LANGUAGES: Record<string, string> = {
  a: 'American English',
  b: 'British English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Brazilian Portuguese',
  z: 'Mandarin'
};

/** "af_heart" (Kokoro's naming: language, gender, name) reads as "Heart (American English, female)"; other voices keep their names. */
export function voiceLabel(voice: string): string {
  const match = /^([abefhijpz])([fm])_([a-z]+)$/.exec(voice);
  if (!match) return voice;
  const [, language = '', gender = '', name = ''] = match;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} (${LANGUAGES[language] ?? language}, ${gender === 'f' ? 'female' : 'male'})`;
}

let run = 0;
let audio: HTMLAudioElement | null = null;
let urls: string[] = [];
let fallbackNoted = false;

function settle(): void {
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio = null;
  }
  for (const url of urls) URL.revokeObjectURL(url);
  urls = [];
}

export function stopSpeech(): void {
  run++;
  settle();
  window.speechSynthesis.cancel();
  useSpeech.setState({ key: null, status: 'idle' });
}

export function pauseSpeech(): void {
  if (useSpeech.getState().status !== 'playing') return;
  if (audio) audio.pause();
  else window.speechSynthesis.pause();
  useSpeech.setState({ status: 'paused' });
}

export function resumeSpeech(): void {
  if (useSpeech.getState().status !== 'paused') return;
  useSpeech.setState({ status: 'playing' });
  if (audio) void audio.play().catch(() => undefined);
  else window.speechSynthesis.resume();
}

function finished(token: number): void {
  if (token !== run) return;
  settle();
  useSpeech.setState({ key: null, status: 'idle' });
}

function speakSystem(token: number, text: string, voice: VoiceSettings): void {
  const synth = window.speechSynthesis;
  const chosen = bestSystemVoice(synth.getVoices(), voice.systemVoice);
  // Short utterances: Chromium cuts long ones off partway.
  const chunks = speechChunks(text, 220);
  chunks.forEach((chunk, i) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (chosen) utterance.voice = chosen;
    utterance.rate = voice.speed;
    utterance.onstart = () => {
      if (token === run && useSpeech.getState().status === 'loading') useSpeech.setState({ status: 'playing' });
    };
    if (i === chunks.length - 1) utterance.onend = () => finished(token);
    utterance.onerror = (event) => {
      if (token !== run || event.error === 'canceled' || event.error === 'interrupted') return;
      useToasts.getState().push({ tone: 'error', title: "Couldn't read the reply aloud", description: event.error });
      finished(token);
    };
    synth.speak(utterance);
  });
}

function bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Plays one piece; resolves false when reading stopped or the audio failed. */
function play(token: number, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const element = new Audio(url);
    audio = element;
    element.onended = () => resolve(token === run);
    element.onerror = () => resolve(false);
    if (useSpeech.getState().status === 'paused') return;
    element
      .play()
      .then(() => {
        if (token === run) useSpeech.setState({ status: 'playing' });
      })
      .catch(() => resolve(false));
  });
}

async function speakNatural(token: number, text: string, voice: VoiceSettings): Promise<void> {
  const chunks = speechChunks(text, 700);
  const fetchPiece = (i: number): Promise<string> =>
    invoke('voice:speak', { text: chunks[i] ?? '', model: voice.model, voice: voice.voice, speed: voice.speed }).then((r) => URL.createObjectURL(new Blob([bytes(r.audio)], { type: r.mime })));
  let next = fetchPiece(0);
  for (let i = 0; i < chunks.length; i++) {
    let url: string;
    try {
      url = await next;
    } catch (error) {
      if (token !== run) return;
      // The natural voice is out of reach (key, credits, network): finish with this computer's voice.
      if (!fallbackNoted) {
        fallbackNoted = true;
        useToasts.getState().push({ tone: 'info', title: "Reading with this computer's voice", description: `The natural voice didn't answer: ${errorText(error)}` });
      }
      audio = null;
      speakSystem(token, chunks.slice(i).join(' '), voice);
      return;
    }
    if (token !== run) {
      URL.revokeObjectURL(url);
      return;
    }
    urls.push(url);
    if (i + 1 < chunks.length) next = fetchPiece(i + 1);
    if (!(await play(token, url))) {
      if (token === run) finished(token);
      return;
    }
  }
  finished(token);
}

/** Whether natural voices can be used (an OpenRouter key is set up); rechecked after a minute, so a new key counts. */
let naturalAvailable: { at: number; answer: Promise<boolean> } | null = null;
export function naturalVoiceAvailable(): Promise<boolean> {
  if (!naturalAvailable || Date.now() - naturalAvailable.at > 60_000) {
    naturalAvailable = {
      at: Date.now(),
      answer: invoke('voice:models')
        .then((r) => r.available)
        .catch(() => false)
    };
  }
  return naturalAvailable.answer;
}

export async function startSpeech(key: string, markdown: string, voice: VoiceSettings, options: { incognito: boolean }): Promise<void> {
  stopSpeech();
  const text = speakableText(markdown);
  if (!text) return;
  const token = run;
  useSpeech.setState({ key, status: 'loading' });
  const natural = voice.engine === 'natural' && !options.incognito && (await naturalVoiceAvailable());
  if (token !== run) return;
  if (natural) await speakNatural(token, text, voice);
  else speakSystem(token, text, voice);
}
