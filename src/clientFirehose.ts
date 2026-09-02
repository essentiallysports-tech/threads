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
    await client.schedule.create({
      scheduleId: SCHEDULE_ID,
      spec: { intervals: [{ every: "1h" }] },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
      action: {
        type: "startWorkflow",
        workflowType: firehoseWorkflow,
        taskQueue: TASK_QUEUE,
        args: [{ livePosting: process.env.LIVE_POSTING === "true", pageId: DEFAULT_PAGE_ID }],
        workflowExecutionTimeout: "30 minutes",
      },
    });
    console.log(`Created schedule ${SCHEDULE_ID} (hourly, page=${DEFAULT_PAGE_ID})`);
    return;
  }

  throw new Error(`Unknown mode: ${mode} (expected "run-once" or "create-schedule")`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
