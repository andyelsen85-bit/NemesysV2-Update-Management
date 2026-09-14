import { X509Certificate } from "node:crypto";

export interface AdfsSettingsSource {
  enabled?: boolean | null;
  displayName?: string | null;
  issuer?: string | null;
  discoveryUrl?: string | null;
  clientId?: string | null;
  clientSecretEncrypted?: string | null;
  clientSecretCleared?: boolean | null;
  redirectUri?: string | null;
  scopes?: string | null;
  usernameClaim?: string | null;
  emailClaim?: string | null;
  displayNameClaim?: string | null;
  caCertificatePem?: string | null;
  caCertificateCleared?: boolean | null;
}

export interface EffectiveAdfsSettings {
  enabled: boolean;
  displayName: string;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string | null;
  scopes: string;
  usernameClaim: string;
  emailClaim: string;
  displayNameClaim: string;
  caCertificatePem: string | null;
}

function valueOrEnv(value: string | null | undefined, name: string, env: NodeJS.ProcessEnv, fallback = ""): string {
  return value ?? env[name] ?? fallback;
}

function envBoolean(name: string, env: NodeJS.ProcessEnv, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function buildEffectiveAdfsSettings(
  source: AdfsSettingsSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
  decryptedClientSecret: string | null = null,
): EffectiveAdfsSettings {
  const configuredScopes = valueOrEnv(source?.scopes, "ADFS_SCOPES", env, "openid profile email").trim();
  const scopes = (configuredScopes || "openid profile email").split(/\s+/).filter(Boolean);
  if (!scopes.includes("openid")) scopes.unshift("openid");
  const configuredCa = source?.caCertificateCleared
    ? null
    : source?.caCertificatePem ?? env.ADFS_CA_CERT_PEM ?? null;
  return {
    enabled: source?.enabled ?? envBoolean("ADFS_ENABLED", env, false),
    displayName: valueOrEnv(source?.displayName, "ADFS_DISPLAY_NAME", env, "Sign in with AD FS"),
    issuer: valueOrEnv(source?.issuer, "ADFS_ISSUER", env).trim(),
    discoveryUrl: valueOrEnv(source?.discoveryUrl, "ADFS_DISCOVERY_URL", env).trim(),
    clientId: valueOrEnv(source?.clientId, "ADFS_CLIENT_ID", env).trim(),
    clientSecret: source?.clientSecretCleared
      ? null
      : source?.clientSecretEncrypted
        ? decryptedClientSecret
        : (env.ADFS_CLIENT_SECRET ?? null),
    redirectUri: source?.redirectUri ?? env.ADFS_REDIRECT_URI ?? null,
    scopes: scopes.join(" "),
    usernameClaim: valueOrEnv(source?.usernameClaim, "ADFS_USERNAME_CLAIM", env, "upn").trim() || "upn",
    emailClaim: valueOrEnv(source?.emailClaim, "ADFS_EMAIL_CLAIM", env, "email").trim() || "email",
    displayNameClaim: valueOrEnv(source?.displayNameClaim, "ADFS_DISPLAY_NAME_CLAIM", env, "name").trim() || "name",
    caCertificatePem: configuredCa,
  };
}

export function validatePemCertificate(value: unknown): string | null {
  if (typeof value !== "string" || !value.includes("-----BEGIN CERTIFICATE-----")) return null;
  try {
    const certificate = new X509Certificate(value);
    if (!certificate.toString().includes("-----BEGIN CERTIFICATE-----")) return null;
    return value.trim();
  } catch {
    return null;
  }
}

export function validateRedirectUri(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("Redirect URI must be a string or null.");
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Redirect URI must be an absolute HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Redirect URI must be an absolute HTTPS URL without credentials or a fragment.");
  }
  return parsed.toString();
}

export function adfsSettingsDto(settings: EffectiveAdfsSettings) {
  return {
    enabled: settings.enabled,
    displayName: settings.displayName,
    issuer: settings.issuer,
    discoveryUrl: settings.discoveryUrl,
    clientId: settings.clientId,
    redirectUri: settings.redirectUri,
    scopes: settings.scopes,
    usernameClaim: settings.usernameClaim,
    emailClaim: settings.emailClaim,
    displayNameClaim: settings.displayNameClaim,
    secretConfigured: Boolean(settings.clientSecret),
    caConfigured: Boolean(settings.caCertificatePem),
  };
}

export function isAdfsConfigured(settings: EffectiveAdfsSettings): boolean {
  return settings.enabled && Boolean(settings.issuer && settings.clientId);
}

export interface AdfsAdminCandidate {
  id: string;
  username: string;
  email: string;
  isActive: boolean;
}

export function normalizeIdentity(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function claimString(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0].trim();
  return null;
}

export function matchExistingAdfsAdmin(
  users: AdfsAdminCandidate[],
  claims: Record<string, unknown>,
  usernameClaim: string,
  emailClaim: string,
): AdfsAdminCandidate {
  const username = claimString(claims, usernameClaim);
  const email = claimString(claims, emailClaim);
  const usernameMatches = username
    ? users.filter((user) => normalizeIdentity(user.username) === normalizeIdentity(username))
    : [];
  const emailMatches = email
    ? users.filter((user) => user.email && normalizeIdentity(user.email) === normalizeIdentity(email))
    : [];
  if (usernameMatches.some((user) => !user.isActive) || emailMatches.some((user) => !user.isActive)) {
    throw new Error("The matching administrator account is inactive.");
  }
  if (usernameMatches.length > 1 || emailMatches.length > 1) {
    throw new Error("The AD FS identity matches more than one administrator account.");
  }
  const byUsername = usernameMatches[0];
  const byEmail = emailMatches[0];
  if (byUsername && byEmail && byUsername.id !== byEmail.id) {
    throw new Error("The AD FS username and email claims identify different administrator accounts.");
  }
  const user = byUsername ?? byEmail;
  if (!user?.isActive) throw new Error("No active administrator account matches this AD FS identity.");
  return user;
}