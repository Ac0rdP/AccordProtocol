#!/usr/bin/env node

// SSO (SAML / OIDC) control for team accounts: identity verification, just-in-time
// provisioning, and session policy. It is the enforcement point between an
// enterprise identity provider and the workspace roles used by
// scripts/security-controls.mjs. See docs/SECURITY.md ("Enterprise SSO") and
// docs/OPERATIONS.md ("SSO operations").
//
// Everything fails closed: an unknown provider, unpinned signing key, wrong
// issuer/audience, expired or replayed assertion, unverified or off-domain email,
// missing MFA, suspended user, or a user with no mapped role is denied.

import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendAuditRecord, authorize } from "./security-controls.mjs";

const DEFAULT_CLOCK_SKEW_SECONDS = 120;
const DEFAULT_OIDC_ALGORITHMS = ["RS256", "ES256"];
// Only asymmetric algorithms: a symmetric (HS*) key would be a shared secret in
// the config file and enables key-confusion attacks against published JWKS.
const SUPPORTED_OIDC_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "ES256", "ES384", "PS256"]);
const DEFAULT_MFA_AMR = ["mfa", "otp", "hwk", "swk", "fido"];
const DEFAULT_SAML_MFA_CONTEXTS = [
  "https://refeds.org/profile/mfa",
  "http://schemas.microsoft.com/claims/multipleauthn",
];
const FINGERPRINT = /^[0-9a-f]{64}$/;
// Control-plane roles are never granted from IdP groups: a compromised or
// misconfigured IdP must not be able to change policy, keys, or SSO itself.
export const SSO_PROTECTED_ROLES = ["policy_admin", "apikey_admin", "sso_admin"];

function fail(message) {
  throw new Error(message);
}

