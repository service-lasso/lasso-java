import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const javaVersion = process.env.JAVA_VERSION ?? "17.0.18+8";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;

const targets = {
  win32: {
    adoptiumOs: "windows",
    assetOs: "windows",
    archiveType: "zip",
    binary: "bin/java.exe",
    command: ".\\bin\\java.exe",
  },
  linux: {
    adoptiumOs: "linux",
    assetOs: "linux",
    archiveType: "tar.gz",
    binary: "bin/java",
    command: "./bin/java",
  },
  darwin: {
    adoptiumOs: "mac",
    assetOs: "mac",
    archiveType: "tar.gz",
    binary: "Contents/Home/bin/java",
    command: "./bin/java",
  },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function versionedAssetName(version, platform, archiveType) {
  return `lasso-java-${version}-${platform}.${archiveType === "zip" ? "zip" : "tar.gz"}`;
}

function featureVersion(version) {
  const match = /^(\d+)\./.exec(version);
  if (!match) {
    throw new Error(`Cannot derive Java feature version from "${version}".`);
  }
  return Number(match[1]);
}

function exactTemurinAsset(target, version) {
  const feature = featureVersion(version);
  const normalizedVersion = version.replace("+", "_");
  const extension = target.archiveType === "zip" ? "zip" : "tar.gz";
  const assetName = `OpenJDK${feature}U-jre_x64_${target.assetOs}_hotspot_${normalizedVersion}.${extension}`;
  const releaseTag = `jdk-${version}`;
  return {
    url: `https://github.com/adoptium/temurin${feature}-binaries/releases/download/${encodeURIComponent(releaseTag)}/${assetName}`,
    name: assetName,
    checksum: null,
    releaseName: releaseTag,
  };
}

async function assertExactAssetExists(asset) {
  const response = await fetch(asset.url, {
    method: "HEAD",
    redirect: "follow",
    headers: {
      "user-agent": "service-lasso-lasso-java-packager",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve exact Temurin asset ${asset.url}: ${response.status} ${response.statusText}`);
  }

  return asset;
}

async function fetchAdoptiumPackage(target, version) {
  const url = new URL(`https://api.adoptium.net/v3/assets/version/${encodeURIComponent(version)}`);
  url.searchParams.set("architecture", "x64");
  url.searchParams.set("heap_size", "normal");
  url.searchParams.set("image_type", "jre");
  url.searchParams.set("jvm_impl", "hotspot");
  url.searchParams.set("os", target.adoptiumOs);
  url.searchParams.set("vendor", "eclipse");

  const response = await fetch(url, {
    headers: {
      "user-agent": "service-lasso-lasso-java-packager",
    },
  });

  if (response.status === 404) {
    return await assertExactAssetExists(exactTemurinAsset(target, version));
  }

  if (!response.ok) {
    throw new Error(`Failed to resolve Adoptium metadata from ${url}: ${response.status} ${response.statusText}`);
  }

  const releases = await response.json();
  const releaseList = Array.isArray(releases) ? releases : [releases];
  const binary = releaseList
    .flatMap((release) => release.binaries ?? (release.binary ? [release.binary] : []))
    .find((entry) => entry.package?.link);
  if (!binary?.package?.link || !binary.package.name) {
    throw new Error(`No Adoptium JRE package found for ${version} on ${target.adoptiumOs}.`);
  }

  const resolvedVersion =
    releaseList[0]?.version_data?.openjdk_version ??
    releaseList[0]?.version?.openjdk_version ??
    releaseList[0]?.version?.semver ??
    null;
  if (!resolvedVersion || !resolvedVersion.startsWith(version)) {
    throw new Error(`Resolved Adoptium package version "${resolvedVersion}" did not match requested "${version}".`);
  }

  return {
    url: binary.package.link,
    name: binary.package.name,
    checksum: binary.package.checksum,
    releaseName: releaseList[0]?.release_name ?? null,
  };
}

async function download(url, destination) {
  if (existsSync(destination)) {
    return;
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "service-lasso-lasso-java-packager",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${JSON.stringify(path.join(packageRoot, "*"))} -DestinationPath ${JSON.stringify(outputPath)} -Force`,
    ]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

async function findDistributionRoot(extractRoot, target) {
  const entries = await readdir(extractRoot, { withFileTypes: true });
  const candidates = [
    extractRoot,
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(extractRoot, entry.name)),
  ];

  for (const candidate of candidates) {
    const binaryPath = path.join(candidate, target.binary);
    if (existsSync(binaryPath)) {
      return candidate;
    }
  }

  throw new Error(`Could not find Java binary "${target.binary}" under ${extractRoot}.`);
}

export async function packageJava(platform = targetPlatform, version = javaVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}`);
  }

  if (!/^\d+\.\d+\.\d+\+\d+$/.test(version)) {
    throw new Error(`Expected Java version like "17.0.18+8", got "${version}".`);
  }

  const upstream = await fetchAdoptiumPackage(target, version);
  const vendorRoot = path.join(repoRoot, "vendor", version, platform);
  const outputRoot = path.join(repoRoot, "output", "package", version, platform);
  const extractRoot = path.join(outputRoot, "extract");
  const packageRoot = path.join(outputRoot, "payload");
  const upstreamArchive = path.join(vendorRoot, upstream.name);
  const assetName = versionedAssetName(version, platform, target.archiveType);
  const outputPath = path.join(repoRoot, "dist", assetName);

  await mkdir(vendorRoot, { recursive: true });
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });

  await download(upstream.url, upstreamArchive);
  run("tar", ["-xf", upstreamArchive, "-C", extractRoot]);

  const distributionRoot = await findDistributionRoot(extractRoot, target);
  const copyRoot = platform === "darwin" ? path.join(distributionRoot, "Contents", "Home") : distributionRoot;
  await cp(copyRoot, packageRoot, { recursive: true });
  if (target.archiveType !== "zip") {
    await chmod(path.join(packageRoot, "bin", "java"), 0o755);
  }

  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "@java",
        upstream: {
          vendor: "Eclipse Adoptium Temurin",
          repo: `adoptium/temurin${featureVersion(version)}-binaries`,
          version,
          asset: upstream.name,
          url: upstream.url,
          checksum: upstream.checksum,
          release: upstream.releaseName,
        },
        packagedBy: "service-lasso/lasso-java",
        platform,
        arch: "x64",
        command: target.command,
        distribution: "Eclipse Temurin JRE",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-java] packaged ${outputPath}`);
  return outputPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageJava();
}
