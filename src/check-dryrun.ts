import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const Bucket = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const dateISO = new Date().toISOString().slice(0, 10);

s3.send(new GetObjectCommand({ Bucket, Key: `pool/temporal_dry_run_${dateISO}.json` }))
  .then(async (res) => {
    const body = await res.Body!.transformToString();
    const results = JSON.parse(body);
    console.log(`Total results: ${results.length}`);
    const byOutcome: Record<string, number> = {};
    for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
    console.log("By outcome:", byOutcome);
    console.log("\nSample (first 5):");
    console.log(JSON.stringify(results.slice(0, 5), null, 2));
  })
  .catch((e) => {
    console.error("FAILED:", e.message || e);
    process.exit(1);
  });
