import * as fsp from "fs/promises";
import * as crypto from "crypto";
import { createReadStream } from "fs";

export async function hashFile(filePath: string): Promise<string> {
  try {
    await fsp.access(filePath);
  } catch {
    return "";
  }
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
  });
}
