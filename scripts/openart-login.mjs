// One-time interactive OAuth login for OpenArt's MCP endpoint — ported from
// es-automation-engine-backend's src/clients/mcp-login.ts + src/lib/mcp/oauth.ts
// (that repo's own tested implementation), adapted to not spawn a system
// browser: it prints the authorize URL and waits on the loopback callback,
// so it can be driven from an already-authenticated browser tab instead.
//
// Usage: node scripts/openart-login.mjs
//
// What it does:
// 1. Discover the authorization server via RFC 9728 (protected resource
//    metadata) then RFC 8414 (authorization server metadata).
// 2. Register this client dynamically (RFC 7591) — no pre-provisioned app.
// 3. Print the authorize URL (Authorization Code + PKCE, redirecting to a
//    local loopback server per RFC 8252 — the code never leaves this
//    machine, and PKCE binds it to this client, so no client secret exists
//    to leak).
// 4. Wait for the redirect, exchange the code, and store
//    {client_id, refresh_token, access_token, expires_at, token_endpoint,
//    resource, obtained_at} to S3 at config/fb-automation/openart_oauth.json.
//
// The actual login/consent happens on OpenArt's own real page in a browser —
// this script never sees a password, only the resulting authorization code.

import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf8").split("\n").forEach((line) => {
  const t = line.trim();
  if (!t || t.startsWith("#")) return;
  const eq = t.indexOf("=");
  if (eq === -1) return;
  process.env[t.slice(0, eq)] = t.slice(eq + 1);
});

const MCP_URL = process.env.OPENART_MCP_RESOURCE || "https://mcp.openart.ai/mcp";
const PORT = Number(process.env.MCP_OAUTH_PORT?.trim() || 53682);
const S3_BUCKET = process.env.S3_BUCKET || "essentiallysports-images-v2prod";
const S3_KEY = "config/fb-automation/openart_oauth.json";

async function getJson(url, label) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`oauth_${label}_${res.status}: ${url}`);
  return res.json();
}

async function discover(mcpUrl) {
  const url = new URL(mcpUrl);
  const candidates = [
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
  let resourceMeta;
  for (const candidate of candidates) {
    try {
      resourceMeta = await getJson(candidate, "protected_resource");
      break;
    } catch {
      /* try next */
    }
  }
  const issuer = resourceMeta?.authorization_servers?.[0] || url.origin;
  const asUrl = new URL(issuer);
  const metadata = await getJson(`${asUrl.origin}${asUrl.pathname.replace(/\/$/, "")}/.well-known/oauth-authorization-server`, "authorization_server");
  return {
    metadata,
    resource: resourceMeta?.resource || mcpUrl,
    scope: resourceMeta?.scopes_supported?.join(" ") || metadata.scopes_supported?.join(" "),
  };
}

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

async function registerClient(registrationEndpoint, redirectUri, scope) {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "ES Threads Temporal (worker)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope ? { scope } : {}),
    }),
  });
  if (!res.ok) throw new Error(`oauth_registration_${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (!json.client_id) throw new Error("oauth_registration: no client_id in response");
  return json.client_id;
}

async function postToken(endpoint, form) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(`oauth_token_${res.status}: ${json.error || ""} ${json.error_description || ""}`.trim());
  }
  return json;
}

function awaitRedirect(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const done = (message) => {
        res.writeHead(200, { "Content-Type": "text/html" }).end(`<html><body style="font:16px system-ui;padding:3rem"><h2>${message}</h2><p>You can close this tab.</p></body></html>`);
        server.close();
      };
      if (error) {
        done(`Authorization failed: ${error}`);
        reject(new Error(`oauth_denied: ${error}`));
        return;
      }
      if (!code || state !== expectedState) {
        done("Unexpected response — nothing was stored.");
        reject(new Error("oauth_state_mismatch: refusing the redirect"));
        return;
      }
      done("Authorized.");
      resolve(code);
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => console.log(`Listening for the OAuth redirect on http://127.0.0.1:${PORT}/callback ...`));
    setTimeout(() => {
      server.close();
      reject(new Error("oauth_timeout: no redirect within 5 minutes"));
    }, 300_000);
  });
}

async function main() {
  console.log(`\nOpenArt OAuth login\n  MCP endpoint: ${MCP_URL}`);

  const { metadata, resource, scope } = await discover(MCP_URL);
  console.log(`  authorization server: ${metadata.issuer}`);
  if (!metadata.registration_endpoint) {
    throw new Error("This server does not advertise dynamic client registration.");
  }

  const redirectUri = `http://127.0.0.1:${PORT}/callback`;
  const clientId = await registerClient(metadata.registration_endpoint, redirectUri, scope);
  console.log(`  registered client: ${clientId}`);

  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("hex");
  const authorizeUrl = new URL(metadata.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource,
    ...(scope ? { scope } : {}),
  })) authorizeUrl.searchParams.set(key, value);

  console.log(`\n=== AUTHORIZE_URL ===\n${authorizeUrl}\n=== END AUTHORIZE_URL ===\n`);
  console.log("Waiting for the redirect (open the URL above in a logged-in browser)...");

  const code = await awaitRedirect(state);
  const tokens = await postToken(metadata.token_endpoint, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
  });

  if (!tokens.refresh_token) {
    console.warn("\n⚠ The server returned NO refresh_token — workers will only get one hour of access.");
  }

  const stored = {
    client_id: clientId,
    refresh_token: tokens.refresh_token || "",
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    token_endpoint: metadata.token_endpoint,
    resource,
    obtained_at: new Date().toISOString(),
  };

  const s3 = new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
  });
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: S3_KEY, Body: JSON.stringify(stored, null, 2), ContentType: "application/json" }));

  console.log(`\n✔ Stored at s3://${S3_BUCKET}/${S3_KEY}\n  Verify with: node test-openart.js\n`);
}

main().catch((err) => {
  console.error(`\n✘ ${err.message || err}\n`);
  process.exit(1);
});
