/**
 * JobState FSM enum — all possible states a job can inhabit.
 *
 * Transitions:
 *   pending  → active    (worker picks up job)
 *   active   → done      (handler resolves)
 *   active   → failed    (handler throws, no retry)
 *   active   → retrying  (handler throws, retry scheduled)
 *   retrying → pending   (backoff delay expires)
 *   pending  → paused    (queue.pause())
 *   paused   → pending   (queue.resume())
 *   pending  → expired   (TTL exceeded before processing)
 *   failed   → dlq       (permanent failure captured by DLQ plugin)
 */
export var JobState;
(function (JobState) {
    JobState["PENDING"] = "pending";
    JobState["ACTIVE"] = "active";
    JobState["DONE"] = "done";
    JobState["FAILED"] = "failed";
    JobState["RETRYING"] = "retrying";
    JobState["PAUSED"] = "paused";
    JobState["EXPIRED"] = "expired";
    JobState["DLQ"] = "dlq";
})(JobState || (JobState = {}));
