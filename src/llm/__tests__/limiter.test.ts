import { describe, expect, it, vi } from 'vitest';
import { withSlot } from '../limiter';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => (release = resolve));
  return { promise, release };
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('backend concurrency', () => {
  it.each([1, 4, 6])('runs %i requests while the next waits', async limit => {
    const held = deferred();
    const started = vi.fn(() => held.promise);
    const requests = Array.from({ length: limit + 1 }, () => withSlot(`limit-${limit}`, limit, started));
    await tick();
    expect(started).toHaveBeenCalledTimes(limit);
    held.release();
    await Promise.all(requests);
    expect(started).toHaveBeenCalledTimes(limit + 1);
  });

  it('keeps independent backends running while another queue is full', async () => {
    const held = deferred();
    const first = withSlot('busy', 1, () => held.promise);
    const waiting = vi.fn(async () => undefined);
    const second = withSlot('busy', 1, waiting);
    await withSlot('independent', 1, async () => undefined);
    expect(waiting).not.toHaveBeenCalled();
    held.release();
    await Promise.all([first, second]);
  });

  it('removes a canceled waiter without consuming a slot or running it', async () => {
    const held = deferred();
    const first = withSlot('cancel', 1, () => held.promise);
    const controller = new AbortController();
    const canceled = vi.fn(async () => undefined);
    const second = withSlot('cancel', 1, canceled, controller.signal);
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    const third = withSlot('cancel', 1, async () => 'next');
    controller.abort();
    await rejected;
    held.release();
    expect(await third).toBe('next');
    await first;
    expect(canceled).not.toHaveBeenCalled();
  });

  it('does not dispatch an already canceled request', async () => {
    const fn = vi.fn(async () => undefined);
    await expect(withSlot('already-aborted', 4, fn, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('reserves a released slot for its waiter before a new request arrives', async () => {
    const firstHeld = deferred();
    const secondHeld = deferred();
    const started: number[] = [];
    const first = withSlot('fifo', 1, () => firstHeld.promise);
    const second = withSlot('fifo', 1, async () => {
      started.push(2);
      await secondHeld.promise;
    });
    firstHeld.release();
    await first;
    const third = withSlot('fifo', 1, async () => {
      started.push(3);
    });
    await tick();
    expect(started).toEqual([2]);
    secondHeld.release();
    await Promise.all([second, third]);
    expect(started).toEqual([2, 3]);
  });

  it('releases a slot after the request fails', async () => {
    const failed = withSlot('error', 1, async () => {
      throw new Error('request failed');
    });
    const next = withSlot('error', 1, async () => 'next');
    await expect(failed).rejects.toThrow('request failed');
    expect(await next).toBe('next');
  });
});
