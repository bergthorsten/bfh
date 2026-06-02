#!/usr/bin/env bash
set -euo pipefail

required_major=22
repo="bergthorsten/bfh"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js ${required_major} or newer, then rerun this script." >&2
  exit 1
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [ "$node_major" -lt "$required_major" ]; then
  echo "Node.js ${required_major}+ is required. Current version: $(node --version)" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found on PATH." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but was not found on PATH." >&2
  exit 1
fi

echo "Installing Pi..."
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

echo "Installing pi-subagents..."
pi install npm:pi-subagents

echo "Resolving latest BFH release..."
latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${repo}/releases/latest")"
latest_tag="${latest_url##*/}"

if [ -z "$latest_tag" ] || [ "$latest_tag" = "latest" ]; then
  echo "Could not resolve the latest BFH release tag from ${latest_url}" >&2
  exit 1
fi

echo "Installing BFH ${latest_tag}..."
pi install "git:github.com/${repo}@${latest_tag}"

echo "Done. Start Pi in your target repository and run: /bfh TICKET-123"
