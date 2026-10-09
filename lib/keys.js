// The price services' API keys. They live in AWS Secrets Manager, where the
// owner pastes them; we read them when needed (and at most every few
// minutes), so a new key works without redeploying. Until a key is pasted
// in, its secret holds "not-set".
//
// On your own computer, set TRAVELPAYOUTS_TOKEN / SERPAPI_KEY instead.

const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const CACHE_MS = 5 * 60 * 1000;

function cleanKey(value) {
  const key = String(value || "").trim();
  return !key || key === "not-set" ? null : key;
}

/** `secrets` maps a key's name to its Secrets Manager secret name. */
function createKeys({ region, secrets = {}, env = process.env, client } = {}) {
  const sm = client || (Object.keys(secrets).length ? new SecretsManagerClient({ region }) : null);
  const cache = new Map();

  /** The key called `name` ("travelpayouts" or "serpapi"), or null if not set up. */
  async function get(name) {
    const fromEnv = cleanKey(env[`${name.toUpperCase()}_${name === "travelpayouts" ? "TOKEN" : "KEY"}`]);
    if (fromEnv) return fromEnv;
    const secretName = secrets[name];
    if (!secretName || !sm) return null;
    const hit = cache.get(name);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const out = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
    const value = cleanKey(out.SecretString);
    cache.set(name, { value, at: Date.now() });
    return value;
  }

  return { get };
}

module.exports = { createKeys, cleanKey };
