# lasso-java

`lasso-java` is the canonical Service Lasso service repo for packaging Java as a release-backed runtime provider.

The repo does not fork Java. It downloads Eclipse Temurin JRE builds from Adoptium, wraps them in Service Lasso-compatible platform archives, and publishes those archives from protected `main` pushes using the project version pattern:

```text
yyyy.m.d-<shortsha>
```

This repo is public. It is not marked as a GitHub template today; app templates should consume the released `service.json` pattern rather than clone this packaging repo.

## Distribution Decision

The first `lasso-java` release uses Eclipse Temurin JRE builds from Adoptium:

- Java `17.0.18+8`
- Java `21.0.10+7`

Temurin provides redistributable OpenJDK binaries for Windows, Linux, and macOS x64 through Adoptium GitHub releases. The packaging scripts resolve upstream package URLs through the Adoptium API.

Security/update policy: releases are pinned to exact JRE versions. Service Lasso apps should upgrade intentionally by moving their `service.json` asset names and release tags after a new `lasso-java` provider release is verified.

## Release Assets

Each release publishes:

- `lasso-java-17.0.18+8-win32.zip`
- `lasso-java-17.0.18+8-linux.tar.gz`
- `lasso-java-17.0.18+8-darwin.tar.gz`
- `lasso-java-21.0.10+7-win32.zip`
- `lasso-java-21.0.10+7-linux.tar.gz`
- `lasso-java-21.0.10+7-darwin.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

The released `service.json` selects Java `17.0.18+8` as the default provider version.

## Release Contract

Release tags use the Service Lasso version pattern:

```text
yyyy.m.d-<shortsha>
```

The released `service.json` keeps `artifact.source.channel` set to `latest` so new consumers can track the newest Java provider packaging release intentionally. Core `service-lasso` may pin a specific release tag in its own optional provider manifest after verification.

Each platform archive contains the selected Temurin JRE plus `SERVICE-LASSO-PACKAGE.json`.

`SERVICE-LASSO-PACKAGE.json` records:

- Service Lasso service id: `@java`
- upstream vendor: Eclipse Adoptium Temurin
- upstream Java version
- upstream asset name and URL
- packaging repo: `service-lasso/lasso-java`
- target platform and architecture

## Local Verification

```powershell
npm test
```

This packages Java `17.0.18+8` for the current platform by default, extracts the archive, verifies package metadata, and runs `java --version` from the extracted payload.

To verify Java `21.0.10+7`:

```powershell
$env:JAVA_VERSION = "21.0.10+7"
npm test
```

## Service Lasso Contract

The service manifest declares:

- provider role with no managed daemon start requirement
- native archive acquisition from GitHub releases
- Java `17.0.18+8` as the default runtime artifact
- `JAVA` and `JAVA_HOME` provider/global environment hints
- provider version proof using `java --version`
