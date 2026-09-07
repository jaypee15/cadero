const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const CLIENT_ID = "REGISTERED_GITHUB_APP_CLIENT_ID_REQUIRED";

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  interval?: number;
  expires_in?: number;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expiresIn: number;
}

export async function requestDeviceCode(fetchImpl: typeof fetch): Promise<DeviceCode> {
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "cadence-cli",
    },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
  });
  if (!res.ok) throw new Error(`device code request failed: HTTP ${res.status}`);
  const body = (await res.json()) as DeviceCodeResponse;
  if (
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  ) {
    throw new Error("device code response missing required fields");
  }
  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    interval: body.interval ?? 5,
    expiresIn: body.expires_in ?? 900,
  };
}

interface TokenResponse {
  access_token?: string;
  error?: string;
}

export interface PollOptions {
  interval: number;
  expiresIn: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function pollForAccessToken(
  fetchImpl: typeof fetch,
  deviceCode: string,
  opts: PollOptions,
): Promise<string> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.expiresIn * 1000;
  let current = opts.interval;
  while (Date.now() < deadline) {
    await sleep(current * 1000);
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "cadence-cli",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const body = (await res.json()) as TokenResponse;
    if (typeof body.access_token === "string" && body.access_token.length > 0) {
      return body.access_token;
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      current += 5;
      continue;
    }
    throw new Error(body.error ? `device flow error: ${body.error}` : "device flow failed");
  }
  throw new Error("device code expired");
}
