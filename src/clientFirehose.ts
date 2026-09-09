import { Connection, Client, ScheduleOverlapPolicy } from "@temporalio/client";
import { firehoseWorkflow } from "./workflows/firehoseWorkflow";

const TASK_QUEUE = "es-threads-firehose-run";
const SCHEDULE_ID = "es-threads-firehose-hourly-run";
const DEFAULT_PAGE_ID = "p80";

function parseFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const address = process.env.TEMPORAL_ADDRESS || "es-threads.eays8.tmprl.cloud:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE || "es-threads.eays8";
  const apiKey = process.env.TEMPORAL_API_KEY;
  if (!apiKey) throw new Error("TEMPORAL_API_KEY is not set");

  const connection = await Connection.connect({ address, tls: true, apiKey, metadata: { "temporal-namespace": namespace } });
  const client = new Client({ connection, namespace });

  const mode = process.argv[2] || "run-once";
  const pageId = parseFlag("--page") || DEFAULT_PAGE_ID;
  // Override for testing only — undefined falls through to
  // firehoseWorkflow.ts's own DEFAULT_MAX_POSTS_PER_RUN (12/hour), not
  // unlimited. See that constant's comment for the live incident (shared
  // Postiz rate limit) that made "uncapped" not viable.
  const maxPostsFlag = parseFlag("--max-posts");
  const maxPostsThisRun = maxPostsFlag ? Number(maxPostsFlag) : undefined;

  if (mode === "run-once") {
    const handle = await client.workflow.start(firehoseWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `firehose-run-${pageId}-${Date.now()}`,
      args: [{ livePosting: process.env.LIVE_POSTING === "true", pageId, maxPostsThisRun }],
      workflowExecutionTimeout: "30 minutes",
    });
    console.log(`Started workflow ${handle.workflowId} (page=${pageId}, maxPostsThisRun=${maxPostsThisRun ?? "default cap (12)"})`);
    const result = await handle.result();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === "create-schedule") {
    // ⛔ OPERATOR ADD (2026-09-09): was hardcoded to SCHEDULE_ID/DEFAULT_PAGE_ID
    // (p80 only) — firehoseWorkflow.ts itself has always taken pageId as a
    // real parameter (see FirehoseRunOptions), this script's create-schedule
    // mode just never exposed that. --schedule-id/--page let this same
    // script stand up an independent hourly schedule for any additional
    // firehose page (e.g. a topically-scoped one) without colliding with or
    // overwriting p80's own schedule. Both flags default to the original
    // values, so the existing `create-schedule` invocation is unchanged.
    const scheduleId = parseFlag("--schedule-id") || SCHEDULE_ID;
    await client.schedule.create({
      scheduleId,
      spec: { intervals: [{ every: "1h" }] },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
      action: {
        type: "startWorkflow",
        workflowType: firehoseWorkflow,
        taskQueue: TASK_QUEUE,
        args: [{ livePosting: process.env.LIVE_POSTING === "true", pageId }],
        workflowExecutionTimeout: "30 minutes",
      },
    });
    console.log(`Created schedule ${scheduleId} (hourly, page=${pageId})`);
    return;
  }

  throw new Error(`Unknown mode: ${mode} (expected "run-once" or "create-schedule")`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
