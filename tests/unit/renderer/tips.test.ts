import { describe, expect, it } from 'vitest';
import { motionTip } from '../../../src/renderer/src/lib/motion';

describe('the tip about motion', () => {
  it('offers to animate Graft when the system has animations off and Graft follows it', () => {
    let turnedOn = false;
    const tip = motionTip('system', true, 'Windows', () => (turnedOn = true));
    expect(tip?.id).toBe('motion-system-off');
    expect(tip?.text).toContain('Windows');
    tip?.run();
    expect(turnedOn).toBe(true);
  });

  it('says nothing when the system animates, or when the choice was already made in Graft', () => {
    expect(motionTip('system', false, 'Windows', () => undefined)).toBeNull();
    expect(motionTip('on', true, 'Windows', () => undefined)).toBeNull();
    expect(motionTip('reduced', true, 'Windows', () => undefined)).toBeNull();
  });
});
