// One-off read-only auth check: confirms JIRA_BASE_URL / JIRA_EMAIL /
// JIRA_API_TOKEN (loaded via --env-file, from DEVLOOP_ENV_FILE or .env) work against the real Jira
// instance, without touching any tickets. Run with:
//   npm run check-auth

const baseUrl = process.env.JIRA_BASE_URL;
const email = process.env.JIRA_EMAIL;
const apiToken = process.env.JIRA_API_TOKEN;

const missing = [
  !baseUrl && "JIRA_BASE_URL",
  !email && "JIRA_EMAIL",
  !apiToken && "JIRA_API_TOKEN",
].filter(Boolean);

if (missing.length > 0) {
  console.error(`Missing env var(s): ${missing.join(", ")}`);
  console.error("Copy .env.example to .env and fill in real values, or set DEVLOOP_ENV_FILE to keep the file outside the repo.");
  process.exit(1);
}

const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

const response = await fetch(`${baseUrl}/rest/api/3/myself`, {
  headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
});

if (!response.ok) {
  console.error(`Auth check failed: ${response.status} ${response.statusText}`);
  console.error(await response.text());
  process.exit(1);
}

const me = await response.json();
console.log(`Auth OK: logged in as ${me.displayName} <${me.emailAddress}>`);
