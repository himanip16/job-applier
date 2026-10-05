import { EventEmitter } from 'node:events';
import type { RunEvent } from '@ja/shared';
import { prisma } from './db.js';

/**
 * In-process pub/sub for run events. The API layer subscribes and forwards to
 * browsers over SSE; the runner publishes. Every event is also persisted so a
 * page refresh can replay the whole history.
 */
class RunBus extends EventEmitter {
  async emitEvent(
    applicationId: string,
    type: string,
    message: string,
    data?: unknown,
  ): Promise<void> {
    const at = new Date();
    await prisma.applicationEvent.create({
      data: {
        applicationId,
        type,
        message,
        data: (data ?? undefined) as never,
      },
    });
    const evt: RunEvent = { applicationId, type, message, data, at: at.toISOString() };
    this.emit('event', evt);
    this.emit(`app:${applicationId}`, evt);
    // Mirror to stdout so the CLI path is usable without the UI.
    const tag = type.padEnd(16);
    process.stdout.write(`[${at.toISOString()}] ${tag} ${message}\n`);
  }
}

export const bus = new RunBus();
bus.setMaxListeners(0);
