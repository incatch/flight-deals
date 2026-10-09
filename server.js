// The flight deals site: the web pages, plus the scanner and the emails,
// which run on a schedule inside the same container. Settings come from
// environment variables (set in infra/lib/flight-deals-stack.ts on AWS).

const http = require("http");
const { poolFromEnv, migrate, ensureDatabase } = require("./lib/db");
const { createStore } = require("./lib/store");
const { createSesSender, consoleSender } = require("./lib/mailer");
const { createAlbAuth } = require("./lib/alb-auth");
const { createKeys } = require("./lib/keys");
const { createSearchApi } = require("./lib/sources/searchapi");
const { createScanner } = require("./lib/scanner");
const { createAlerts } = require("./lib/alerts");
const { createScheduler } = require("./lib/scheduler");
const { createApp } = require("./lib/app");

async function main(env = process.env) {
  if (!env.APP_SECRET || env.APP_SECRET.length < 32) throw new Error("APP_SECRET must be set (32+ characters)");
  const siteUrl = env.SITE_URL || `http://localhost:${env.PORT || 8080}`;
  const timeZone = env.SITE_TIME_ZONE || "America/Chicago";
  const region = env.AWS_REGION || "us-east-2";

  await ensureDatabase(env);
  const pool = poolFromEnv(env);
  await migrate(pool);
  const store = createStore(pool);

  const keys = createKeys({
    region,
    secrets: env.SEARCHAPI_SECRET ? { searchapi: env.SEARCHAPI_SECRET } : {},
  });
  const alerts = createAlerts({
    store,
    sendEmail: env.EMAIL_FROM ? createSesSender({ region, from: env.EMAIL_FROM }) : consoleSender(),
    siteUrl,
  });
  const scanner = createScanner({
    store,
    keys,
    alerts,
    timeZone,
    searchapi: (apiKey) => createSearchApi({ apiKey }),
  });
  const auth = env.LOAD_BALANCER_ARN
    ? createAlbAuth({ trustedSigner: env.LOAD_BALANCER_ARN, keysUrl: `https://public-keys.auth.elb.${region}.amazonaws.com` })
    : // On your own computer (LOCAL_ADMIN=yes): the owner is signed in.
      { signedInUser: async () => (env.LOCAL_ADMIN === "yes" ? { email: String(env.OWNER_EMAIL || "").toLowerCase() } : null) };

  const admins = [env.OWNER_EMAIL, ...String(env.ADMIN_EMAILS || "").split(",")].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);
  const handler = createApp({
    store,
    alerts,
    scanner,
    auth,
    admins,
    secret: env.APP_SECRET,
    siteUrl,
    timeZone,
    keys,
    signOutUrl: env.SIGN_OUT_URL || null,
  });

  const port = Number(env.PORT || 8080);
  const server = http.createServer(handler);
  server.listen(port, () => console.log(`flight deals site listening on port ${port}`));

  const scheduler = createScheduler({ store, scanner, alerts, timeZone });
  if (env.SCHEDULER !== "off") scheduler.start();

  // Let Fargate stop the container cleanly during deploys.
  process.on("SIGTERM", () => {
    scheduler.stop();
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
