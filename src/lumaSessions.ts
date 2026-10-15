// Manual check of the Luma-via-Nango integration: prints the calendar's
// sessions as JSON, optionally with each session's guest list.
//
//   npm run luma:sessions -- [--after ISO] [--before ISO] [--series ID] [--tag NAME] [--guests]

import { listSessions, listSessionGuests } from "./lib/luma";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const sessions = await listSessions({
    after: arg("after"),
    before: arg("before"),
    seriesId: arg("series"),
    tag: arg("tag"),
  });
  const withGuests = process.argv.includes("--guests");
  const out = withGuests
    ? await Promise.all(sessions.map(async (s) => ({ ...s, guests: await listSessionGuests(s.id) })))
    : sessions;
  console.log(JSON.stringify(out, null, 2));
  console.error(`${sessions.length} session(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
