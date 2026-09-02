import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities/firehoseActivities";

// Own task queue, own PM2 process — deliberately isolated from
// es-threads-daily-run so this hourly job's deploys/restarts can never risk
// the main 6-shard pipeline's in-flight executions, and vice versa. Same
// Temporal Cloud namespace/credentials, just a different queue.
const TASK_QUEUE = "es-threads-firehose-run";

async function run() {
  const address = process.env.TEMPORAL_ADDRESS || "es-threads.eays8.tmprl.cloud:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE || "es-threads.eays8";
  const apiKey = process.env.TEMPORAL_API_KEY;
  if (!apiKey) throw new Error("TEMPORAL_API_KEY is not set");

  const connection = await NativeConnection.connect({
    address,
    tls: true,
    apiKey,
    metadata: { "temporal-namespace": namespace },
  });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows/firehoseWorkflow"),
    activities,
  });

  console.log(`[worker-firehose] connected to ${address}, namespace=${namespace}, taskQueue=${TASK_QUEUE}`);
  await worker.run();
}

run().catch((err) => {
  console.error("[worker-firehose] fatal:", err);
  process.exit(1);
});