function seconds(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function normalizeFingerprint(value) {
  return String(value ?? "").replace(/:/g, "").trim().toLowerCase();
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function validateSsoConfig(config) {
  if (!config || typeof config !== "object") fail("sso config must be an object");
  const providers = config.providers;
  if (!Array.isArray(providers) || providers.length === 0) fail("sso config requires at least one provider");

  const ids = new Set();
  for (const p of providers) {
    if (!p?.id || typeof p.id !== "string") fail("sso provider id is required");
    if (ids.has(p.id)) fail(`duplicate sso provider id: ${p.id}`);
    ids.add(p.id);
    if (!p.team) fail(`sso provider ${p.id} requires a team`);
    if (!p.issuer || !p.audience) fail(`sso provider ${p.id} requires issuer and audience`);
    if (!Array.isArray(p.allowedDomains) || p.allowedDomains.length === 0) {
      fail(`sso provider ${p.id} requires a non-empty allowedDomains list`);
    }

    if (p.protocol === "saml") {
      const pins = (p.signingCertFingerprints ?? []).map(normalizeFingerprint);
      if (pins.length === 0 || !pins.every((f) => FINGERPRINT.test(f))) {
        fail(`saml provider ${p.id} requires SHA-256 signingCertFingerprints`);
      }
    } else if (p.protocol === "oidc") {
      const keys = p.jwks?.keys;
      if (!Array.isArray(keys) || keys.length === 0) fail(`oidc provider ${p.id} requires jwks.keys`);
      for (const key of keys) {
        if (!key.kid) fail(`oidc provider ${p.id} has a JWK without kid`);
        if (key.d !== undefined || key.k !== undefined) {
          fail(`oidc provider ${p.id} JWK ${key.kid} contains private or symmetric key material`);
        }
      }
      for (const alg of p.allowedAlgorithms ?? DEFAULT_OIDC_ALGORITHMS) {
        if (!SUPPORTED_OIDC_ALGORITHMS.has(alg)) fail(`oidc provider ${p.id} allows unsupported algorithm ${alg}`);
      }
    } else {
      fail(`sso provider ${p.id} has unsupported protocol ${p.protocol}`);
    }
  }

  const jit = config.jit ?? {};
  const allowedRoles = new Set(jit.allowedRoles ?? []);
  for (const role of allowedRoles) {
    if (SSO_PROTECTED_ROLES.includes(role)) fail(`jit.allowedRoles must not include protected role ${role}`);
  }
  const mapped = [...Object.values(jit.groupRoles ?? {}).flat(), ...(jit.defaultRoles ?? [])];
  for (const role of mapped) {
    if (!allowedRoles.has(role)) fail(`jit maps to role ${role} which is not in jit.allowedRoles`);
  }

  const session = config.session ?? {};
  if (!(session.maxAgeMinutes > 0)) fail("session.maxAgeMinutes must be positive");
  if (!(session.idleTimeoutMinutes > 0) || session.idleTimeoutMinutes > session.maxAgeMinutes) {
    fail("session.idleTimeoutMinutes must be positive and not exceed maxAgeMinutes");
  }
  for (const [action, minutes] of Object.entries(session.reauthMinutesForActions ?? {})) {
    if (!(minutes > 0)) fail(`session.reauthMinutesForActions.${action} must be positive`);
  }
  return config;
}

export function findProvider(config, providerId) {
  return config.providers.find((p) => p.id === providerId) ?? fail(`unknown sso provider: ${providerId}`);
}

// ---------------------------------------------------------------------------
// Replay protection
// ---------------------------------------------------------------------------

export function checkReplay(replayCache, id, expiresAt, now = new Date()) {
  if (!id) fail("assertion id is required for replay protection");
  const seen = (replayCache.seen ??= {});
  for (const [key, expiry] of Object.entries(seen)) {
    if (new Date(expiry) <= now) delete seen[key];
  }
  if (seen[id]) fail(`sso assertion replayed: ${id}`);
  seen[id] = new Date(expiresAt).toISOString();
}

// ---------------------------------------------------------------------------
// OIDC
// ---------------------------------------------------------------------------

function decodeSegment(segment, label) {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return fail(`oidc id token ${label} is not valid base64url JSON`);
  }
}

function verifyJws(alg, jwk, signingInput, signature) {
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const hash = `sha${alg.slice(2)}`;
  if (alg.startsWith("RS")) return verifySignature(hash, signingInput, key, signature);
  if (alg.startsWith("PS")) {
    return verifySignature(hash, signingInput, { key, padding: 6, saltLength: 32 }, signature); // RSA_PKCS1_PSS_PADDING
  }
  return verifySignature(hash, signingInput, { key, dsaEncoding: "ieee-p1363" }, signature);
}

export function verifyOidcIdToken(provider, idToken, { now = new Date(), nonce, clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS } = {}) {
  const parts = String(idToken ?? "").split(".");
  if (parts.length !== 3) fail("oidc id token must be a compact JWS");
  const [rawHeader, rawPayload, rawSignature] = parts;
  const header = decodeSegment(rawHeader, "header");
  const claims = decodeSegment(rawPayload, "payload");

  const allowed = provider.allowedAlgorithms ?? DEFAULT_OIDC_ALGORITHMS;
  if (!allowed.includes(header.alg)) fail(`oidc algorithm not allowed: ${header.alg}`);
  const jwk = provider.jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) fail(`oidc signing key not pinned: ${header.kid}`);
  if (jwk.alg && jwk.alg !== header.alg) fail("oidc token alg does not match pinned key");
  if (!verifyJws(header.alg, jwk, Buffer.from(`${rawHeader}.${rawPayload}`), Buffer.from(rawSignature, "base64url"))) {
    fail("oidc id token signature is invalid");
  }

  const t = seconds(now);
  if (claims.iss !== provider.issuer) fail("oidc issuer mismatch");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(provider.audience)) fail("oidc audience mismatch");
  if (aud.length > 1 && claims.azp !== provider.audience) fail("oidc authorized party mismatch");
  if (typeof claims.exp !== "number" || claims.exp <= t - clockSkewSeconds) fail("oidc id token expired");
  if (typeof claims.iat !== "number" || claims.iat > t + clockSkewSeconds) fail("oidc id token issued in the future");
  if (claims.nbf !== undefined && claims.nbf > t + clockSkewSeconds) fail("oidc id token not yet valid");
  if (nonce !== undefined && claims.nonce !== nonce) fail("oidc nonce mismatch");
  if (!claims.sub) fail("oidc subject is required");

  const mfaMethods = provider.mfaAmr ?? DEFAULT_MFA_AMR;
  return {
    provider: provider.id,
    team: provider.team,
    protocol: "oidc",
    subject: String(claims.sub),
    email: claims.email ? String(claims.email).toLowerCase() : null,
    emailVerified: claims.email_verified === true,
    groups: Array.isArray(claims.groups) ? claims.groups.map(String) : [],
    mfa: Array.isArray(claims.amr) && claims.amr.some((m) => mfaMethods.includes(m)),
    authTime: new Date((claims.auth_time ?? claims.iat) * 1000).toISOString(),
    assertionId: claims.jti ? String(claims.jti) : `${claims.sub}:${claims.iat}:${claims.nonce ?? ""}`,
    assertionExpiresAt: new Date(claims.exp * 1000).toISOString(),
    sessionNotOnOrAfter: null,
  };
}

