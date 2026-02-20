#!/usr/bin/env bash
# Initialize a new git project and create remote repositories on GitHub and GitLab.
# IMPORTANT: Run once per project. Not idempotent.

# -e: exit on any error. -u: treat unset variables as errors. -o pipefail: a pipe fails if any component fails.
# This single line would catch the majority of failure modes.
set -euo pipefail

# Dependency Check
for cmd in git gh curl grep ssh; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "ERROR: Required command '$cmd' is not installed or not in PATH."
        exit 1
    fi
done

[[ -f ./.env ]] || { echo "ERROR: .env not found in current directory."; exit 1; }
source ./.env;

required_vars=(APP_NAME GIT_USER_NAME GIT_USER_EMAIL GITLAB_NAMESPACE GITHUB_NAMESPACE GITLAB_KEY_PATH GITHUB_KEY_PATH)
for var in "${required_vars[@]}"; do
    [[ -n "${!var}" ]] || { echo "ERROR: required variable '$var' is not set in .env"; exit 1; }
done

[[ -d .git ]] && { echo "ERROR: .git directory already exists."; exit 1; }
git init -b "main"

git config --local user.name "$GIT_USER_NAME"
git config --local user.email "$GIT_USER_EMAIL"
git config --list --local;

ssh-add -D # delete all identities
ssh-add "${GITLAB_KEY_PATH}"
ssh-add "${GITHUB_KEY_PATH}"

# https://docs.gitignore.io/install/command-line
rm -f .gitignore # to make sure it exist as a result of correct call to toptal.com only
gitignore_templates="linux,windows,macos,jetbrains,kate,sublimetext,visualstudiocode,node"
gitignore_response=$(curl --fail --silent --show-error --location "https://www.toptal.com/developers/gitignore/api/${gitignore_templates}")

# Guard against gitignore.io returning an empty response
if [[ -z "$gitignore_response" ]]; then
  echo "ERROR: empty response from gitignore API." >&2
  exit 1
fi

# Guard against gitignore.io returning an HTML error page instead of content.
if echo "$gitignore_response" | grep -qiE "^\s*<(!DOCTYPE|html)"; then
      echo "ERROR: gitignore.io returned an HTML page — possible outage or bad request." >&2
      exit 1
    else
      echo "$gitignore_response" > .gitignore
fi

# ensure we have .gitignore
[[ -f ./.gitignore ]] || { echo "ERROR: .gitignore not found in current directory."; exit 1; }

# The "error: src refspec main does not match any" in Git means you are trying to push a main branch that doesn't exist locally or has no commits.
# To fix this, create a commit first (git add . then git commit -m "initial"), ensure you are on the main branch (git branch -M main), and push again.
git add . && git commit -m "initial commit"

# add remote repositories:

# GitLab
# GitLab can create new private repo on first push (see https://stackoverflow.com/a/64656788/1697878)
# if you run: git remote add gitlab "git@gitlab.com:${namespace/gitlabUser}/${appName}.git" && git push -u gitlab master
# https://docs.gitlab.com/ee/user/project/
#git remote add gitlab "git@gitlab.com:${GIT_USER_NAME}/${APP_NAME}.git"
git remote add gitlab "git@gitlab.com:${GITLAB_NAMESPACE}/${APP_NAME}.git"

git push --set-upstream gitlab main

# GitHub
## create repo
## https://cli.github.com/manual/gh_repo_create
## gh repo create [<name>] [flags]
gh repo create "${GITHUB_NAMESPACE}/${APP_NAME}" --public

# see: https://docs.github.com/en/get-started/getting-started-with-git/managing-remote-repositories
# git remote add origin git@github.com:<user>/<repo>.git
git remote add github "git@github.com:${GITHUB_NAMESPACE}/${APP_NAME}.git"
git push --set-upstream github main

echo ""
echo "Project '${APP_NAME}' initialized and pushed to both GitHub and GitLab."
git config --list --local

# tag
#
# git tag -a v0.1.0 -m 'version 0.1.0'
