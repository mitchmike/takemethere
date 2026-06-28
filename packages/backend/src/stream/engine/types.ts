import type { LivePosition } from '@takemethere/shared';

export interface PositionEngine {
  readonly name: string;
  interpolate(pos: LivePosition, nowSec: number): number;
  tryAdvanceSegment(pos: LivePosition, interpX: number, nowSec: number): LivePosition | null;
}
