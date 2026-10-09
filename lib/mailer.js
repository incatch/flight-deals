// Sends email (sign-up confirmations and deal alerts) through Amazon SES.
// The site's container is only allowed to send from its own address (see
// infra/lib/flight-deals-stack.ts).

const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");

function createSesSender({ region, from }) {
  const client = new SESv2Client({ region });
  return async function send({ to, subject, text, html, headers }) {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
            // Extra headers, e.g. List-Unsubscribe on marketing emails.
            ...(headers ? { Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
          },
        },
      }),
    );
  };
}

/** For running the site on your own computer: prints emails instead of sending them. */
function consoleSender(log = console) {
  return async ({ to, subject, text, headers }) => {
    const extra = headers ? Object.entries(headers).map(([k, v]) => `\n${k}: ${v}`).join("") : "";
    log.log(`[email to ${to}] ${subject}${extra}\n${text}`);
  };
}

module.exports = { createSesSender, consoleSender };
