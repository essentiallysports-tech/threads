import { Connection, Client } from "@temporalio/client";

async function main() {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS!,
    tls: true,
    apiKey: process.env.TEMPORAL_API_KEY!,
    metadata: { "temporal-namespace": process.env.TEMPORAL_NAMESPACE! },
  });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE! });
  const handle = client.workflow.getHandle(process.argv[2]);
  await handle.terminate("bugfix redeploy");
  console.log("terminated:", process.argv[2]);
}

main().catch((e) => {
  console.error("terminate failed:", e.message || e);
  process.exit(1);
});
