#!/usr/bin/env node

// Builds the session-index sidecar from a Wake checkout into
// resources/session-index/.
//
// Unlike the delegate sidecar, this one is a native executable, so it cannot be
// vendored as a single portable file — it has to be compiled for the platform
// being packaged. It is also the first Rust in Orca's build, which is why the
// toolchain is probed and reported rather than assumed.
//
// Missing cargo or a missing checkout is NOT a build failure: session search is
// an ADR-0002 degradable capability, and the CLI already explains its absence.
// Set ORCA_REQUIRE_SESSION_INDEX=1 to turn a skip into an error for a release
// build that must ship it.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const required = process.env.ORCA_REQUIRE_SESSION_INDEX === '1'
const binaryName = process.platform === 'win32' ? 'wake-index.exe' : 'wake-index'
const outputDir = readArg('--output') ?? join(repoRoot, 'resources', 'session-index')

const source = readArg('--source') ?? process.env.ORCA_WAKE_SOURCE ?? defaultSource()
if (!existsSync(join(source, 'Cargo.toml'))) {
  stop(
    `no Wake checkout at ${source}; set ORCA_WAKE_SOURCE or pass --source <path>. See resources/session-index/PROVENANCE.md.`
  )
}
if (!hasCargo()) {
  stop('cargo is not on PATH; install Rust (https://rustup.rs) to build the session index.')
}

// --no-default-features drops the `desktop` feature, and with it wake-core's
// trash and windows-sys dependencies. A read-only index has no business being
// able to move a user's files to the recycle bin.
const build = spawnSync(
  'cargo',
  [
    'build',
    '--release',
    '--no-default-features',
    '--manifest-path',
    join(source, 'Cargo.toml'),
    '-p',
    'wake-core',
    '--bin',
    'wake-index'
  ],
  { stdio: 'inherit' }
)
if (build.signal) {
  process.kill(process.pid, build.signal)
}
if (build.error) {
  throw build.error
}
if (build.status !== 0) {
  process.exit(build.status ?? 1)
}

const built = join(source, 'target', 'release', binaryName)
if (!existsSync(built)) {
  throw new Error(`cargo reported success but ${built} does not exist.`)
}
mkdirSync(outputDir, { recursive: true })
copyFileSync(built, join(outputDir, binaryName))
console.log(`[session-index] ${join(outputDir, binaryName)}`)

function defaultSource() {
  return join(repoRoot, '..', 'Wake')
}

function hasCargo() {
  const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' })
  return !probe.error && probe.status === 0
}

function stop(reason) {
  if (required) {
    throw new Error(`Session index required but not built: ${reason}`)
  }
  console.log(`[session-index] skipped: ${reason}`)
  process.exit(0)
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}
