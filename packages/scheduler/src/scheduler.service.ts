/**
 * A handler invoked when a scheduled job fires. Receives the `data` that was
 * passed to `scheduleOnce` for that job.
 */
export type SchedulerHandler = (data: unknown) => void;

/**
 * In-memory, `setTimeout`-based job scheduler.
 *
 * This is a v0.1.0 stub: scheduled jobs live only in process memory and are
 * lost on restart. It exists to unblock callers (e.g. the round-orchestrator)
 * that need `scheduleOnce`/`cancel` today. A later ticket will swap the
 * internals for a BullMQ/Redis-backed implementation with the same public
 * interface, so this class is intentionally kept to that minimal surface —
 * callers should not depend on anything beyond `scheduleOnce`, `cancel`, and
 * `registerHandler`.
 */
export class SchedulerService {
    private readonly handlers = new Map<string, SchedulerHandler>();
    private readonly pendingJobs = new Map<
        string,
        { timeout: NodeJS.Timeout; queue: string }
    >();

    /**
     * Registers the handler that will be invoked for jobs scheduled on
     * `queue`. Registering a new handler for a queue replaces the previous
     * one.
     */
    registerHandler(queue: string, handler: SchedulerHandler): void {
        this.handlers.set(queue, handler);
    }

    /**
     * Schedules `data` to be delivered to `queue`'s registered handler once,
     * at `dueAt`. If `dueAt` is in the past, the handler fires on the next
     * tick.
     *
     * If a pending job already exists for `jobId`, it is replaced.
     */
    scheduleOnce(jobId: string, dueAt: Date, queue: string, data: unknown): void {
        this.cancel(jobId, queue);

        const delayMs = Math.max(0, dueAt.getTime() - Date.now());

        const timeout = setTimeout(() => {
            this.pendingJobs.delete(jobId);

            const handler = this.handlers.get(queue);
            if (handler) {
                handler(data);
            }
        }, delayMs);

        this.pendingJobs.set(jobId, { timeout, queue });
    }

    /**
     * Cancels a previously scheduled job, if one is still pending for
     * `jobId` on `queue`. No-op if the job doesn't exist, already fired, or
     * was scheduled on a different queue.
     */
    cancel(jobId: string, queue: string): void {
        const job = this.pendingJobs.get(jobId);
        if (!job || job.queue !== queue) {
            return;
        }

        clearTimeout(job.timeout);
        this.pendingJobs.delete(jobId);
    }
}
