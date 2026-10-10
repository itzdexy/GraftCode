import type { ComponentType } from 'react';
import { AudioLines, Bell, BookText, Box, ChartColumn, Cpu, Database, EyeOff, Globe, Image, Info, Keyboard, KeyRound, Palette, Plug, ShieldCheck, SlidersHorizontal, User, Webhook } from 'lucide-react';
import type { AccentId, PaletteId } from '@shared/schemas/appSettings';
import type { SettingsSection } from '../../stores/nav';

/**
 * The Settings pages and the appearance choices, outside the lazily loaded
 * Settings view so the command palette can list them.
 */

/** The headings the Settings pages are listed under, in the order they are shown. */
export const SETTINGS_GROUPS = [
  { id: 'you', label: 'You' },
  { id: 'models', label: 'Models' },
  { id: 'agent', label: 'Agent' },
  { id: 'app', label: 'App' },
  { id: 'data', label: 'Data' }
] as const;

export interface SectionInfo {
  id: SettingsSection;
  group: (typeof SETTINGS_GROUPS)[number]['id'];
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export const SETTINGS_SECTIONS: SectionInfo[] = [
  { id: 'profile', group: 'you', label: 'Profile', description: 'How Graft greets you.', icon: User },
  { id: 'personalization', group: 'you', label: 'Personalization', description: 'What Graft knows about you and how it answers.', icon: SlidersHorizontal },
  { id: 'privacy', group: 'you', label: 'Privacy', description: 'Model training, incognito chats and where your messages go.', icon: EyeOff },
  { id: 'providers', group: 'models', label: 'Providers', description: 'Keys and endpoints for model providers.', icon: KeyRound },
  { id: 'models', group: 'models', label: 'Models', description: 'Defaults for new sessions and extra model IDs.', icon: Cpu },
  { id: 'search', group: 'models', label: 'Web search', description: 'How models search and read the web.', icon: Globe },
  { id: 'media', group: 'models', label: 'Images', description: 'The image model the agent uses, and ComfyUI on this computer.', icon: Image },
  { id: 'voice', group: 'models', label: 'Voice', description: 'How replies sound when they are read aloud.', icon: AudioLines },
  { id: 'permissions', group: 'agent', label: 'Permissions', description: 'What the agent may do without asking.', icon: ShieldCheck },
  { id: 'sandbox', group: 'agent', label: 'Sandbox', description: 'Run a project’s commands in an isolated container.', icon: Box },
  { id: 'mcp', group: 'agent', label: 'Integrations', description: 'Apps and services Graft can work with, connected through MCP.', icon: Plug },
  { id: 'hooks', group: 'agent', label: 'Hooks', description: 'Commands that run around tool calls and turns.', icon: Webhook },
  { id: 'memory', group: 'agent', label: 'Memory', description: 'Standing instructions every session reads.', icon: BookText },
  { id: 'appearance', group: 'app', label: 'Appearance', description: 'Theme, colors, text size and motion.', icon: Palette },
  { id: 'shortcuts', group: 'app', label: 'Shortcuts', description: 'Keyboard shortcuts.', icon: Keyboard },
  { id: 'notifications', group: 'app', label: 'Notifications', description: 'Desktop notifications and running in the background.', icon: Bell },
  { id: 'usage', group: 'data', label: 'Usage', description: 'What Graft used and what it cost, by day and by model.', icon: ChartColumn },
  { id: 'data', group: 'data', label: 'Data', description: 'Export, clear and reset.', icon: Database },
  { id: 'about', group: 'data', label: 'About', description: 'Version and updates.', icon: Info }
];

export const PALETTES: Array<{ id: PaletteId; label: string; description: string }> = [
  { id: 'graft', label: 'Graft', description: 'Warm neutral' },
  { id: 'midnight', label: 'Midnight', description: 'Deep blue' },
  { id: 'slate', label: 'Slate', description: 'Cool grey' },
  { id: 'grove', label: 'Grove', description: 'A touch of green' },
  { id: 'dune', label: 'Dune', description: 'Warm sand' },
  { id: 'contrast', label: 'High contrast', description: 'Black, white, strong edges' }
];

export const ACCENTS: Array<{ id: AccentId; label: string }> = [
  { id: 'leaf', label: 'Leaf' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'iris', label: 'Iris' },
  { id: 'rose', label: 'Rose' },
  { id: 'gold', label: 'Gold' },
  { id: 'teal', label: 'Teal' },
  { id: 'mono', label: 'Mono' }
];
