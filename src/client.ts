import { Connection, Client, ScheduleOverlapPolicy } from "@temporalio/client";
import { dailyRunWorkflow } from "./workflows/dailyRunWorkflow";

const TASK_QUEUE = "es-threads-daily-run";
const SCHEDULE_ID = "es-threads-hourly-run";

async function main() {
  const address = process.env.TEMPORAL_ADDRESS || "es-threads.eays8.tmprl.cloud:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE || "es-threads.eays8";
  const apiKey = process.env.TEMPORAL_API_KEY;
  if (!apiKey) throw new Error("TEMPORAL_API_KEY is not set");

  const connection = await Connection.connect({ address, tls: true, apiKey, metadata: { "temporal-namespace": namespace } });
  const client = new Client({ connection, namespace });

  const mode = process.argv[2] || "run-once";

  if (mode === "run-once") {
    const dateISO = new Date().toISOString().slice(0, 10);
    const handle = await client.workflow.start(dailyRunWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `daily-run-${dateISO}-${Date.now()}`,
      args: [{ dateISO, livePosting: process.env.LIVE_POSTING === "true", dailyBudgetMax: 8 }],
      // ⛔ OPERATOR FIX (2026-08-23, real live incident): neither this nor
      // the schedule's own action ever set a workflowExecutionTimeout —
      // Temporal's default is unbounded. A workflow execution that starts
      // failing its own task in a loop (confirmed cause: a checks.ts deploy
      // landing mid-flight, diverging replay from recorded history) runs
      // forever with no external signal, and ScheduleOverlapPolicy.SKIP then
      // silently skips every subsequent hourly fire behind it — this is
      // exactly how a single stuck execution caused a 22+ hour total outage
      // before anyone noticed.
      // ⛔ OPERATOR FIX (2026-08-25, explicit operator directive: "100 mins
      // is unacceptable... high volume but under 40 mins"). Lowered from 3
      // hours — that ceiling was set relative to the OLD 90-minute
      // RUN_TIME_BUDGET_MS; a live shard run today reached 100+ minutes
      // before being manually terminated, well within what "3 hours" would
      // have allowed. Scaled down to match the new 35-minute soft budget:
      // 1 hour gives real margin for Phase 2's own posting time above the
      // 40-minute target, while guaranteeing a genuinely stuck execution
      // self-terminates in well under half the time today's incident took,
      // with no manual intervention needed.
      workflowExecutionTimeout: "1 hour",
    });
    console.log(`Started workflow ${handle.workflowId}`);
    const result = await handle.result();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === "create-schedule") {
    // 8 posts/page/day is reached by firing this run multiple times a day —
    // hourly mirrors the old skill file's own Routine cadence; each run only
    // sources ONE candidate per page that hasn't hit its daily cap yet.
    await client.schedule.create({
      scheduleId: SCHEDULE_ID,
      spec: { intervals: [{ every: "1h" }] },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
      action: {
        type: "startWorkflow",
        workflowType: dailyRunWorkflow,
        taskQueue: TASK_QUEUE,
        // No dateISO here on purpose — the workflow computes "today" itself
        // from its own start time on every fire (see dailyRunWorkflow.ts).
        // A value baked in here at schedule-creation time would be wrong for
        // every fire after the first.
        args: [{ livePosting: process.env.LIVE_POSTING === "true", dailyBudgetMax: 8 }],
        // ⛔ OPERATOR FIX (2026-08-23, real live incident) — see the
        // run-once start call's own comment for the full incident. This is
        // the setting that actually matters, since every real production
        // fire goes through this schedule, not run-once. Lowered to 1 hour
        // 2026-08-25 — see run-once's own comment for the "100 mins is
        // unacceptable" directive this responds to.
        workflowExecutionTimeout: "1 hour",
      },
    });
    console.log(`Created schedule ${SCHEDULE_ID} (hourly)`);
    return;
  }

  // ⛔ OPERATOR FIX (2026-08-24, real live directive): "40+ pages now, so
  // daily 250+ posts are anyhow needed now... transform the system such
  // that it does not cause timeouts, it doesnt reduce the cadence." Replaces
  // the single `es-threads-hourly-run` schedule (one execution looping over
  // every page) with SHARD_COUNT independently-scheduled executions, each
  // handling only its slice of pages (dailyRunWorkflow.ts's shardIndex/
  // shardCount filter) — mirrors the FB pipeline's own proven SHARD MODE.
  // Staggered by 2 minutes per shard so they don't all hit ES-MCP/the AI
  // Gateway at the exact same instant (the real, confirmed cause of the
  // 2026-08-23 "operation was aborted" bursts clustering at the top of each
  // hour). The OLD schedule is explicitly paused (not deleted — reversible)
  // in the same run, since leaving both active would double-process every
  // page every hour.
  if (mode === "create-sharded-schedules") {
    const SHARD_COUNT = 6;
    try {
      await client.schedule.getHandle(SCHEDULE_ID).pause("superseded by sharded schedules");
      console.log(`Paused old schedule ${SCHEDULE_ID}`);
    } catch (e) {
      console.log(`Old schedule ${SCHEDULE_ID} not found or already paused/deleted — continuing (${(e as Error).message})`);
    }

    for (let i = 0; i < SHARD_COUNT; i++) {
      const shardScheduleId = `es-threads-hourly-run-shard-${i}`;
      await client.schedule.create({
        scheduleId: shardScheduleId,
        spec: { intervals: [{ every: "1h", offset: `${i * 2}m` }] },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
        action: {
          type: "startWorkflow",
          workflowType: dailyRunWorkflow,
          taskQueue: TASK_QUEUE,
          args: [{ livePosting: process.env.LIVE_POSTING === "true", dailyBudgetMax: 8, shardIndex: i, shardCount: SHARD_COUNT }],
          // Lowered from 3 hours 2026-08-25 — see run-once's own comment for
          // the "100 mins is unacceptable" directive this responds to; this
          // is the setting that actually governs live shard schedules.
          workflowExecutionTimeout: "1 hour",
        },
      });
      console.log(`Created schedule ${shardScheduleId} (hourly, offset +${i * 2}m, shard ${i}/${SHARD_COUNT})`);
    }
    return;
  }

  throw new Error(`Unknown mode: ${mode} (expected "run-once", "create-schedule", or "create-sharded-schedules")`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
