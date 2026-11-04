import { canApply, isTerminal, TRANSITIONS } from './task-state.js';
import { TASK_STATUSES } from './task.model.js';

describe('task state machine', () => {
  it('only claims queued tasks', () => {
    expect(TASK_STATUSES.filter((s) => canApply('claim', s))).toEqual(['queued']);
  });

  it('lets workers finish running or cancel-requested tasks only', () => {
    for (const transition of ['complete', 'fail', 'heartbeat'] as const) {
      expect(TASK_STATUSES.filter((s) => canApply(transition, s))).toEqual(['running', 'cancel_requested']);
    }
  });

  it('cancels queued tasks directly and running tasks by request', () => {
    expect(TRANSITIONS.cancelQueued).toEqual({ from: ['queued'], to: 'canceled' });
    expect(TRANSITIONS.requestCancel).toEqual({ from: ['running'], to: 'cancel_requested' });
    expect(TRANSITIONS.acknowledgeCancel).toEqual({ from: ['cancel_requested'], to: 'canceled' });
  });

  it('never leaves a terminal state', () => {
    const terminal = TASK_STATUSES.filter(isTerminal);
    expect(terminal).toEqual(['completed', 'failed', 'canceled']);
    for (const transition of Object.keys(TRANSITIONS) as (keyof typeof TRANSITIONS)[]) {
      for (const status of terminal) {
        expect(canApply(transition, status)).toBe(false);
      }
    }
  });
});
