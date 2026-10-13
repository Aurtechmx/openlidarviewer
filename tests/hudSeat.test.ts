import { describe, it, expect } from 'vitest';
import { seatShift } from '../src/ui/hudSeat';

const box = (top: number, bottom: number): DOMRect => ({ top, bottom, left: 0, right: 100, x: 0, y: top, width: 100, height: bottom - top, toJSON: () => ({}) });

describe('seatShift', () => {
  it('leaves a surface that meets nothing where it is', () => {
    expect(seatShift(60, 120, [box(200, 240)], 'down', 400)).toBe(0);
    expect(seatShift(600, 640, [box(500, 540)], 'up', 400)).toBe(0);
  });

  it('drops below a top box it overlaps, by the gap', () => {
    // Lane at 66..150 under a progress toast at 56..92.
    expect(seatShift(66, 150, [box(56, 92)], 'down', 400)).toBe(92 + 8 - 66);
  });

  it('keeps dropping when clearing one box lands on the next', () => {
    expect(seatShift(60, 100, [box(56, 90), box(100, 140)], 'down', 400)).toBe(140 + 8 - 60);
  });

  it('lifts above a bottom box it overlaps, by the gap', () => {
    // Hold-Space hint at 834..882 over a bottom toast at 816..892.
    expect(seatShift(834, 882, [box(816, 892)], 'up', 512)).toBe(882 - (816 - 8));
  });

  it('ignores boxes in the other half of the viewport', () => {
    expect(seatShift(380, 600, [box(450, 500)], 'down', 400)).toBe(0);
    expect(seatShift(300, 640, [box(100, 350)], 'up', 400)).toBe(0);
  });
});

describe('seatShift clamp', () => {
  it('never lifts a surface above 8 px from the top edge', () => {
    // A 40 px surface at 30..70 over a box that would ask for a 200 px lift.
    expect(seatShift(30, 70, [box(0, 90)], 'up', 10)).toBe(22);
  });
});
