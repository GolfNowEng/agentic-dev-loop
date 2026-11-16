#!/bin/sh
# Runs INSIDE the template-build sandbox (as the sandbox user, `agent`), via
# `npm run sbx:template:build`. Edit this file to add packages or settings,
# then rebuild under a new tag. See docs/sandbox-sbx.md.
#
# Args: <node major>
set -eu

NODE_MAJOR="$1"

# --- packages -------------------------------------------------------------
# Debian's own nodejs is too old; nodesource provides each major.
# Needs: sbx policy allow network deb.nodesource.com (once, by you).
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
sudo apt-get install -y nodejs jq direnv
# Add more apt packages here, e.g.:
# sudo apt-get install -y ripgrep

# --- git ------------------------------------------------------------------
# No ~/.ssh in the sandbox: SSH remotes go over HTTPS, where the proxy adds the token.
git config --global url."https://github.com/".insteadOf git@github.com:
# The image has no pager; git would fail with "unable to execute pager".
git config --global core.pager cat

# --- direnv ---------------------------------------------------------------
# The skills run target-repo commands through `direnv exec`, so direnv is
# installed here. Allowing a repo's .envrc is NOT done by this script: it is
# your approval, typed at the prompt template:build shows you afterwards.

# --- check ----------------------------------------------------------------
node --version
jq --version
git --version
gh --version | head -1
direnv version
echo "template-build: ok"
