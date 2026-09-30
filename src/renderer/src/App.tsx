import { LucideProvider } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ErrorState } from './components/States';
import { Toaster } from './components/Toaster';
import { TooltipProvider } from './components/Tooltip';
import { BootScreen } from './features/boot/BootScreen';
import { Onboarding } from './features/onboarding/Onboarding';
import { AppShell } from './features/shell/AppShell';
import { useGraftEvents } from './lib/events';
import { logError } from './lib/log';
import { applyAppearance, applyPlatform, applyTheme } from './lib/theme';
import { useApp } from './stores/app';

let bootStarted = false;

function Root() {
  const phase = useApp((s) => s.phase);
  const bootError = useApp((s) => s.bootError);
  const theme = useApp((s) => s.settings?.appearance.theme ?? 'system');
  const appearance = useApp((s) => s.settings?.appearance);
  const [splashDone, setSplashDone] = useState(false);
  const onSplashDone = useCallback(() => setSplashDone(true), []);

  useGraftEvents();

  useEffect(() => {
    applyPlatform(window.graft.platform);
    if (bootStarted) return;
    bootStarted = true;
    void useApp.getState().boot();
  }, []);

  useEffect(() => applyTheme(theme, (error) => logError('Could not sync the titlebar theme', error)), [theme]);
  useEffect(() => {
    if (appearance) applyAppearance(appearance);
  }, [appearance]);

  if (phase === 'error') {
    return (
      <div className="app-drag flex h-full items-center justify-center bg-bg">
        <ErrorState
          title="Graft couldn't start"
          message={bootError ?? 'Unknown error'}
          onRetry={() => {
            setSplashDone(false);
            void useApp.getState().boot();
          }}
        />
      </div>
    );
  }
  if (!splashDone) return <BootScreen ready={phase !== 'booting'} onDone={onSplashDone} />;
  if (phase === 'onboarding') return <Onboarding />;
  if (phase === 'ready') return <AppShell />;
  return <BootScreen ready={false} onDone={onSplashDone} />;
}

export function App() {
  return (
    <LucideProvider strokeWidth={1.75} size={16}>
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        <ErrorBoundary label="Graft">
          <Root />
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </LucideProvider>
  );
}