// ---------------------------------------------------------------------------
// SAML
// ---------------------------------------------------------------------------

// XML-DSig validation is performed by the SAML gateway (a maintained SAML
// library); this control receives its verified result and enforces the pinned
// certificate, issuer, audience, validity window, replay, domain and MFA policy.
export function verifySamlAssertion(provider, assertion, { now = new Date(), clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS } = {}) {
  if (!assertion || typeof assertion !== "object") fail("saml assertion is required");
  if (assertion.signatureVerified !== true) fail("saml assertion signature was not verified");
  const pins = provider.signingCertFingerprints.map(normalizeFingerprint);
  if (!pins.includes(normalizeFingerprint(assertion.signingCertFingerprint))) {
    fail("saml signing certificate is not pinned for this provider");
  }
  if (assertion.issuer !== provider.issuer) fail("saml issuer mismatch");
  if (assertion.audience !== provider.audience) fail("saml audience mismatch");

  const t = new Date(now).getTime();
  const skew = clockSkewSeconds * 1000;
  if (!assertion.notBefore || !assertion.notOnOrAfter) fail("saml assertion validity window is required");
  if (new Date(assertion.notBefore).getTime() > t + skew) fail("saml assertion not yet valid");
  if (new Date(assertion.notOnOrAfter).getTime() <= t - skew) fail("saml assertion expired");
  if (!assertion.id) fail("saml assertion id is required");
  if (!assertion.nameId) fail("saml NameID is required");

  const attributes = assertion.attributes ?? {};
  const contexts = provider.mfaAuthnContexts ?? DEFAULT_SAML_MFA_CONTEXTS;
  return {
    provider: provider.id,
    team: provider.team,
    protocol: "saml",
    subject: String(assertion.nameId),
    email: attributes.email ? String(attributes.email).toLowerCase() : null,
    // The IdP asserts the address; the pinned signature makes it authoritative.
    emailVerified: Boolean(attributes.email),
    groups: Array.isArray(attributes.groups) ? attributes.groups.map(String) : [],
    mfa: contexts.includes(assertion.authnContextClassRef),
    authTime: new Date(assertion.authnInstant ?? assertion.notBefore).toISOString(),
    assertionId: String(assertion.id),
    assertionExpiresAt: new Date(assertion.notOnOrAfter).toISOString(),
    sessionNotOnOrAfter: assertion.sessionNotOnOrAfter ? new Date(assertion.sessionNotOnOrAfter).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export function authenticateSso(config, { providerId, idToken, assertion, nonce }, { now = new Date(), replayCache = {} } = {}) {
  const provider = findProvider(config, providerId);
  const clockSkewSeconds = config.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const identity =
    provider.protocol === "oidc"
      ? verifyOidcIdToken(provider, idToken, { now, nonce, clockSkewSeconds })
      : verifySamlAssertion(provider, assertion, { now, clockSkewSeconds });

  if (!identity.email || !identity.emailVerified) fail("sso identity requires a verified email");
  const domain = identity.email.split("@")[1];
  if (!provider.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
    fail(`sso email domain not allowed: ${domain}`);
  }
  if (config.session?.requireMfa && !identity.mfa) fail("sso login requires multi-factor authentication");

  checkReplay(replayCache, `${provider.id}:${identity.assertionId}`, identity.assertionExpiresAt, now);
  return identity;
}

// ---------------------------------------------------------------------------
// Just-in-time provisioning
// ---------------------------------------------------------------------------

export function ssoActorId(identity) {
  return `sso:${identity.provider}:${identity.subject}`;
}

export function mapGroupsToRoles(config, groups) {
  const jit = config.jit ?? {};
  const allowed = new Set(jit.allowedRoles ?? []);
  const roles = new Set(jit.defaultRoles ?? []);
  for (const group of groups) for (const role of jit.groupRoles?.[group] ?? []) roles.add(role);
  // Defense in depth: never emit a role outside the allowlist, even if the
  // config was edited without re-validation.
  return [...roles].filter((r) => allowed.has(r) && !SSO_PROTECTED_ROLES.includes(r)).sort();
}

export function provisionSsoUser(config, userStore, identity, { now = new Date() } = {}) {
  const users = (userStore.users ??= []);
  const actor = ssoActorId(identity);
  let user = users.find((u) => u.actor === actor);
  const created = !user;

  if (!user) {
    if (!config.jit?.enabled) fail(`sso user is not provisioned and jit is disabled: ${actor}`);
    user = {
      actor,
      provider: identity.provider,
      team: identity.team,
      subject: identity.subject,
      email: identity.email,
      roles: [],
      status: "active",
      provisionedAt: new Date(now).toISOString(),
      lastLoginAt: null,
      suspendedAt: null,
      suspensionReason: null,
    };
    users.push(user);
  }
  if (user.status !== "active") fail(`sso user is ${user.status}: ${actor}`);

  // IdP groups are the source of truth for SSO-managed roles on every login, so
  // removing a user from a group in the IdP removes the role at next login.
  const roles = mapGroupsToRoles(config, identity.groups);
  const added = roles.filter((r) => !user.roles.includes(r));
  const removed = user.roles.filter((r) => !roles.includes(r));
  user.roles = roles;
  user.email = identity.email;
  user.lastLoginAt = new Date(now).toISOString();
  return { user, created, added, removed };
}

export function deprovisionSsoUser(userStore, sessionStore, { actor, reason, now = new Date() }) {
  if (!reason) fail("deprovision reason is required");
  const user = (userStore.users ?? []).find((u) => u.actor === actor) ?? fail(`unknown sso user: ${actor}`);
  user.status = "suspended";
  user.roles = [];
  user.suspendedAt = new Date(now).toISOString();
  user.suspensionReason = reason;
  const revokedSessions = revokeSsoSessions(sessionStore, actor, { reason, now });
  return { user, revokedSessions };
}

/**
 * Projects SSO-managed roles into a security-controls policy. Only `sso:*`
 * actors are touched; manually managed actors and permissions are unchanged.
 */
export function applySsoRolesToPolicy(policy, userStore) {
  const roles = Object.fromEntries(Object.entries(policy.roles ?? {}).filter(([actor]) => !actor.startsWith("sso:")));
  for (const user of userStore.users ?? []) {
    if (user.status === "active" && user.roles.length > 0) roles[user.actor] = [...user.roles];
  }
  return { ...policy, roles };
}

// ---------------------------------------------------------------------------
// Session policy
// ---------------------------------------------------------------------------

export function createSsoSession(config, sessionStore, user, identity, { now = new Date() } = {}) {
  if (user.status !== "active" || user.roles.length === 0) fail(`sso login denied: ${user.actor} has no mapped roles`);
  const issued = new Date(now);
  let expires = new Date(issued.getTime() + config.session.maxAgeMinutes * 60000);
  if (identity.sessionNotOnOrAfter && new Date(identity.sessionNotOnOrAfter) < expires) {
    expires = new Date(identity.sessionNotOnOrAfter);
  }

  const token = `accord_sso_${randomBytes(32).toString("base64url")}`;
  const session = {
    tokenHash: hashToken(token),
    actor: user.actor,
    provider: user.provider,
    team: user.team,
    createdAt: issued.toISOString(),
    lastSeenAt: issued.toISOString(),
    expiresAt: expires.toISOString(),
    authTime: identity.authTime,
    mfa: identity.mfa,
    status: "active",
    revokedAt: null,
    revocationReason: null,
  };
  sessionStore.sessions = [...(sessionStore.sessions ?? []), session];
  return { token, session };
}

export function evaluateSsoSession(config, sessionStore, { token, action, now = new Date() }) {
  const session =
    (sessionStore.sessions ?? []).find((s) => s.tokenHash === hashToken(String(token ?? ""))) ??
    fail("sso session not found");
  const t = new Date(now).getTime();
  if (session.status !== "active") fail("sso session revoked");
  if (t >= new Date(session.expiresAt).getTime()) fail("sso session expired");
  if (t - new Date(session.lastSeenAt).getTime() > config.session.idleTimeoutMinutes * 60000) {
    fail("sso session idle timeout");
  }
  if (config.session.requireMfa && !session.mfa) fail("sso session lacks multi-factor authentication");
  const reauth = action ? config.session.reauthMinutesForActions?.[action] : undefined;
  if (reauth !== undefined && t - new Date(session.authTime).getTime() > reauth * 60000) {
    fail(`re-authentication required for ${action}`);
  }
  session.lastSeenAt = new Date(now).toISOString();
  return session;
}

export function revokeSsoSessions(sessionStore, actor, { reason, now = new Date() }) {
  let count = 0;
  for (const s of sessionStore.sessions ?? []) {
    if (s.actor === actor && s.status === "active") {
      s.status = "revoked";
      s.revokedAt = new Date(now).toISOString();
      s.revocationReason = reason;
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readJson(path, fallback) {
  if (fallback !== undefined && !existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function option(args, name, required = true) {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (required && !value) throw new Error(`missing --${name}=...`);
  return value;
}

function usage() {
  console.error(`Usage:
  sso-controls.mjs validate --config=PATH
  sso-controls.mjs login --config=PATH --provider=ID (--id-token=PATH | --assertion=PATH) [--nonce=N]
                         --users=PATH --sessions=PATH --replay=PATH --audit=PATH
  sso-controls.mjs session-check --config=PATH --sessions=PATH --token=TOKEN [--action=ACTION]
  sso-controls.mjs deprovision --policy=PATH --actor=ADMIN --user=SSO_ACTOR --reason=TEXT
                               --users=PATH --sessions=PATH --audit=PATH
  sso-controls.mjs sync-policy --policy=PATH --actor=ADMIN --users=PATH --audit=PATH`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...args] = argv;

    if (command === "validate") {
      const config = validateSsoConfig(readJson(option(args, "config")));
      console.log(JSON.stringify({ valid: true, providers: config.providers.map((p) => `${p.id} (${p.protocol})`) }));
      return;
    }

    if (command === "login") {
      const config = validateSsoConfig(readJson(option(args, "config")));
      const usersPath = option(args, "users");
      const sessionsPath = option(args, "sessions");
      const replayPath = option(args, "replay");
      const auditPath = option(args, "audit");
      const tokenPath = option(args, "id-token", false);
      const assertionPath = option(args, "assertion", false);
      const users = readJson(usersPath, { users: [] });
      const sessions = readJson(sessionsPath, { sessions: [] });
      const replayCache = readJson(replayPath, { seen: {} });
      const providerId = option(args, "provider");

      let identity;
      try {
        identity = authenticateSso(
          config,
          {
            providerId,
            idToken: tokenPath ? readFileSync(tokenPath, "utf8").trim() : undefined,
            assertion: assertionPath ? readJson(assertionPath) : undefined,
            nonce: option(args, "nonce", false),
          },
          { replayCache }
        );
      } catch (error) {
        appendAuditRecord(auditPath, {
          actor: `sso:${providerId}`,
          action: "sso_login_denied",
          resource: providerId,
          details: { reason: error.message },
        });
        throw error;
      }
      writeJson(replayPath, replayCache);

      const { user, created, added, removed } = provisionSsoUser(config, users, identity);
      writeJson(usersPath, users);
      if (created || added.length || removed.length) {
        appendAuditRecord(auditPath, {
          actor: user.actor,
          action: created ? "sso_jit_provision" : "sso_role_sync",
          resource: user.team,
          details: { provider: user.provider, added, removed },
        });
      }

      if (user.roles.length === 0) {
        appendAuditRecord(auditPath, {
          actor: user.actor,
          action: "sso_login_denied",
          resource: user.team,
          details: { reason: "no mapped roles" },
        });
      }
      const { token, session } = createSsoSession(config, sessions, user, identity);
      writeJson(sessionsPath, sessions);
      appendAuditRecord(auditPath, {
        actor: user.actor,
        action: "sso_login",
        resource: user.team,
        details: { provider: user.provider, protocol: identity.protocol, mfa: identity.mfa, expiresAt: session.expiresAt },
      });
      console.log(JSON.stringify({ actor: user.actor, roles: user.roles, sessionToken: token, expiresAt: session.expiresAt }));
      return;
    }

    if (command === "session-check") {
      const config = validateSsoConfig(readJson(option(args, "config")));
      const sessionsPath = option(args, "sessions");
      const sessions = readJson(sessionsPath);
      const session = evaluateSsoSession(config, sessions, {
        token: option(args, "token"),
        action: option(args, "action", false),
      });
      writeJson(sessionsPath, sessions);
      console.log(JSON.stringify({ actor: session.actor, team: session.team, expiresAt: session.expiresAt }));
      return;
    }

    if (command === "deprovision") {
      const policy = readJson(option(args, "policy"));
      const admin = option(args, "actor");
      authorize(policy, admin, "sso_admin");
      const usersPath = option(args, "users");
      const sessionsPath = option(args, "sessions");
      const users = readJson(usersPath);
      const sessions = readJson(sessionsPath, { sessions: [] });
      const target = option(args, "user");
      const reason = option(args, "reason");
      const { revokedSessions } = deprovisionSsoUser(users, sessions, { actor: target, reason });
      writeJson(usersPath, users);
      writeJson(sessionsPath, sessions);
      appendAuditRecord(option(args, "audit"), {
        actor: admin,
        action: "sso_deprovision",
        resource: target,
        details: { reason, revokedSessions },
      });
      console.log(JSON.stringify({ suspended: target, revokedSessions }));
      return;
    }

    if (command === "sync-policy") {
      const policyPath = option(args, "policy");
      const policy = readJson(policyPath);
      const admin = option(args, "actor");
      authorize(policy, admin, "policy_change");
      const next = applySsoRolesToPolicy(policy, readJson(option(args, "users")));
      writeJson(policyPath, next);
      const ssoActors = Object.keys(next.roles).filter((a) => a.startsWith("sso:"));
      appendAuditRecord(option(args, "audit"), {
        actor: admin,
        action: "sso_policy_sync",
        resource: "policy",
        details: { ssoActors },
      });
      console.log(JSON.stringify({ synced: ssoActors.length }));
      return;
    }

    usage();
    process.exitCode = 2;
  } catch (error) {
    console.error(`sso control failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
