#!/usr/bin/env bun
/**
 * Isolated Bun test runner.
 *
 * Bun's `mock.module()` writes to a process-global registry that is never reset
 * between test files (oven-sh/bun#12823), so a single `bun test` invocation makes
 * results depend on the order files happen to be discovered in. Running each test
 * file in its own process guarantees every file starts with a clean module registry.
 *
 * Usage:
 *   bun scripts/run-isolated-tests.js [options] [roots...]
 *
 * Options:
 *   --cwd <dir>         Directory the tests run in (default: current directory)
 *   --preload <paths>   Comma-separated preload scripts, relative to cwd
 *   --concurrency <n>   Max parallel test processes (default: 4, or TEST_CONCURRENCY)
 *   --retry <n>         Retry each failing test up to n times (default: 0)
 *   --timeout <ms>      Per-test timeout in milliseconds (Bun default: 5000)
 *   --ignore <glob>     Path glob to skip (repeatable)
 *
 * Examples:
 *   bun scripts/run-isolated-tests.js --preload ./test-setup-dom.js src scripts
 *   bun scripts/run-isolated-tests.js --cwd backend src
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const TEST_EXTENSIONS = ['js', 'ts', 'tsx'];
const DEFAULT_IGNORES = ['node_modules', '.next', 'dist', 'build', 'src-tauri', 'coverage'];

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    preloads: [],
    ignores: [],
    concurrency: Number(process.env.TEST_CONCURRENCY) || 4,
    retry: Number(process.env.TEST_RETRY) || 0,
    timeout: Number(process.env.TEST_TIMEOUT) || 0,
    roots: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') {
      options.cwd = path.resolve(argv[++i]);
    } else if (arg === '--preload') {
      options.preloads.push(...argv[++i].split(',').filter(Boolean));
    } else if (arg === '--concurrency') {
      options.concurrency = Math.max(1, Number(argv[++i]) || 1);
    } else if (arg === '--retry') {
      options.retry = Math.max(0, Number(argv[++i]) || 0);
    } else if (arg === '--timeout') {
      options.timeout = Math.max(0, Number(argv[++i]) || 0);
    } else if (arg === '--ignore') {
      options.ignores.push(argv[++i]);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.roots.push(arg);
    }
  }

  if (options.roots.length === 0) {
    options.roots = ['src', 'scripts'];
  }

  return options;
}

function discoverTestFiles(roots, ignores, cwd) {
  const files = [];
  const seen = new Set();
  const patterns = TEST_EXTENSIONS.map((ext) => new Bun.Glob(`**/*.test.${ext}`));
  const isIgnored = (relativePath) => {
    if (DEFAULT_IGNORES.some((segment) => relativePath.split(/[\\/]/).includes(segment))) {
      return true;
    }
    return ignores.some((glob) => new Bun.Glob(glob).match(relativePath));
  };

  for (const root of roots) {
    // Allow passing explicit test file paths as well as directories.
    if (TEST_EXTENSIONS.some((ext) => root.endsWith(`.test.${ext}`))) {
      if (!seen.has(root)) {
        seen.add(root);
        files.push(root);
      }
      continue;
    }

    for (const pattern of patterns) {
      for (const relative of pattern.scanSync({ cwd: path.join(cwd, root), onlyFiles: true })) {
        // Prefix so paths stay relative to the working directory the tests run in.
        const filePath = path.join(root, relative);
        if (isIgnored(relative) || seen.has(filePath)) continue;
        seen.add(filePath);
        files.push(filePath);
      }
    }
  }

  return files.sort();
}

function runTestFile(file, options) {
  return new Promise((resolve) => {
    const args = ['test'];
    for (const preload of options.preloads) {
      args.push('--preload', preload);
    }
    if (options.retry > 0) {
      args.push('--retry', String(options.retry));
    }
    if (options.timeout > 0) {
      args.push('--timeout', String(options.timeout));
    }
    args.push(file);

    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => {
      resolve({ file, ok: false, output: String(error), duration: Date.now() - startedAt });
    });
    child.on('close', (code) => {
      resolve({ file, ok: code === 0, output, duration: Date.now() - startedAt });
    });
  });
}

async function runPool(files, options) {
  const results = [];
  let next = 0;
  let completed = 0;

  async function worker() {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      const result = await runTestFile(file, options);
      results[index] = result;
      completed++;
      const status = result.ok ? '\u2713' : '\u2717';
      process.stdout.write(`[${completed}/${files.length}] ${status} ${file}\n`);
    }
  }

  const workers = Array.from({ length: Math.min(options.concurrency, files.length) }, worker);
  await Promise.all(workers);
  return results;
}

function formatSummary(results, durationMs) {
  const failed = results.filter((result) => result && !result.ok);
  const lines = [];

  for (const result of failed) {
    lines.push('');
    lines.push(`\u2717 ${result.file}`);
    lines.push('-'.repeat(60));
    lines.push(result.output.trimEnd());
  }

  lines.push('');
  lines.push(
    `${results.length - failed.length}/${results.length} test files passed in ${(durationMs / 1000).toFixed(1)}s`
  );

  if (failed.length > 0) {
    lines.push(`${failed.length} file(s) failed:`);
    for (const result of failed) {
      lines.push(`  - ${result.file}`);
    }
  }

  return lines.join('\n');
}

const options = parseArgs(process.argv.slice(2));
const files = discoverTestFiles(options.roots, options.ignores, options.cwd);

if (files.length === 0) {
  console.error('No test files found.');
  process.exit(1);
}

console.log(
  `Running ${files.length} test file(s) in isolated processes (concurrency ${options.concurrency})...\n`
);

const startedAt = Date.now();
const results = await runPool(files, options);
const failed = results.filter((result) => !result.ok);

console.log(formatSummary(results, Date.now() - startedAt));
process.exit(failed.length > 0 ? 1 : 0);
