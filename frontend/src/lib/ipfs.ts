const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const PREVIEWABLE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "text/csv",
]);

export type UploadedAttachment = {
  cid: string;
  digest: Uint8Array;
  digestHex: string;
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let buffer = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      encoded += alphabet[(buffer >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) encoded += alphabet[(buffer << (5 - bitCount)) & 31];
  return `b${encoded}`;
}

export function rawCidForDigest(digest: Uint8Array): string {
  const cidBytes = new Uint8Array(4 + digest.length);
  cidBytes.set([1, 0x55, 0x12, 0x20]);
  cidBytes.set(digest, 4);
  return base32(cidBytes);
}

export function rawCidFromDigestHex(digestHex: string): string | null {
  if (!/^[0-9a-f]{64}$/i.test(digestHex)) return null;
  const digest = new Uint8Array(32);
  for (let index = 0; index < digest.length; index += 1) {
    digest[index] = Number.parseInt(digestHex.slice(index * 2, index * 2 + 2), 16);
  }
  return rawCidForDigest(digest);
}

export function isPreviewableAttachment(file: File): boolean {
  return PREVIEWABLE_TYPES.has(file.type);
}

export async function uploadIpfsAttachment(file: File): Promise<UploadedAttachment> {
  if (file.size === 0) throw new Error("Choose a non-empty attachment.");
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachments must be 20 MB or smaller.");
  }

  const endpoint = import.meta.env.VITE_IPFS_UPLOAD_ENDPOINT as string | undefined;
  if (!endpoint) {
    throw new Error("IPFS upload is not configured. Set VITE_IPFS_UPLOAD_ENDPOINT to a trusted raw-block upload service.");
  }
  const uploadUrl = new URL(endpoint, window.location.origin);
  if (window.location.protocol === "https:" && uploadUrl.protocol !== "https:") {
    throw new Error("The IPFS upload endpoint must use HTTPS on secure sites.");
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  const digestHex = bytesToHex(digest);
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch(uploadUrl.href, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`IPFS upload failed with HTTP ${response.status}.`);
  }

  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("cid" in body) || typeof body.cid !== "string") {
    throw new Error("IPFS upload service returned an invalid response.");
  }
  if ("sha256" in body && body.sha256 !== digestHex) {
    throw new Error("IPFS upload service returned a digest that does not match the selected file.");
  }

  const expectedCid = rawCidForDigest(digest);
  if (body.cid !== expectedCid) {
    throw new Error("IPFS upload service must pin the file as a CIDv1 raw block matching its SHA-256 digest.");
  }

  return { cid: body.cid, digest, digestHex };
}
