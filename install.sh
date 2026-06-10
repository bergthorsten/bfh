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

echo "Installing @tintinweb/pi-subagents..."
pi install npm:@tintinweb/pi-subagents

echo "Resolving latest BFH release..."
latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${repo}/releases/latest")"
latest_tag="${latest_url##*/}"

if [ -z "$latest_tag" ] || [ "$latest_tag" = "latest" ]; then
  echo "Could not resolve the latest BFH release tag from ${latest_url}" >&2
  exit 1
fi

echo "Installing BFH ${latest_tag}..."
pi install "git:github.com/${repo}@${latest_tag}"

seed_bfh_config() {
  local agent_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
  local config_dir="${agent_dir}/bfh"
  local config="${config_dir}/config.jsonc"
  local example
  example="$(mktemp)"

  curl -fsSL "https://raw.githubusercontent.com/${repo}/${latest_tag}/config.example.jsonc" -o "$example"

  mkdir -p "$config_dir"

  if [ ! -f "$config" ]; then
    cp "$example" "$config"
    echo "Created ${config} — add Jira token or set JIRA_TOKEN."
  else
    echo "BFH config already exists: ${config}"
  fi

  rm -f "$example"
}

seed_bfh_config

echo "Done. Start Pi in your target repository and run: /bfh TICKET-123"
