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

// Handle newer in-app approval workflow (Robinhood "sheriff"/SUV verification).
// NOTE: the previous version polled /workflows/{id}/ which never reports the
// in-app approval, so it always timed out. The correct flow registers the
// workflow on a device "machine", then polls the prompt-status endpoint.
if (data.verification_workflow) {
  const workflowId = data.verification_workflow.id;

  // 1. Register the workflow on a device-approval machine.
  const machine = await rhPost("/pathfinder/user_machine/", {
    device_id: DEVICE_TOKEN,
    flow: "suv",
    input: { workflow_id: workflowId },
  });
  if (!machine?.id) {
    console.error("\n❌ Could not start verification:", JSON.stringify(machine, null, 2));
    rl.close();
    process.exit(1);
  }

  const inquiriesUrl = `${RH}/pathfinder/inquiries/${machine.id}/user_view/`;

  // 2. Ask Robinhood what kind of challenge it wants.
  const view = await fetch(inquiriesUrl, {
    headers: { "Content-Type": "application/json" },
  }).then(r => r.json()).catch(() => ({}));
  const challenge =
    view?.type_context?.context?.sheriff_challenge ||
    view?.context?.sheriff_challenge;
  if (!challenge?.id) {
    console.error("\n❌ Unexpected verification response:", JSON.stringify(view, null, 2));
    rl.close();
    process.exit(1);
  }

  if (challenge.type === "prompt") {
    // In-app approval. Poll the prompt-status endpoint until you tap Approve.
    console.log("\n📱 Open your Robinhood app (signed in with your NEW password) and approve the login request…");
    const promptUrl = `${RH}/push/${challenge.id}/get_prompts_status/`;
    let validated = false, last = null;
    for (let i = 0; i < 36; i++) { // up to ~3 minutes
      await new Promise(r => setTimeout(r, 5000));
      process.stdout.write(".");
      const s = await fetch(promptUrl, {
        headers: { "Content-Type": "application/json" },
      }).then(r => r.json()).catch(e => ({ _err: String(e) }));
      last = s;
      if (i === 0) console.log("\n   (status:", JSON.stringify(s) + ")");
      if (s?.challenge_status === "validated") { validated = true; break; }
    }
    if (!validated) {
      console.error("\n❌ Timed out. Last status from Robinhood:", JSON.stringify(last, null, 2));
      console.error("If status stayed 'issued'/'pending', the prompt never reached an approved device — make sure the Robinhood app is signed in with your new password and notifications are on.");
      rl.close();
      process.exit(1);
    }
  } else if (challenge.type === "sms" || challenge.type === "email") {
    // Code-based challenge.
    console.log(`\nRobinhood sent a ${challenge.type.toUpperCase()} code.`);
    const code = await ask("Enter the code: ");
    await fetch(`${RH}/challenge/${challenge.id}/respond/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: code }),
    });
  }

  // 3. Tell the inquiry to continue, then re-request the token.
  await rhPost(`/pathfinder/inquiries/${machine.id}/user_view/`, {
    sequence: 0,
    user_input: { status: "continue" },
  });
  console.log("\n✅ Approved! Getting token…");
  data = await rhPost("/oauth2/token/", baseBody);
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
