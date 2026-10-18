#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Regex patterns for credentials and secret tokens that must never be committed.
const SECRET_RULES = [
  { name: 'Private Key', pattern: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/ },
  { name: 'GitHub Personal Access Token (classic)', pattern: /\bghp_[A-Za-z0-9_]{36}\b/ },
  { name: 'GitHub OAuth Access Token', pattern: /\bgho_[A-Za-z0-9_]{36}\b/ },
  { name: 'GitHub Fine-grained PAT', pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/ },
  { name: 'Anthropic API Key', pattern: /\bsk-ant-api03-[A-Za-z0-9_-]{80,}\b/ },
  { name: 'OpenAI API Key', pattern: /\bsk-[A-Za-z0-9]{48}\b/ },
  { name: 'AWS Access Key ID', pattern: /\bAKIA[0-9A-Z]{16}\b/ }
];

// Files that legitimately define secret detection patterns or test redactions
const ALLOWED_TEST_FILES = new Set([
  'src/main/app/log.ts',
  'src/shared/secrets.ts',
  'tests/unit/log.test.ts',
  'tests/unit/secrets.test.ts',
  'tests/unit/renderer/sessionLogic.test.ts',
  'scripts/check-secrets.mjs'
]);

function getTrackedFiles() {
  try {
    const stdout = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' });
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    // If not in a git repo, fall back to walk
    return [];
  }
}

const files = getTrackedFiles();
let foundViolations = 0;

for (const relPath of files) {
  const normPath = relPath.replace(/\\/g, '/');
  if (ALLOWED_TEST_FILES.has(normPath)) continue;

  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;

  // Skip binary files or lockfiles
  if (relPath.endsWith('.png') || relPath.endsWith('.ico') || relPath.endsWith('.woff') || relPath.endsWith('.woff2') || relPath.endsWith('.ttf')) {
    continue;
  }

  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch {
    continue;
  }

  for (const rule of SECRET_RULES) {
    const match = rule.pattern.exec(content);
    if (match) {
      console.error(`[SECRETS] ${normPath}: detected ${rule.name}: ${match[0].slice(0, 8)}...`);
      foundViolations++;
    }
  }
}

if (foundViolations > 0) {
  console.error(`\nCheck failed: Found ${foundViolations} potential secret(s) in repository files.`);
  process.exit(1);
} else {
  console.log(`[SECRETS] Scanned ${files.length} tracked files. No secret credentials detected.`);
  process.exit(0);
}
