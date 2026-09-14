import { describe, expect, it } from "vitest";
import {
  adfsSettingsDto,
  buildEffectiveAdfsSettings,
  matchExistingAdfsAdmin,
  validatePemCertificate,
  validateRedirectUri,
} from "./adfs-helpers";
import { adfsClientType } from "./adfs-oidc";
import { csrfMatches } from "./csrf";

const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUV8iQVnMUcNvZ0Aeei/rUngOC258wDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMbmVtZXN5cy10ZXN0MB4XDTI2MDkxNDA3MzgwMloXDTI2
MDkxNTA3MzgwMlowFzEVMBMGA1UEAwwMbmVtZXN5cy10ZXN0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1atKmhLvFJMjVK+EaLl0QA5Q2+mq5Bes9s7t
kn53mWhnpuCHPPmtnlhNXPKa0GsUd3STGJ2usw/VoGNLNivmIVvcqh0BHAskDcSX
OgfnPx56qhMoB11EE4ygW35ldt+GrrggFqH1tYjDZ9VGrBVnm2cmldWgI5jMAe02
1fBhLGzQULiMBddkjdLU7HxeByo7QswlxjGzd25xNUUJw7wvdiIJzfkKV6KKRgCc
IQUC4//yK+GI7iTi3oCv0cN7uPHglA1WBjv1vk11k/iWbTzEcP29jYGgdiWIj6w2
0N5ZKFV6kKmrDR5+Gd2FygLh1gt68rMy3tmG6wuxHuPF+spX2QIDAQABo1MwUTAd
BgNVHQ4EFgQUrB9iz1Js8dEYvKieIYe1lHH6zCwwHwYDVR0jBBgwFoAUrB9iz1Js
8dEYvKieIYe1lHH6zCwwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAhAU5Uf3haqWR74TGFld36KdRaqPYkwM4D+P8jFX0dKlC7adSijrH/Rp2qMDz
EK42lr8lSoHFbbZp71YDsTJdseYAE3u+LpdeE9CenQhqcD+P0Bh7isk0cH6NmSfC
+LXXJ35fdyt6v0kEnLrTG6XKK6vtOtLCsuuEksVS8fO+q4WPokiwzid/dssX58t3
fWrSl101f/ZJDJ3UgsQAdtMLxKoI8Ro3UQ1PN0d4l3+i9T7nCFFcFugBL9C586Qv
4QHWLA8eJCqX3lL/2e5AOMwVzXlQXzF3jgcp5TbZR6/E89NoVDYzLZBIciP2YBev
ca5Tvsw71lVzaeytPvFflagFww==
-----END CERTIFICATE-----`;

describe("AD FS settings helpers", () => {
  it("uses deployment defaults, enforces openid, and lets stored values override env", () => {
    const env = {
      ADFS_ENABLED: "true",
      ADFS_ISSUER: "https://env.example/adfs",
      ADFS_CLIENT_ID: "env-client",
      ADFS_CLIENT_SECRET: "env-secret",
      ADFS_SCOPES: "profile email",
    };
    const fromEnv = buildEffectiveAdfsSettings(undefined, env);
    expect(fromEnv.enabled).toBe(true);
    expect(fromEnv.scopes).toBe("openid profile email");
    expect(fromEnv.clientSecret).toBe("env-secret");

    const stored = buildEffectiveAdfsSettings({
      enabled: false,
      issuer: "https://stored.example/adfs",
      clientId: "stored-client",
      clientSecretEncrypted: "ciphertext",
      scopes: "email",
      usernameClaim: "preferred_username",
    }, env, "stored-secret");
    expect(stored.enabled).toBe(false);
    expect(stored.issuer).toBe("https://stored.example/adfs");
    expect(stored.clientId).toBe("stored-client");
    expect(stored.clientSecret).toBe("stored-secret");
    expect(stored.scopes).toBe("openid email");
    expect(stored.usernameClaim).toBe("preferred_username");

    const cleared = buildEffectiveAdfsSettings({ clientSecretCleared: true }, env);
    expect(cleared.clientSecret).toBeNull();
  });

  it("redacts secret and certificate material from the settings DTO", () => {
    const dto = adfsSettingsDto(buildEffectiveAdfsSettings({
      enabled: true,
      issuer: "https://issuer.example",
      clientId: "client",
      clientSecretEncrypted: "ciphertext",
      caCertificatePem: TEST_CERTIFICATE,
    }, {}, "secret"));
    expect(dto.secretConfigured).toBe(true);
    expect(dto.caConfigured).toBe(true);
    expect(dto).not.toHaveProperty("clientSecret");
    expect(dto).not.toHaveProperty("caCertificatePem");
  });

  it("validates certificate PEM and explicit HTTPS redirect URIs", () => {
    expect(validatePemCertificate(TEST_CERTIFICATE)).toBe(TEST_CERTIFICATE);
    expect(validatePemCertificate("-----BEGIN CERTIFICATE-----\nnot-a-certificate")).toBeNull();
    expect(validateRedirectUri("https://console.example.test/api/auth/adfs/callback"))
      .toBe("https://console.example.test/api/auth/adfs/callback");
    expect(() => validateRedirectUri("http://console.example.test/callback")).toThrow(/HTTPS/);
    expect(() => validateRedirectUri("https://user:password@example.test/callback")).toThrow(/credentials/);
    expect(() => validateRedirectUri("https://example.test/callback#fragment")).toThrow(/fragment/);
  });
});

describe("AD FS client and identity matching helpers", () => {
  it("distinguishes public PKCE and confidential clients without exposing secrets", () => {
    expect(adfsClientType(null)).toBe("public-pkce");
    expect(adfsClientType("configured-secret")).toBe("confidential");
  });

  const users = [
    { id: "1", username: "Alice", email: "alice@example.test", isActive: true },
    { id: "2", username: "disabled", email: "disabled@example.test", isActive: false },
    { id: "3", username: "other", email: "other@example.test", isActive: true },
  ];

  it("matches normalized username first and then email", () => {
    expect(matchExistingAdfsAdmin(users, { upn: " alice " }, "upn", "email").id).toBe("1");
    expect(matchExistingAdfsAdmin(users, { email: "ALICE@EXAMPLE.TEST" }, "upn", "email").id).toBe("1");
  });

  it("rejects inactive and conflicting claim matches", () => {
    expect(() => matchExistingAdfsAdmin(users, { upn: "disabled" }, "upn", "email"))
      .toThrow(/inactive/);
    expect(() => matchExistingAdfsAdmin(users, {
      upn: "Alice",
      email: "other@example.test",
    }, "upn", "email")).toThrow(/different/);
    expect(() => matchExistingAdfsAdmin([
      ...users,
      { id: "4", username: "disabled-duplicate", email: "alice@example.test", isActive: false },
    ], { email: "alice@example.test" }, "upn", "email")).toThrow(/inactive|more than one/);
  });
});

describe("CSRF cookie/header matching", () => {
  it("requires an exact matching token and rejects missing or different headers", () => {
    const request = (cookie?: string, header?: string) => ({
      cookies: cookie ? { nemesys_csrf: cookie } : {},
      get: (name: string) => name === "x-csrf-token" ? header : undefined,
    });
    expect(csrfMatches(request("token", "token") as never)).toBe(true);
    expect(csrfMatches(request("token", "different") as never)).toBe(false);
    expect(csrfMatches(request("token") as never)).toBe(false);
    expect(csrfMatches(request(undefined, "token") as never)).toBe(false);
  });
});