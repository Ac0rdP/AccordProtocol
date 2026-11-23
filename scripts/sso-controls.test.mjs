import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authorize, readAuditLog, verifyAuditLog } from "./security-controls.mjs";
import {
  applySsoRolesToPolicy,
  authenticateSso,
  createSsoSession,
  deprovisionSsoUser,
  evaluateSsoSession,
  main,
  mapGroupsToRoles,
  provisionSsoUser,
  validateSsoConfig,
} from "./sso-controls.mjs";

const now = new Date("2026-11-19T12:00:00Z");
const t = Math.floor(now.getTime() / 1000);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
const FINGERPRINT = "AB:".repeat(31) + "AB";

function config() {
  return {
    clockSkewSeconds: 60,
    providers: [
      {
        id: "acme-oidc",
        team: "treasury-team",
        protocol: "oidc",
        issuer: "https://idp.acme.example",
        audience: "accord-client",
        allowedDomains: ["acme.example"],
        jwks: {
          keys: [
            { ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa-1", alg: "RS256" },
            { ...ec.publicKey.export({ format: "jwk" }), kid: "ec-1", alg: "ES256" },
          ],
        },
      },
      {
        id: "acme-saml",
        team: "treasury-team",
        protocol: "saml",
        issuer: "http://www.okta.com/exk123",
        audience: "https://accord.example/saml/metadata",
        allowedDomains: ["acme.example"],
        signingCertFingerprints: [FINGERPRINT],
      },
    ],
    jit: {
      enabled: true,
      allowedRoles: ["treasury_operator", "security_auditor"],
      groupRoles: { "accord-treasury": ["treasury_operator"], "accord-audit": ["security_auditor"] },
    },
    session: {
      maxAgeMinutes: 480,
      idleTimeoutMinutes: 30,
      requireMfa: true,
      reauthMinutesForActions: { treasury_transfer: 15 },
    },
  };
}

function jwt(claims, { kid = "rsa-1", alg = "RS256", key = rsa.privateKey } = {}) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${enc({ alg, kid, typ: "JWT" })}.${enc(claims)}`;
  const signature =
    alg === "ES256"
      ? sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" })
      : alg === "none"
        ? Buffer.alloc(0)
        : sign("sha256", Buffer.from(input), key);
  return `${input}.${signature.toString("base64url")}`;
}

function oidcClaims(overrides = {}) {
  return {
    iss: "https://idp.acme.example",
    aud: "accord-client",
    sub: "00u-alice",
    email: "Alice@acme.example",
    email_verified: true,
    groups: ["accord-treasury", "unrelated"],
    amr: ["pwd", "mfa"],
    iat: t - 10,
    exp: t + 300,
    nonce: "n-1",
    jti: "jti-1",
    ...overrides,
  };
}

function samlAssertion(overrides = {}) {
  return {
    signatureVerified: true,
    signingCertFingerprint: FINGERPRINT.toLowerCase(),
    issuer: "http://www.okta.com/exk123",
    audience: "https://accord.example/saml/metadata",
    id: "_assertion-1",
    nameId: "bob@acme.example",
    notBefore: new Date(now.getTime() - 60000).toISOString(),
    notOnOrAfter: new Date(now.getTime() + 300000).toISOString(),
    sessionNotOnOrAfter: new Date(now.getTime() + 3600000).toISOString(),
    authnContextClassRef: "https://refeds.org/profile/mfa",
    attributes: { email: "bob@acme.example", groups: ["accord-audit"] },
    ...overrides,
  };
}

const oidcLogin = (claims, opts) =>
  authenticateSso(config(), { providerId: "acme-oidc", idToken: jwt(claims, opts), nonce: "n-1" }, { now, replayCache: {} });

test("config validation fails closed on unsafe settings", () => {
  assert.doesNotThrow(() => validateSsoConfig(config()));
  const cases = [
    [(c) => (c.providers = []), /at least one provider/],
    [(c) => (c.providers[1].id = "acme-oidc"), /duplicate sso provider/],
    [(c) => (c.providers[0].allowedDomains = []), /allowedDomains/],
    [(c) => (c.providers[1].signingCertFingerprints = ["not-a-sha256"]), /SHA-256/],
    [(c) => (c.providers[0].jwks.keys[0].d = "secret"), /private or symmetric/],
    [(c) => (c.providers[0].allowedAlgorithms = ["HS256"]), /unsupported algorithm HS256/],
    [(c) => (c.providers[0].protocol = "ldap"), /unsupported protocol/],
    [(c) => (c.jit.groupRoles.admins = ["treasury_admin"]), /not in jit.allowedRoles/],
    [(c) => c.jit.allowedRoles.push("policy_admin"), /protected role policy_admin/],
    [(c) => (c.session.idleTimeoutMinutes = 600), /idleTimeoutMinutes/],
  ];
  for (const [mutate, error] of cases) {
    const c = config();
    mutate(c);
    assert.throws(() => validateSsoConfig(c), error);
  }
});

test("OIDC: verifies RS256 and ES256 tokens and normalizes identity", () => {
  const identity = oidcLogin(oidcClaims());
  assert.equal(identity.subject, "00u-alice");
  assert.equal(identity.email, "alice@acme.example");
  assert.equal(identity.mfa, true);
  assert.deepEqual(identity.groups, ["accord-treasury", "unrelated"]);

  const ecIdentity = oidcLogin(oidcClaims({ jti: "jti-ec" }), { kid: "ec-1", alg: "ES256", key: ec.privateKey });
  assert.equal(ecIdentity.subject, "00u-alice");
});

test("OIDC: rejects forged, mis-addressed, stale and downgraded tokens", () => {
  assert.throws(() => oidcLogin(oidcClaims(), { key: attacker.privateKey }), /signature is invalid/);
  assert.throws(() => oidcLogin(oidcClaims(), { alg: "none" }), /algorithm not allowed: none/);
  assert.throws(() => oidcLogin(oidcClaims(), { kid: "unknown" }), /not pinned/);
  assert.throws(() => oidcLogin(oidcClaims(), { kid: "ec-1", alg: "RS256" }), /does not match pinned key/);
  assert.throws(() => oidcLogin(oidcClaims({ iss: "https://evil.example" })), /issuer mismatch/);
  assert.throws(() => oidcLogin(oidcClaims({ aud: "other-client" })), /audience mismatch/);
  assert.throws(() => oidcLogin(oidcClaims({ aud: ["accord-client", "x"], azp: "x" })), /authorized party/);
  assert.throws(() => oidcLogin(oidcClaims({ exp: t - 120 })), /expired/);
  assert.throws(() => oidcLogin(oidcClaims({ iat: t + 600 })), /issued in the future/);
  assert.throws(() => oidcLogin(oidcClaims({ nonce: "other" })), /nonce mismatch/);
  assert.throws(() => oidcLogin(oidcClaims({ email_verified: false })), /verified email/);
  assert.throws(() => oidcLogin(oidcClaims({ email: "mallory@evil.example" })), /domain not allowed: evil.example/);
  assert.throws(() => oidcLogin(oidcClaims({ amr: ["pwd"] })), /multi-factor/);
  assert.throws(
    () => authenticateSso(config(), { providerId: "nope", idToken: "a.b.c" }, { now }),
    /unknown sso provider/
  );
});

test("SAML: enforces verified signature, pinned cert, window and replay", () => {
  const cache = {};
  const login = (overrides) =>
    authenticateSso(config(), { providerId: "acme-saml", assertion: samlAssertion(overrides) }, { now, replayCache: cache });

  const identity = login();
  assert.equal(identity.protocol, "saml");
  assert.equal(identity.subject, "bob@acme.example");
  assert.throws(() => login(), /replayed/);

  assert.throws(() => login({ id: "_2", signatureVerified: false }), /not verified/);
  assert.throws(() => login({ id: "_3", signingCertFingerprint: "cd".repeat(32) }), /not pinned/);
  assert.throws(() => login({ id: "_4", audience: "https://other" }), /audience mismatch/);
  assert.throws(() => login({ id: "_5", notOnOrAfter: new Date(now.getTime() - 120000).toISOString() }), /expired/);
  assert.throws(() => login({ id: "_6", notBefore: new Date(now.getTime() + 120000).toISOString() }), /not yet valid/);
  assert.throws(() => login({ id: "_7", authnContextClassRef: "urn:oasis:names:tc:SAML:2.0:ac:classes:Password" }), /multi-factor/);
});

test("JIT provisioning maps groups to allowed roles and follows IdP changes", () => {
  const cfg = config();
  const users = { users: [] };
  const first = provisionSsoUser(cfg, users, oidcLogin(oidcClaims()), { now });
  assert.equal(first.created, true);
  assert.equal(first.user.actor, "sso:acme-oidc:00u-alice");
  assert.deepEqual(first.user.roles, ["treasury_operator"]);

  const moved = provisionSsoUser(cfg, users, oidcLogin(oidcClaims({ jti: "j2", groups: ["accord-audit"] })), { now });
  assert.deepEqual(moved.added, ["security_auditor"]);
  assert.deepEqual(moved.removed, ["treasury_operator"]);

  // A tampered config cannot smuggle a protected role through JIT.
  cfg.jit.groupRoles["accord-audit"].push("policy_admin");
  cfg.jit.allowedRoles.push("policy_admin");
  assert.deepEqual(mapGroupsToRoles(cfg, ["accord-audit"]), ["security_auditor"]);

  const noJit = { ...config(), jit: { ...config().jit, enabled: false } };
  assert.throws(() => provisionSsoUser(noJit, { users: [] }, oidcLogin(oidcClaims({ jti: "j3" })), { now }), /jit is disabled/);
});

test("sessions enforce max age, idle timeout, step-up re-auth and revocation", () => {
  const cfg = config();
  const users = { users: [] };
  const sessions = { sessions: [] };
  const identity = authenticateSso(cfg, { providerId: "acme-saml", assertion: samlAssertion() }, { now });
  const { user } = provisionSsoUser(cfg, users, identity, { now });
  const { token, session } = createSsoSession(cfg, sessions, user, identity, { now });

  assert.ok(!JSON.stringify(sessions).includes(token), "plaintext session token must not be stored");
  assert.equal(session.expiresAt, samlAssertion().sessionNotOnOrAfter, "IdP session limit caps max age");

  const at = (minutes) => new Date(now.getTime() + minutes * 60000);
  assert.equal(evaluateSsoSession(cfg, sessions, { token, now: at(10) }).actor, user.actor);
  assert.throws(() => evaluateSsoSession(cfg, sessions, { token, action: "treasury_transfer", now: at(20) }), /re-authentication required/);
  assert.throws(() => evaluateSsoSession(cfg, sessions, { token, now: at(55) }), /idle timeout/);
  assert.throws(() => evaluateSsoSession(cfg, sessions, { token, now: at(61) }), /expired/);
  assert.throws(() => evaluateSsoSession(cfg, sessions, { token: "accord_sso_guess", now }), /not found/);

  const second = createSsoSession(cfg, sessions, user, identity, { now });
  const result = deprovisionSsoUser(users, sessions, { actor: user.actor, reason: "left company", now });
  assert.equal(result.revokedSessions, 2);
  assert.throws(() => evaluateSsoSession(cfg, sessions, { token: second.token, now }), /revoked/);
  assert.throws(() => provisionSsoUser(cfg, users, identity, { now }), /suspended/);
  assert.throws(() => createSsoSession(cfg, sessions, { ...user, status: "active", roles: [] }, identity, { now }), /no mapped roles/);
});

test("policy sync only touches SSO actors and keeps existing authorization", () => {
  const policy = {
    roles: { "sec-admin": ["policy_admin"], "sso:stale:1": ["treasury_operator"] },
    permissions: { policy_change: ["policy_admin"], treasury_transfer: ["treasury_operator"] },
  };
  const users = {
    users: [
      { actor: "sso:acme-oidc:alice", status: "active", roles: ["treasury_operator"] },
      { actor: "sso:acme-oidc:carol", status: "suspended", roles: [] },
    ],
  };
  const next = applySsoRolesToPolicy(policy, users);
  assert.deepEqual(next.roles, { "sec-admin": ["policy_admin"], "sso:acme-oidc:alice": ["treasury_operator"] });
  assert.doesNotThrow(() => authorize(next, "sso:acme-oidc:alice", "treasury_transfer"));
  assert.throws(() => authorize(next, "sso:acme-oidc:alice", "policy_change"), /authorization denied/);
  assert.throws(() => authorize(next, "sso:stale:1", "treasury_transfer"), /authorization denied/);
});

test("CLI login provisions, issues a session and writes a verifiable audit chain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "accord-sso-"));
  const paths = Object.fromEntries(
    ["config", "users", "sessions", "replay", "audit", "token"].map((n) => [n, join(dir, `${n}.json`)])
  );
  writeFileSync(paths.config, JSON.stringify(config()));
  // The CLI uses the real clock, so mint the token relative to it.
  const realNow = Math.floor(Date.now() / 1000);
  writeFileSync(paths.token, jwt(oidcClaims({ iat: realNow - 10, exp: realNow + 300 })));
  const args = [
    "login",
    `--config=${paths.config}`,
    "--provider=acme-oidc",
    `--id-token=${paths.token}`,
    "--nonce=n-1",
    `--users=${paths.users}`,
    `--sessions=${paths.sessions}`,
    `--replay=${paths.replay}`,
    `--audit=${paths.audit}`,
  ];

  const logs = [];
  const log = console.log;
  const error = console.error;
  console.log = (line) => logs.push(line);
  console.error = () => {};
  try {
    await main(args);
    const before = process.exitCode;
    await main(args); // replayed token
    assert.equal(before, undefined);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = undefined;
  }

  const out = JSON.parse(logs[0]);
  assert.equal(out.actor, "sso:acme-oidc:00u-alice");
  assert.match(out.sessionToken, /^accord_sso_/);
  const records = readAuditLog(paths.audit);
  assert.deepEqual(records.map((r) => r.action), ["sso_jit_provision", "sso_login", "sso_login_denied"]);
  assert.equal(verifyAuditLog(records).valid, true);
  assert.ok(!readFileSync(paths.sessions, "utf8").includes(out.sessionToken));
});
