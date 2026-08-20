#!/usr/bin/env node
// Dev-only build: takes the working plugin at ../plugins/cf-deploy and produces an
// obfuscated, time-limited copy at ../plugins/cf-deploy-trial. Never run against the
// working plugin's own files — it only reads from there and writes elsewhere.
//
// Not part of either shipped plugin. Requires `npm install` inside tools/ first.

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import obfuscator from "javascript-obfuscator";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "plugins", "cf-deploy");
const OUT = join(ROOT, "plugins", "cf-deploy-trial");

const EXPIRES_AT_UTC = Date.UTC(2026, 7, 22, 23, 59, 59); // month is 0-indexed: 7 = August

const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.3,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.8,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  selfDefending: true,
  disableConsoleOutput: false, // the CLI's whole purpose is console output
  target: "node",
};

function obfuscate(code) {
  return obfuscator.obfuscate(code, OBFUSCATOR_OPTIONS).getObfuscatedCode();
}

/**
 * Inserts `snippet` right after the last top-level `import ... ;` line, or at the very
 * top of the file if it has none.
 */
function insertAfterImports(source, snippet) {
  const lines = source.split("\n");
  let lastImportLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\b/.test(lines[i])) lastImportLine = i;
  }
  lines.splice(lastImportLine + 1, 0, snippet);
  return lines.join("\n");
}

function buildExpiryModule() {
  return `export function assertNotExpired() {
  if (Date.now() > ${EXPIRES_AT_UTC}) {
    console.error("Триал истёк.");
    process.exit(1);
  }
}
`;
}

function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "lib"), { recursive: true });
  mkdirSync(join(OUT, "bin"), { recursive: true });
  mkdirSync(join(OUT, ".claude-plugin"), { recursive: true });
  mkdirSync(join(OUT, "skills", "publish-site"), { recursive: true });

  // 1. The expiry module itself, obfuscated like everything else.
  writeFileSync(join(OUT, "lib", "_expiry.js"), obfuscate(buildExpiryModule()));

  // 2. cfApi.js — inject a gate at the top of every request(), the single choke point
  //    every Cloudflare call passes through. This is the defense-in-depth layer: it
  //    fires even if something calls a lib function directly, bypassing bin/cf-deploy.
let cfApiSrc = readFileSync(join(SRC, "lib", "cfApi.js"), "utf8");
  cfApiSrc = insertAfterImports(cfApiSrc, `import { assertNotExpired } from "./_expiry.js";`);
  const beforeInjection = cfApiSrc;
  cfApiSrc = cfApiSrc.replace(/(async function request\([^)]*\)\s*\{)/, `$1\n    assertNotExpired();`);
  if (cfApiSrc === beforeInjection) {
    throw new Error("failed to inject the request() gate — anchor pattern did not match, check lib/cfApi.js");
  }
  writeFileSync(join(OUT, "lib", "cfApi.js"), obfuscate(cfApiSrc));

  // 3. Every other lib file: obfuscate as-is, no injection needed.
  const plainLibFiles = ["config.js", "zones.js", "dns.js", "pagesUpload.js", "pagesProjects.js", "pagesDomains.js", "mime.js"];
  for (const file of plainLibFiles) {
    const src = readFileSync(join(SRC, "lib", file), "utf8");
    writeFileSync(join(OUT, "lib", file), obfuscate(src));
  }

  // 4. bin/cf-deploy — gate at the very first line after imports, before anything
  //    (including --help) can run.
  let binSrc = readFileSync(join(SRC, "bin", "cf-deploy"), "utf8");
  const shebangLine = binSrc.startsWith("#!") ? binSrc.slice(0, binSrc.indexOf("\n") + 1) : "";
  const rest = binSrc.slice(shebangLine.length);
  let gatedRest = insertAfterImports(rest, `import { assertNotExpired } from "../lib/_expiry.js";\nassertNotExpired();`);
  if (!gatedRest.includes("assertNotExpired();")) {
    throw new Error("failed to inject the bin/cf-deploy gate — anchor pattern did not match");
  }
  const binPath = join(OUT, "bin", "cf-deploy");
  writeFileSync(binPath, shebangLine + obfuscate(gatedRest));
  chmodSync(binPath, 0o755); // writeFileSync does not carry over the source file's execute bit

  // 5. Third-party vendored dependency: copied verbatim, never obfuscated — it isn't our
  //    IP, and mangling a wasm-loading package is a good way to silently break it.
  cpSync(join(SRC, "node_modules"), join(OUT, "node_modules"), { recursive: true });

  // 6. Plugin metadata — reuse the skill and package.json, renamed for this listing.
  const pluginJson = JSON.parse(readFileSync(join(SRC, ".claude-plugin", "plugin.json"), "utf8"));
  pluginJson.name = "cf-deploy-trial";
  pluginJson.description = `${pluginJson.description} — trial, available through Aug 22, 2026`;
  writeFileSync(join(OUT, ".claude-plugin", "plugin.json"), JSON.stringify(pluginJson, null, 2) + "\n");

  const pkgJson = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8"));
  pkgJson.name = "cf-deploy-trial";
  writeFileSync(join(OUT, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  cpSync(join(SRC, "skills", "publish-site", "SKILL.md"), join(OUT, "skills", "publish-site", "SKILL.md"));

  // 7. This directory is ALSO its own marketplace root (source: "."), deliberately.
  //    It must never be added as a second entry to the main repo's marketplace.json —
  //    that file also lists the full unobfuscated `cf-deploy` with no expiry, and a
  //    client browsing the same marketplace could just install that one instead.
  //    Distribute ONLY this folder (zip it, or push it as its own repo) — never the
  //    repo root.
  writeFileSync(
    join(OUT, ".claude-plugin", "marketplace.json"),
    JSON.stringify(
      {
        name: "cf-deploy-trial-marketplace",
        owner: { name: "Lemax" },
        description: "cf-deploy trial",
        plugins: [
          {
            name: "cf-deploy-trial",
            source: ".",
            description: pluginJson.description,
            version: pluginJson.version,
            category: "deployment",
            tags: ["cloudflare", "pages", "deploy", "dns", "trial"],
          },
        ],
      },
      null,
      2
    ) + "\n"
  );

  console.log(`Built trial plugin at ${OUT}`);
  console.log(`Expires: ${new Date(EXPIRES_AT_UTC).toISOString()}`);
}

main();
