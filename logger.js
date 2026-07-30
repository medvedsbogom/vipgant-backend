import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = resolve(__dirname, "..", "logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

let logger;

try {
  const { createLogger, format, transports } = await import("winston");

  logger = createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: format.combine(
      format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      format.printf(({ timestamp, level, message }) => `${timestamp} ${level.toUpperCase()} ${message}`)
    ),
    transports: [
      new transports.File({ filename: resolve(LOGS_DIR, "error.log"), level: "error" }),
      new transports.File({ filename: resolve(LOGS_DIR, "combined.log") }),
    ],
  });

  if (process.env.NODE_ENV !== "production") {
    logger.add(new transports.Console({ format: format.simple() }));
  }
} catch (error) {
  console.warn("Winston is unavailable; using fallback console logger.", error?.message || error);
  logger = {
    info: (...args) => console.log("INFO", ...args),
    warn: (...args) => console.warn("WARN", ...args),
    error: (...args) => console.error("ERROR", ...args),
    debug: (...args) => console.debug("DEBUG", ...args),
  };
}

export default logger;
