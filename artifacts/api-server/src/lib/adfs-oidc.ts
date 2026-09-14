import http from "node:http";
import https from "node:https";
import { rootCertificates } from "node:tls";
import {
  ClientSecretPost,
  Configuration,
  None,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  customFetch,
  discovery,
  enableNonRepudiationChecks,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration as OidcConfiguration,
  type CustomFetch,
  type CustomFetchOptions,
} from "openid-client";
import type { EffectiveAdfsSettings } from "./adfs-config";

const configurationCache = new Map<string, OidcConfiguration>();

export function adfsClientType(clientSecret: string | null | undefined): "public-pkce" | "confidential" {
  return clientSecret ? "confidential" : "public-pkce";
}

export function serializeCustomFetchBody(body: CustomFetchOptions["body"]): string | Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw Object.assign(new TypeError("The OIDC request body type is unsupported."), {
    code: "OIDC_UNSUPPORTED_REQUEST_BODY",
  });
}

function customTlsFetch(caCertificatePem: string | null): CustomFetch {
  const ca: string[] = caCertificatePem ? [...rootCertificates, caCertificatePem] : [...rootCertificates];
  return async (url: string, options: CustomFetchOptions): Promise<Response> => new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, {
      method: options.method,
      headers: options.headers,
      agent: target.protocol === "https:" ? new https.Agent({ ca }) : undefined,
      signal: options.signal,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          headers: Object.fromEntries(Object.entries(response.headers)
            .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
            .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value])),
        }));
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    const body = serializeCustomFetchBody(options.body);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function cacheKey(settings: EffectiveAdfsSettings): string {
  return [
    settings.issuer,
    settings.discoveryUrl,
    settings.clientId,
    settings.clientSecret ? "confidential" : "public",
    settings.caCertificatePem ?? "",
  ].join("\u0000");
}

function normalizedIssuer(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

export function clearAdfsOidcCache(): void {
  configurationCache.clear();
}

export async function getAdfsOidcConfiguration(settings: EffectiveAdfsSettings): Promise<OidcConfiguration> {
  if (!settings.issuer || !settings.clientId) throw new Error("AD FS issuer and client ID are required.");
  const issuer = new URL(settings.issuer);
  if (issuer.protocol !== "https:") throw new Error("AD FS issuer must use HTTPS.");
  const key = cacheKey(settings);
  const cached = configurationCache.get(key);
  if (cached) return cached;
  const fetcher = customTlsFetch(settings.caCertificatePem);
  const clientAuth = adfsClientType(settings.clientSecret) === "confidential"
    ? ClientSecretPost(settings.clientSecret as string)
    : None();
  let configuration: OidcConfiguration;
  if (settings.discoveryUrl) {
    if (new URL(settings.discoveryUrl).protocol !== "https:") {
      throw new Error("AD FS discovery URL must use HTTPS.");
    }
    const response = await fetcher(settings.discoveryUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      body: undefined,
      redirect: "manual",
    });
    if (!response.ok) throw new Error(`AD FS discovery returned HTTP ${response.status}.`);
    const metadata = await response.json() as Record<string, unknown>;
    if (typeof metadata.issuer !== "string" || normalizedIssuer(metadata.issuer) !== normalizedIssuer(issuer.toString())) {
      throw new Error("AD FS discovery issuer does not match the configured issuer.");
    }
    configuration = new Configuration(metadata as never, settings.clientId, undefined, clientAuth);
    configuration[customFetch] = fetcher;
  } else {
    configuration = await discovery(issuer, settings.clientId, undefined, clientAuth, {
      [customFetch]: fetcher,
    });
  }
  enableNonRepudiationChecks(configuration);
  configurationCache.set(key, configuration);
  return configuration;
}

export async function createAuthorizationRequest(
  settings: EffectiveAdfsSettings,
  redirectUri: string,
): Promise<{ url: URL; state: string; nonce: string; codeVerifier: string }> {
  const configuration = await getAdfsOidcConfiguration(settings);
  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const url = buildAuthorizationUrl(configuration, {
    redirect_uri: redirectUri,
    response_type: "code",
    scope: settings.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return { url, state, nonce, codeVerifier };
}

export async function redeemAuthorizationCode(
  settings: EffectiveAdfsSettings,
  callbackUrl: URL,
  redirectUri: string,
  state: string,
  nonce: string,
  codeVerifier: string,
) {
  const configuration = await getAdfsOidcConfiguration(settings);
  return authorizationCodeGrant(configuration, callbackUrl, {
    expectedState: state,
    expectedNonce: nonce,
    pkceCodeVerifier: codeVerifier,
    idTokenExpected: true,
  }, { redirect_uri: redirectUri });
}