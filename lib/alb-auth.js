// Works out who the load balancer says is signed in.
//
// The load balancer handles the actual sign-in (with the household sign-in,
// Amazon Cognito). For every request that reaches us it adds an
// "x-amzn-oidc-data" header: a small token saying who the person is, signed
// by the load balancer. We check that signature before trusting it, so a
// forged header can't pretend to be someone else.
//
// See: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html

const crypto = require("crypto");
const http = require("http");
const https = require("https");

function fetchText(url) {
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    client
      .get(url, { timeout: 3000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`key fetch returned ${res.statusCode}`));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("timeout", function () {
        this.destroy(new Error("key fetch timed out"));
      })
      .on("error", reject);
  });
}

// The load balancer's tokens use base64 that may keep "=" padding.
function decodePart(part) {
  return Buffer.from(part.replace(/=+$/, ""), "base64url");
}

/**
 * `trustedSigner` is our load balancer's ARN: tokens signed by any other load
 * balancer are ignored. `keysUrl` is where AWS publishes the signing keys.
 */
function createAlbAuth({ trustedSigner, keysUrl }) {
  // The load balancer's public keys rarely change; keep the ones we've fetched.
  const keyCache = new Map();

  async function publicKey(kid) {
    if (!/^[A-Za-z0-9-]+$/.test(kid)) throw new Error("bad key id");
    if (!keyCache.has(kid)) {
      keyCache.set(kid, crypto.createPublicKey(await fetchText(`${keysUrl}/${kid}`)));
    }
    return keyCache.get(kid);
  }

  /**
   * Returns { email, id } for the signed-in person, or null if the request
   * doesn't carry a valid, current sign-in from our load balancer.
   */
  async function signedInUser(req) {
    const token = req.headers["x-amzn-oidc-data"];
    if (!token || !trustedSigner) return null;
    try {
      const [headerPart, payloadPart, signaturePart] = token.split(".");
      const header = JSON.parse(decodePart(headerPart).toString("utf8"));
      if (header.alg !== "ES256" || header.signer !== trustedSigner) return null;

      const valid = crypto.verify(
        "sha256",
        Buffer.from(`${headerPart}.${payloadPart}`),
        { key: await publicKey(header.kid), dsaEncoding: "ieee-p1363" },
        decodePart(signaturePart),
      );
      if (!valid) return null;

      const claims = JSON.parse(decodePart(payloadPart).toString("utf8"));
      const expiry = claims.exp || header.exp;
      if (!expiry || expiry * 1000 < Date.now()) return null;
      if (!claims.email) return null;
      return { email: String(claims.email).toLowerCase(), id: claims.sub };
    } catch (err) {
      console.warn(`sign-in check failed: ${err.message}`);
      return null;
    }
  }

  return { signedInUser };
}

module.exports = { createAlbAuth };
