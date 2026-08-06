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
      },
    });
    console.log(`Created schedule ${SCHEDULE_ID} (hourly)`);
    return;
  }

  throw new Error(`Unknown mode: ${mode} (expected "run-once" or "create-schedule")`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
