import { LucideProvider } from 'lucide-react';
import { useEffect } from 'react';
import { TooltipProvider } from './components/Tooltip';
import { BootSplash } from './features/boot/BootSplash';
import { applyTheme } from './lib/theme';

export function App() {
  useEffect(() => applyTheme('system', (error) => console.error('Theme sync failed', error)), []);

  return (
    <LucideProvider strokeWidth={1.75} size={16}>
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        <BootSplash progress={null} label="Starting Graft" />
      </TooltipProvider>
    </LucideProvider>
  );
}
