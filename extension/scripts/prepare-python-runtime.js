#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extensionRoot, "..");
const destRoot = path.join(extensionRoot, "python-src");
const extensionPkg = JSON.parse(
  fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"),
);
const extensionVersion = String(extensionPkg.version || "").trim();

const sources = [
  { from: path.join(repoRoot, "capacitor"), to: path.join(destRoot, "capacitor") },
  { from: path.join(repoRoot, "pyproject.toml"), to: path.join(destRoot, "pyproject.toml") },
  { from: path.join(repoRoot, "README.md"), to: path.join(destRoot, "README.md") },
  { from: path.join(repoRoot, "LICENSE"), to: path.join(extensionRoot, "LICENSE") },
];

fs.rmSync(destRoot, { recursive: true, force: true });
fs.mkdirSync(destRoot, { recursive: true });

for (const item of sources) {
  if (!fs.existsSync(item.from)) {
    throw new Error(`Missing source for runtime bundle: ${item.from}`);
  }
  const stat = fs.statSync(item.from);
  if (stat.isDirectory()) {
    fs.cpSync(item.from, item.to, {
      recursive: true,
      filter: (src) => {
        if (src.includes(`${path.sep}__pycache__`)) { return false; }
        if (src.endsWith(".pyc") || src.endsWith(".pyo")) { return false; }
        return true;
      },
    });
  } else {
    fs.copyFileSync(item.from, item.to);
  }
}

if (!extensionVersion) {
  throw new Error("Extension package.json is missing a valid version.");
}

const runtimePyproject = path.join(destRoot, "pyproject.toml");
const runtimeInit = path.join(destRoot, "capacitor", "__init__.py");
const pyprojectText = fs.readFileSync(runtimePyproject, "utf8")
  .replace(/^version\s*=\s*".*"$/m, `version = "${extensionVersion}"`);
fs.writeFileSync(runtimePyproject, pyprojectText, "utf8");

const initText = fs.readFileSync(runtimeInit, "utf8")
  .replace(/^__version__\s*=\s*".*"$/m, `__version__ = "${extensionVersion}"`);
fs.writeFileSync(runtimeInit, initText, "utf8");

console.log("Prepared bundled python runtime at extension/python-src");
