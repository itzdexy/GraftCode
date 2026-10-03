import type { ComponentType } from 'react';
import { AudioLines, Bell, BookText, Cpu, Database, EyeOff, Globe, Info, Keyboard, KeyRound, Palette, Plug, ShieldCheck, SlidersHorizontal, User, Webhook } from 'lucide-react';
import type { AccentId, PaletteId } from '@shared/schemas/appSettings';
import type { SettingsSection } from '../../stores/nav';

/**
 * The Settings pages and the appearance choices, outside the lazily loaded
 * Settings view so the command palette can list them.
 */

export interface SectionInfo {
  id: SettingsSection;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

export const SETTINGS_SECTIONS: SectionInfo[] = [
  { id: 'profile', label: 'Profile', description: 'How Graft greets you.', icon: User },
  { id: 'personalization', label: 'Personalization', description: 'What Graft knows about you and how it answers.', icon: SlidersHorizontal },
  { id: 'providers', label: 'Providers', description: 'Keys and endpoints for model providers.', icon: KeyRound },
  { id: 'models', label: 'Models', description: 'Defaults for new sessions and extra model IDs.', icon: Cpu },
  { id: 'permissions', label: 'Permissions', description: 'What the agent may do without asking.', icon: ShieldCheck },
  { id: 'privacy', label: 'Privacy', description: 'Model training, incognito chats and where your messages go.', icon: EyeOff },
  { id: 'search', label: 'Web search', description: 'How models search and read the web.', icon: Globe },
  { id: 'voice', label: 'Voice', description: 'How replies sound when they are read aloud.', icon: AudioLines },
  { id: 'mcp', label: 'MCP servers', description: 'Tools and data from other apps.', icon: Plug },
  { id: 'hooks', label: 'Hooks', description: 'Commands that run around tool calls and turns.', icon: Webhook },
  { id: 'memory', label: 'Memory', description: 'Standing instructions every session reads.', icon: BookText },
  { id: 'appearance', label: 'Appearance', description: 'Theme, colors, text size and motion.', icon: Palette },
  { id: 'shortcuts', label: 'Shortcuts', description: 'Keyboard shortcuts.', icon: Keyboard },
  { id: 'notifications', label: 'Notifications', description: 'Desktop notifications and running in the background.', icon: Bell },
  { id: 'data', label: 'Data', description: 'Export, clear and reset.', icon: Database },
  { id: 'about', label: 'About', description: 'Version and updates.', icon: Info }
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
