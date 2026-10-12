import { beforeEach, describe, expect, it } from 'vitest';
import { pageUnder, useNav, type Route } from '../../../src/renderer/src/stores/nav';

const session: Route = { name: 'session', id: 's1' };
beforeEach(() => useNav.setState({ route: { name: 'home' }, back: [], forward: [] }));

describe('Settings over a page', () => {
  it('lies over the newest page that is not Settings', () => {
    expect(pageUnder([])).toEqual({ name: 'home' });
    expect(pageUnder([{ name: 'home' }, session])).toEqual(session);
    expect(pageUnder([session, { name: 'settings', section: 'profile' }, { name: 'settings', section: 'models' }])).toEqual(session);
  });

  it('closes back to that page with the history as it was, and Forward opens it again', () => {
    const nav = useNav.getState();
    nav.go(session);
    nav.go({ name: 'settings', section: 'profile' });
    nav.go({ name: 'settings', section: 'appearance' });
    useNav.getState().closeSettings();
    expect(useNav.getState().route).toEqual(session);
    expect(useNav.getState().back).toEqual([{ name: 'home' }]);
    useNav.getState().goForward();
    expect(useNav.getState().route).toEqual({ name: 'settings', section: 'profile' });
    useNav.getState().goForward();
    expect(useNav.getState().route).toEqual({ name: 'settings', section: 'appearance' });
  });

  it('steps back through the sections before it closes, and does nothing when Settings is not open', () => {
    const nav = useNav.getState();
    nav.go(session);
    nav.go({ name: 'settings', section: 'profile' });
    nav.go({ name: 'settings', section: 'appearance' });
    useNav.getState().goBack();
    expect(useNav.getState().route).toEqual({ name: 'settings', section: 'profile' });
    useNav.getState().goBack();
    expect(useNav.getState().route).toEqual(session);
    const before = useNav.getState();
    useNav.getState().closeSettings();
    expect(useNav.getState().route).toEqual(session);
    expect(useNav.getState().forward).toEqual(before.forward);
  });

  it('closes to the home page when nothing else was ever open', () => {
    useNav.setState({ route: { name: 'settings', section: 'about' }, back: [], forward: [] });
    useNav.getState().closeSettings();
    expect(useNav.getState().route).toEqual({ name: 'home' });
    expect(useNav.getState().back).toEqual([]);
    expect(useNav.getState().forward).toEqual([{ name: 'settings', section: 'about' }]);
  });

  it('forgets a removed session under Settings without closing them', () => {
    const nav = useNav.getState();
    nav.go(session);
    nav.go({ name: 'settings', section: 'profile' });
    useNav.getState().forget('s1');
    expect(useNav.getState().route).toEqual({ name: 'settings', section: 'profile' });
    expect(pageUnder(useNav.getState().back)).toEqual({ name: 'home' });
  });
});
