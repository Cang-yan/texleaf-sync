import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";

import { checkSession, fetchWithTimeout, sessionFromCookieHeader } from "../dist/auth.js";

// Self-signed localhost certificate: a request that verifies TLS must refuse
// it, so tests can tell "verification on by default" from a silent downgrade.
const key = `-----BEGIN PRIVATE KEY-----
MIIEuwIBADANBgkqhkiG9w0BAQEFAASCBKUwggShAgEAAoIBAQDBh1tuKoQW7EWk
mQMdHp9Klb0Z5wlSvoXIeV8BF8JhQBc2VSSpuqe1/Gpy4jtDfboRCncOmhUJuSxc
+u5ShtDJ13VdReZqHrBX652kvl0d6AiuiSwYK0Rh1d2N7aAyQcCO8IphT+Vg3hS5
flDMDGKSY4ioPhAHVMLn1DdeKUAAGW6V3Cmg7BwjdSzUVFke9jyqRAOL8SDTPuRu
z8qqVt9uRQlaNjkG/n6OSTYEEHFR7d1M/uwuR1Fg7F7kxi3HZCY+De+GZMyNexkz
bNcNvNmd8hdwxnVlN5GXcKErY0L0GaC55dLSfk1+phQVIKQaezgRAzbhmLk8+0BL
Lml9vKzxAgMBAAECgf9hRFFaYq6rgWop+r2V5SN/rm1cl2zC1FRpGJdR9Um87Hlo
1WJCluMJPymWlB3fzfu2lOFBytodXkmYcdtWScFRBk6hPSs8KtshVUqQ18dKlf8c
ZH/E+09jMhookJtIpxjLaW94zq8lVc5qFxKE0QoPM/d7QmDL+SNSDAHH/EjZGGMZ
17rUAjo00TYYSnR+7No78ax+Ua55ikWJeVLKOZzYhFvRjeAwdQPMqJXhTQUlTNQT
+Gy47mkh3RFhHTssQZcWqEgBFtKKCTjtSstcHLWRuUO+wGU8/HEPcZnTlOB7ApKL
xMxMbvEewGWa9Xw4M1fv5mZyepd2GuTrBz8nkaECgYEA+zsRAkD+dz5LKNfUNK/5
vWhJNORYnf3C6zxr6etuqJTa/GntYD8IBdOqTGO46l+9tF7vPDGlEXsGMq5Z1wDa
80rsUK2auUy1adda0wER3YSUDny/v8zt0FiGbGpNhG2t3fshlnR/JiIpsjwFxEtz
esYDvxIVdqkV4KUMe1z7Fi0CgYEAxTPeuUXri0PqLfGNo4gYUoFjxybyXB1VWTWM
nJK1AlCI0JTvQhQ7s+heenYfWkkYVfBzftttl1DLPvZkff9ECHtCtWf4LoVdXy9G
TQg2HzhXEff5KlcyhCNJuDIhm+ogtl1COZSVOX5Bp3BFzYwB+gja+8Mm/wyKeCRM
DEWZkFUCgYAigDINxS8s4PkhWsJhmekKAdBL2y/wQnEKLPoE3bgMnqSUFVfr57wK
UM8KPoeeaBd9NaxU79xjUim/vAHKbOukjZ12VuDwoYAoUNLAN11ktlg+xRLwHAxs
mDudl9udXBKMcXhjWQw9CGQBfgyssE/jhF3vV2RrLz055HCaYGJ64QKBgQCAYtuv
DWljOqz8ilWnUNRc6qY2IxIIjIRjVuybhxvXTO01trDp+VhBMZhI7BxPYGU6lhfr
UBpSOCSKcklMimMVjoIIro6yYts+O/3t6tmpi7mMFkAeo7RcuMim5eRhqJTxhVe3
OxfH3X4K75pSTsN+sEM5Q31g8R45R5BHMQzgHQKBgHQNS76bCfdrkVOxh5GWFD+u
9b+AgLXbHE6CLinH4Sio2bzzSGx9U58aOTFX3hiQ3zwtmRqcOejq7w0q1ksspVCg
6pMEfeXa1Pt22xHEpHe5xTRxVJbu0q+S6FBOYtZthnqeBxhmk/j4oZdzdh4a8o6+
Wx8hUcHlw9idR0V4RPEo
-----END PRIVATE KEY-----
`;

