// Dead reckoning is handled per-dot inside TrainDot.tsx via useAnimationFrame.
// Each dot independently interpolates toward its next stop using nextArrivalEpoch.
export function useDeadReckoning(): void {}
