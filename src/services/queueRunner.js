import { EventEmitter } from 'node:events';

/**
 * Sends queued messages: at most one message in flight per session, a randomised gap between
 * consecutive sends of the same session, sessions processed in parallel. Transient errors are retried.
 * An optional `gate` (see sendGate.js) decides per message to send, defer or skip it.
 */
export function createQueueRunner({
  queue,
  getReadySessionIds,
  sendItem,
  sendIntervalMinMs,
  sendIntervalMaxMs,
  pollMs = 1000,
  maxAttempts = 3,
  retryDelayMs = 30000,
  maxAgeMs = 0,
  onResult = null,
  gate = null,
  maxDecisionsPerTick = 50,
  now = Date.now,
  random = Math.random,
  logger = null
}) {
  const results = new EventEmitter();
  results.setMaxListeners(0);
  const inFlight = new Map();
  const nextAllowedAt = new Map();
  let timer = null;
  let running = false;
  let ticking = false;
  let lastExpiryCheck = 0;

  const gap = () => Math.round(sendIntervalMinMs + random() * (sendIntervalMaxMs - sendIntervalMinMs));

  function notify(id, result) {
    results.emit(`done:${id}`, { id, ...result });
  }

  function finish(item, result) {
    notify(item.id, result);
    try {
      onResult?.({ id: item.id, sessionId: item.session_id, to: item.target_jid, ...result });
    } catch (error) {
      logger?.error({ err: error }, 'Queue result callback failed');
    }
  }

  async function handleFailure(item, error) {
    // AppError 4xx means bad input (invalid media URL, unsupported type): retrying cannot help
    const retryable = !(error.status >= 400 && error.status < 500);
    if (retryable && item.attempts < maxAttempts) {
      await queue.requeue(item.id, error.message, retryDelayMs * item.attempts);
      logger?.warn({ queueId: item.id, sessionId: item.session_id, attempt: item.attempts, err: error.message }, 'Send failed, message requeued');
      return;
    }
    await queue.markFailed(item.id, error.message);
    logger?.warn({ queueId: item.id, sessionId: item.session_id, err: error.message }, 'Message failed');
    finish(item, { status: 'failed', error: error.message, httpStatus: error.status ?? null });
  }

  async function decide(item) {
    if (!gate) return { action: 'send', newContact: false };
    try {
      return await gate.evaluate(item);
    } catch (error) {
      // Never send unchecked: try again later
      logger?.error({ queueId: item.id, sessionId: item.session_id, err: error }, 'Send guard failed, message deferred');
      return { action: 'defer', until: new Date(now() + retryDelayMs), reason: `send guard unavailable: ${error.message}` };
    }
  }

  /** @returns {Promise<'sent' | 'failed' | 'deferred' | 'skipped'>} */
  async function processItem(item) {
    const decision = await decide(item);
    if (decision.action === 'defer') {
      // At least a second ahead, so a bad decision cannot spin on the same message
      const until = new Date(Math.max(new Date(decision.until).getTime(), now() + 1000));
      await queue.defer(item.id, until, decision.reason);
      notify(item.id, { status: 'queued', deferredUntil: until, reason: decision.reason });
      return 'deferred';
    }
    if (decision.action === 'skip') {
      await queue.markSkipped(item.id, decision.reason);
      logger?.info({ queueId: item.id, sessionId: item.session_id, reason: decision.reason }, 'Message skipped by the send guard');
      finish(item, { status: 'skipped', error: decision.reason });
      return 'skipped';
    }

    let messageId;
    try {
      messageId = await sendItem(item);
    } catch (error) {
      await handleFailure(item, error);
      return 'failed';
    }
    gate?.recordSent(item, decision);
    try {
      await queue.markSent(item.id, messageId, { newContact: Boolean(decision.newContact) });
    } catch (error) {
      // The message is out: never retry it. The row stays "processing" and is failed on restart.
      logger?.error({ queueId: item.id, err: error }, 'Message sent but its queue status could not be updated');
    }
    finish(item, { status: 'sent', messageId });
    return 'sent';
  }

  /** Works through deferred/skipped messages until one is actually sent (or tried). True when one was. */
  async function runSession(sessionId) {
    for (let decisions = 0; decisions < maxDecisionsPerTick; decisions += 1) {
      const item = await queue.claimNext(sessionId);
      if (!item) return false;
      const outcome = await processItem(item);
      if (outcome === 'sent' || outcome === 'failed') return true;
    }
    return false;
  }

  async function expireStale() {
    if (!maxAgeMs || now() - lastExpiryCheck < 60000) return;
    lastExpiryCheck = now();
    for (const row of await queue.expireStale(maxAgeMs)) {
      finish(row, { status: 'expired' });
    }
  }

  async function tick() {
    if (!running || ticking) return;
    ticking = true;
    try {
      await expireStale();
      const ready = new Set(getReadySessionIds());
      const due = (await queue.dueSessionIds()).filter((sessionId) => ready.has(sessionId));
      for (const sessionId of due) {
        if (inFlight.has(sessionId) || (nextAllowedAt.get(sessionId) ?? 0) > now()) continue;
        const work = runSession(sessionId)
          .catch((error) => {
            logger?.error({ sessionId, err: error }, 'Queue processing failed');
            return false;
          })
          .then((processed) => {
            if (processed) nextAllowedAt.set(sessionId, now() + gap());
            inFlight.delete(sessionId);
          });
        inFlight.set(sessionId, work);
      }
    } catch (error) {
      logger?.error({ err: error }, 'Queue tick failed');
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      timer = setInterval(tick, pollMs);
      setImmediate(tick);
    },
    /** Runs a tick now (e.g. right after enqueueing) instead of waiting for the next poll. */
    wake() {
      if (running) setImmediate(tick);
    },
    /** Stops polling and waits for in-flight sends to finish. */
    async stop() {
      running = false;
      clearInterval(timer);
      await Promise.allSettled([...inFlight.values()]);
    },
    /** Resolves with the final result of a queue item, or null after `timeoutMs`. */
    waitFor(id, timeoutMs) {
      return new Promise((resolve) => {
        const onDone = (result) => {
          clearTimeout(timeout);
          resolve(result);
        };
        const timeout = setTimeout(() => {
          results.off(`done:${id}`, onDone);
          resolve(null);
        }, timeoutMs);
        results.once(`done:${id}`, onDone);
      });
    },
    notify
  };
}
