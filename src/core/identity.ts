import { X509Certificate } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import forge from "node-forge";
export interface Identity {
  cert: string;
  key: string;
  fingerprint: string;
}
export function fingerprint(raw: Buffer) {
  return new X509Certificate(raw).fingerprint256
    .replaceAll(":", "")
    .toUpperCase();
}
export async function loadIdentity(dir: string): Promise<Identity> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "identity.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      cert: parsed.cert,
      key: parsed.key,
      fingerprint: fingerprint(Buffer.from(parsed.cert)),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber =
    "01" + forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400000);
  const attrs = [{ name: "commonName", value: "LocalSend User" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      keyCertSign: true,
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const result = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
    fingerprint: "",
  };
  result.fingerprint = fingerprint(Buffer.from(result.cert));
  await writeFile(path, JSON.stringify(result), { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return result;
}