const cert = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUJ3zGKh9gDZ/rrPSPQw2kUytXk3MwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyMjAyMjIzN1oYDzIxMjYw
OTI4MDIyMjM3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDBh1tuKoQW7EWkmQMdHp9Klb0Z5wlSvoXIeV8BF8Jh
QBc2VSSpuqe1/Gpy4jtDfboRCncOmhUJuSxc+u5ShtDJ13VdReZqHrBX652kvl0d
6AiuiSwYK0Rh1d2N7aAyQcCO8IphT+Vg3hS5flDMDGKSY4ioPhAHVMLn1DdeKUAA
GW6V3Cmg7BwjdSzUVFke9jyqRAOL8SDTPuRuz8qqVt9uRQlaNjkG/n6OSTYEEHFR
7d1M/uwuR1Fg7F7kxi3HZCY+De+GZMyNexkzbNcNvNmd8hdwxnVlN5GXcKErY0L0
GaC55dLSfk1+phQVIKQaezgRAzbhmLk8+0BLLml9vKzxAgMBAAGjaTBnMB0GA1Ud
DgQWBBTyYB9GdZZ8tQlmVpy8i3SS46EqvTAfBgNVHSMEGDAWgBTyYB9GdZZ8tQlm
Vpy8i3SS46EqvTAPBgNVHRMBAf8EBTADAQH/MBQGA1UdEQQNMAuCCWxvY2FsaG9z
dDANBgkqhkiG9w0BAQsFAAOCAQEAAAuyEV8wezYeq73XRG28iow3s5seDq/7eryX
RhtSPseNg7lqFWVJWHORhMUyCBA9qvYb/9WFigL0sTCj6e0QqW5pfghMlakfKdCh
HPeL2lIiRMhuHztHT4bHcTFRej5WeyKTSIOOhbiLvKzpFo7TYeAcFLQwonClXU17
5CUx2++H/+B1611tQBiCzdGqRHHdILnUehw48NOgdFULjdw+N+xPMyi5+wbY/Icg
i+E6OJXSoStmhx4l/xktmdWNkRfjhGv+wfYhaituiohYk/y9JSAAGcmWHkqG87Ca
KuCLhT2MoGUzNL8y4w4gLYr1Rxqi7rDvw+0Ie4JmY1adDHy0hg==
-----END CERTIFICATE-----
`;

const certificateError = /fetch failed|certificate|self-signed|SSL|TLS/i;

async function selfSignedServer(t) {
  const server = https.createServer({ key, cert }, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ email: "user@example.invalid", _id: "user-id" }));
  });
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `https://localhost:${server.address().port}`;
}

test("a session without sslVerify still verifies TLS", async (t) => {
  const host = await selfSignedServer(t);
  const session = sessionFromCookieHeader({
    host,
    profile: "default",
    cookieHeader: "overleaf_session2=secret",
    sslVerify: true
  });
  // Sessions written before sslVerify existed have no such field at all.
  const legacy = {
    host: session.host,
    profile: session.profile,
    cookies: session.cookies,
    createdAt: session.createdAt
  };
  const status = await checkSession({ host, session: legacy });
  assert.equal(status.loggedIn, false);
  assert.match(status.error ?? "", certificateError);
});

test("only an explicit false turns TLS verification off", async (t) => {
  const host = await selfSignedServer(t);
  const session = sessionFromCookieHeader({
    host,
    profile: "default",
    cookieHeader: "overleaf_session2=secret",
    sslVerify: false
  });
  const status = await checkSession({ host, session });
  assert.deepEqual(status, { loggedIn: true, email: "user@example.invalid", userId: "user-id" });
});

test("fetchWithTimeout defaults to verified TLS", async (t) => {
  const host = await selfSignedServer(t);
  await assert.rejects(fetchWithTimeout(`${host}/user/personal_info`, { timeoutMs: 5_000 }), certificateError);
  const response = await fetchWithTimeout(`${host}/user/personal_info`, { timeoutMs: 5_000, sslVerify: false });
  assert.equal(response.status, 200);
});
