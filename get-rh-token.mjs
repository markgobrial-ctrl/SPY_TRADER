/**
 * get-rh-token.mjs
 * Run once locally to get a Robinhood OAuth token for Render.
 * Usage: node get-rh-token.mjs
 */
import readline from "readline";

const CLIENT_ID = "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS";
const DEVICE_TOKEN = "a3244b17-5aab-4c8e-9e4d-2b4f3a8ecb4a";
const RH = "https://api.robinhood.com";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const username = await ask("Robinhood email: ");
const password = await ask("Robinhood password: ");

const baseBody = {
  username,
  password,
  grant_type: "password",
  client_id: CLIENT_ID,
  expires_in: 86400,
  scope: "internal",
  device_token: DEVICE_TOKEN,
};

async function rhPost(path, body, extraHeaders = {}) {
  const r = await fetch(`${RH}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  return r.json();
}

let data = await rhPost("/oauth2/token/", baseBody);

// Handle device challenge (SMS/email code)
if (data.challenge) {
  const { id, type } = data.challenge;
  console.log(`\nRobinhood sent a ${type.toUpperCase()} verification code.`);
  const code = await ask("Enter the code: ");
  await fetch(`${RH}/challenge/${id}/respond/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response: code }),
  });
  data = await rhPost("/oauth2/token/", baseBody, {
    "X-Robinhood-Challenge-Response-Id": id,
  });
}

// Handle newer in-app approval workflow
if (data.verification_workflow) {
  const workflowId = data.verification_workflow.id;
  console.log("\n📱 Check your Robinhood app — approve the login request there.");
  console.log("Waiting for approval", { workflowId });

  // Poll until approved (up to 2 minutes)
  let approved = false;
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000)); // wait 5s
    process.stdout.write(".");
    const status = await fetch(`${RH}/workflows/${workflowId}/`, {
      headers: { "Content-Type": "application/json" },
    }).then(r => r.json()).catch(() => ({}));

    if (status?.workflow_status === "workflow_status_approved" ||
        status?.workflow_status === "workflow_status_completed") {
      approved = true;
      break;
    }
  }

  if (!approved) {
    console.error("\n❌ Timed out waiting for app approval. Try again.");
    rl.close();
    process.exit(1);
  }

  console.log("\n✅ Approved! Getting token...");
  data = await rhPost("/oauth2/token/", {
    ...baseBody,
    verification_workflow_id: workflowId,
  });
}

// Handle explicit MFA (TOTP / SMS code)
if (data.mfa_required) {
  const code = await ask(`MFA code (${data.mfa_type}): `);
  data = await rhPost("/oauth2/token/", { ...baseBody, mfa_code: code });
}

if (!data.access_token) {
  console.error("\n❌ Auth failed:", JSON.stringify(data, null, 2));
  rl.close();
  process.exit(1);
}

console.log("\n✅  Success! Add these to Render → Environment:\n");
console.log("ROBINHOOD_TOKEN=" + data.access_token);
if (data.refresh_token) {
  console.log("ROBINHOOD_REFRESH_TOKEN=" + data.refresh_token);
  console.log("\nThe refresh token is long-lived — set it once and you're done.");
  console.log("The server will automatically refresh the access token when it expires.");
} else {
  console.log(`\nAccess token expires in ${Math.round(data.expires_in / 3600)} hours.`);
}
rl.close();
