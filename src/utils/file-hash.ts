import * as fs from "fs";
import * as crypto from "crypto";

export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(filePath)) {
        resolve("");
        return;
      }
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
  });
}

export function hashFileSync(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}
