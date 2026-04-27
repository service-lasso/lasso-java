import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageJava } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const version = process.env.JAVA_VERSION ?? "17.0.18+8";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

const artifact = await packageJava(platform, version);
const verifyRoot = path.join(repoRoot, "output", "verify", version, platform);
const extractRoot = path.join(verifyRoot, "extract");
const binaryPath = path.join(extractRoot, "bin", platform === "win32" ? "java.exe" : "java");

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
await run("tar", ["-xf", artifact, "-C", extractRoot]);

const packageMetadata = JSON.parse(
  await readFile(path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json"), "utf8"),
);
if (
  packageMetadata.serviceId !== "@java" ||
  packageMetadata.upstream?.vendor !== "Eclipse Adoptium Temurin" ||
  packageMetadata.upstream?.version !== version ||
  packageMetadata.packagedBy !== "service-lasso/lasso-java" ||
  packageMetadata.platform !== platform
) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(packageMetadata)}`);
}

const javaVersion = await run(binaryPath, ["--version"], { cwd: extractRoot });
const observed = `${javaVersion.stdout}${javaVersion.stderr}`;
const expectedPrefix = version.replace("+", "+");
if (!observed.includes(expectedPrefix)) {
  throw new Error(`Expected java --version output to contain ${expectedPrefix}, got ${observed}`);
}

console.log(`[lasso-java] verification passed for ${version} on ${platform}`);
