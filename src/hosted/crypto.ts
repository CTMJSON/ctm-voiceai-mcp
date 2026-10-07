import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "../errors.js";

/** Associated data makes ciphertext copied between owners or record types unreadable. */
export class Sealer {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("HOSTED_ENCRYPTION_KEY must encode 32 random bytes.");
  }
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }
  open(value: string, context: string): unknown {
    try {
      const [version, iv, tag, body, extra] = value.split(".");
      if (version !== "v1" || !iv || !tag || !body || extra) throw new Error("format");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"));
    } catch {
      throw new AppError("Stored data could not be verified.", "STORAGE_ERROR", 503);
    }
  }
}
