# Sourced by the tool wrappers: finds a node binary (no npm dependencies needed).
_saas_node() {
  for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -n "$n" ] && [ -x "$n" ] && { echo "$n"; return 0; }
  done
  echo "node not found (install it: brew install node)" >&2; return 1
}
