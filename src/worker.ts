import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";

const TASK_QUEUE = "es-threads-daily-run";

async function run() {
  const address = process.env.TEMPORAL_ADDRESS || "es-threads.eays8.tmprl.cloud:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE || "es-threads.eays8";
  const apiKey = process.env.TEMPORAL_API_KEY;
  if (!apiKey) throw new Error("TEMPORAL_API_KEY is not set");

  // Temporal Cloud's API-key auth path — no separate mTLS cert/key files
  // needed, unlike the older Temporal Cloud connection method.
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
    workflowsPath: require.resolve("./workflows/dailyRunWorkflow"),
    activities,
  });

  console.log(`[worker] connected to ${address}, namespace=${namespace}, taskQueue=${TASK_QUEUE}`);
  await worker.run();
}

run().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
