import { describe, expect, it } from 'vitest';
import { motionAttribute, motionReduced } from '../../../src/renderer/src/lib/motion';

describe('the Motion setting', () => {
  it('follows the system when set to System', () => {
    expect(motionReduced('system', true)).toBe(true);
    expect(motionReduced('system', false)).toBe(false);
  });

  it('animates when set to On, even when the system asks for less motion', () => {
    expect(motionReduced('on', true)).toBe(false);
  });

  it('stays still when set to Reduced, whatever the system says', () => {
    expect(motionReduced('reduced', false)).toBe(true);
  });

  it('marks the page only for On and Reduced, so System is left to the media query', () => {
    expect(motionAttribute('system')).toBeNull();
    expect(motionAttribute('on')).toBe('full');
    expect(motionAttribute('reduced')).toBe('reduced');
  });
});
