import { useEffect } from 'react';
import { useApp } from '../stores/app';
import { useNav } from '../stores/nav';
import { panelBus, usePanels } from '../stores/panels';
import { useSessions } from '../stores/sessions';
import { onEvent } from './ipc';

/** Routes main-process push events into the stores. Mounted once at the root. */
export function useGraftEvents(): void {
  useEffect(
    () =>
      onEvent((event) => {
        switch (event.type) {
          case 'init:progress':
            useApp.getState().setProgress(event.label, event.done, event.total);
            break;
          case 'settings:changed':
            useApp.getState().setSettings(event.settings);
            break;
          case 'providers:changed':
            useApp.getState().setProviders(event.providers);
            if (useApp.getState().phase === 'ready') void useApp.getState().loadModels();
            break;
          case 'session:event':
            useSessions.getState().applyEvent(event.sessionId, event.event);
            break;
          case 'session:summary':
            useSessions.getState().applySummary(event.summary);
            break;
          case 'session:removed':
            useSessions.getState().remove(event.sessionId);
            useNav.getState().forget(event.sessionId);
            break;
          case 'app:navigate':
            useNav.getState().go({ name: 'session', id: event.sessionId });
            break;
          case 'pty:data':
            panelBus.ptyData(event.id, event.data, event.offset);
            break;
          case 'pty:exit':
            panelBus.ptyExit(event.id, event.exitCode);
            break;
          case 'shells:changed':
            panelBus.shellsChanged(event.sessionId);
            break;
          case 'browser:state':
            usePanels.getState().setBrowser(event.state);
            break;
        }
      }),
    []
  );
}
