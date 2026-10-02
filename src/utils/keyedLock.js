/**
 * Runs async functions one at a time per key. Used so a WhatsApp session can never be
 * started, restarted or logged out concurrently (which would create duplicate sockets).
 */
export function createKeyedLock() {
  const tails = new Map();

  return {
    run(key, fn) {
      const previous = tails.get(key) || Promise.resolve();
      const result = previous.then(() => fn());
      const tail = result.then(() => undefined, () => undefined);
      tails.set(key, tail);
      tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    }
  };
}
