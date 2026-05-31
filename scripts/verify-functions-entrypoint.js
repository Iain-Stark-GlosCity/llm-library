#!/usr/bin/env node
/*
 * Verify the Azure Functions Node v4 entry point before deployment.
 *
 * AZFD0005 can hide a Node worker crash that happens while the host imports the
 * configured package.json "main" files for metadata discovery. This script fails
 * the build if the compiled entry point is missing or throws at module load.
 */

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const packageJsonPath = path.join(root, 'package.json')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
const main = packageJson.main

if (!main || typeof main !== 'string') {
  throw new Error('package.json must define a string "main" entry point for Azure Functions v4')
}

function posixPath(value) {
  return value.split(path.sep).join('/')
}

function expandMain(pattern) {
  if (!pattern.includes('*')) {
    const candidate = path.resolve(root, pattern)
    return fs.existsSync(candidate) ? [candidate] : []
  }

  const normalized = posixPath(pattern)
  const wildcardIndex = normalized.indexOf('*')
  const slashBeforeWildcard = normalized.lastIndexOf('/', wildcardIndex)
  const directoryPart = slashBeforeWildcard === -1 ? '.' : normalized.slice(0, slashBeforeWildcard)
  const filePattern = slashBeforeWildcard === -1 ? normalized : normalized.slice(slashBeforeWildcard + 1)
  const extension = filePattern.endsWith('.js') ? '.js' : ''
  const directory = path.resolve(root, directoryPart)

  if (!fs.existsSync(directory)) return []

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => (extension ? name.endsWith(extension) : true))
    .map((name) => path.join(directory, name))
    .sort()
}

const files = expandMain(main)

if (files.length === 0) {
  throw new Error(`package.json main "${main}" did not match any compiled entry point files`)
}

for (const file of files) {
  require(file)
}

console.log(
  `Verified Azure Functions entry point ${JSON.stringify(main)} (${files
    .map((file) => path.relative(root, file))
    .join(', ')})`
)
