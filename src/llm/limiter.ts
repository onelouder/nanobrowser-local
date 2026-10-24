interface Waiter {
  max: number;
  start: () => void;
}

interface Slots {
  active: number;
  queue: Waiter[];
}

const slots = new Map<string, Slots>();

function drain(slot: Slots): void {
  while (slot.queue.length && slot.active < slot.queue[0].max) {
    const waiter = slot.queue.shift()!;
    // Reserve before waking the waiter, so a new request cannot take its slot.
    slot.active++;
    waiter.start();
  }
}

function acquire(slot: Slots, max: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const waiter: Waiter = {
      max,
      start: () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      },
    };
    const abort = () => {
      slot.queue.splice(slot.queue.indexOf(waiter), 1);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason);
      drain(slot);
    };
    signal?.addEventListener('abort', abort, { once: true });
    slot.queue.push(waiter);
    drain(slot);
  });
}

/** Runs `fn` when one of `max` slots for `key` is free. */
export async function withSlot<T>(key: string, max: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let slot = slots.get(key);
  if (!slot) slots.set(key, (slot = { active: 0, queue: [] }));
  await acquire(slot, max, signal);
  try {
    signal?.throwIfAborted();
    return await fn();
  } finally {
    slot.active--;
    drain(slot);
    if (!slot.active && !slot.queue.length) slots.delete(key);
  }
}
