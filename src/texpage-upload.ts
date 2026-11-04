import https from "node:https";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

import { fetchWithTimeout } from "./auth.js";
import { BackendError } from "./errors.js";
import { type JsonRecord } from "./json.js";

const uploadContentType = "application/octet-stream";
const uploadHostPattern = /^[A-Za-z0-9.-]+$/;

// TexPage hands out either a presigned URL or short-lived object-storage
// credentials. Credentials are validated before they leave the process: the
// endpoint must be HTTPS and the token must not already be expired.
export async function uploadObject(
  token: JsonRecord,
  key: string,
  body: Buffer,
  timeoutMs: number,
  sslVerify: boolean
): Promise<void> {
  if (typeof token.url === "string") {
    await putToSignedUrl(token.url, body, timeoutMs, sslVerify);
    return;
  }
  const accessKeyId = requiredString(token, "accessKeyId");
  const accessKeySecret = requiredString(token, "accessKeySecret");
  const stsToken = requiredString(token, "stsToken");
  const expiration = requiredString(token, "expiration");
  const region = requiredString(token, "region");
  const bucket = requiredString(token, "bucket");
  const endpoint = requiredString(token, "endpoint");

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new BackendError("TexPage returned an invalid object-storage endpoint.");
  }
  if (endpointUrl.protocol !== "https:") {
    throw new BackendError("TexPage returned an insecure object-storage endpoint.");
  }
  if (endpointUrl.username || endpointUrl.password)
    throw new BackendError("TexPage returned an invalid object-storage endpoint.");

  const uploadDomain = token.uploadDomain;
  if (uploadDomain !== undefined && (typeof uploadDomain !== "string" || !uploadHostPattern.test(uploadDomain))) {
    throw new BackendError("TexPage returned an invalid object-storage upload host.");
  }
  const expiry = Date.parse(expiration);
  if (!Number.isFinite(expiry) || expiry <= Date.now())
    throw new BackendError("TexPage returned expired object-storage credentials.");

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: Boolean(token.forcePathStyle),
    requestHandler: uploadDomain ? uploadDomainHandler(uploadDomain) : new NodeHttpHandler(),
    credentials: { accessKeyId, secretAccessKey: accessKeySecret, sessionToken: stsToken, expiration: new Date(expiry) }
  });
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: uploadContentType }), {
      abortSignal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new BackendError(`TexPage object upload failed (${describeUploadError(error)}).`);
  } finally {
    client.destroy();
  }
}

async function putToSignedUrl(rawUrl: string, body: Buffer, timeoutMs: number, sslVerify: boolean): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BackendError("TexPage returned an invalid upload URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new BackendError("TexPage returned an unsafe upload URL.");
  const response = await fetchWithTimeout(url.toString(), {
    method: "PUT",
    headers: { "Content-Type": uploadContentType },
    body: new Uint8Array(body),
    redirect: "error",
    timeoutMs,
    sslVerify
  });
  if (!response.ok) throw new BackendError(`TexPage object upload failed with HTTP ${response.status}.`);
}

// Object storage may only be reachable through a vendor upload host; send the
// request there while keeping the signed path intact.
function uploadDomainHandler(uploadDomain: string) {
  const delegate = new NodeHttpHandler({
    httpsAgent: new https.Agent({ servername: uploadDomain, rejectUnauthorized: true })
  });
  return {
    handle(request: Parameters<NodeHttpHandler["handle"]>[0], options?: Parameters<NodeHttpHandler["handle"]>[1]) {
      const rewritten = request.clone();
      rewritten.hostname = uploadDomain;
      rewritten.headers.host = uploadDomain;
      return delegate.handle(rewritten, options);
    },
    destroy() {
      delegate.destroy();
    }
  };
}

function requiredString(source: JsonRecord, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BackendError("TexPage returned incomplete object-storage upload credentials.");
  }
  return value;
}

// Never echo upload errors verbatim: they may include signed URLs or keys.
function describeUploadError(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const cause = causeOf(error);
  const details = [httpStatusOf(error), codeOf(error), codeOf(cause), cause instanceof Error ? cause.name : undefined]
    .filter(Boolean)
    .join(", ");
  return `${name}${details ? `, ${details}` : ""}`;
}

function causeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
}

function httpStatusOf(error: unknown): string | undefined {
  const metadata =
    typeof error === "object" && error !== null && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata
      : undefined;
  return typeof metadata?.httpStatusCode === "number" ? `HTTP ${metadata.httpStatusCode}` : undefined;
}

function codeOf(value: unknown): string | undefined {
  const code =
    typeof value === "object" && value !== null && "code" in value ? (value as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : undefined;
}
