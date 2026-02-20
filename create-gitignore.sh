
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
