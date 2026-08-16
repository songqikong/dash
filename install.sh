#!/bin/sh
# DASH terminal — install the `dash` profile + launcher for the official dsh CLI.
#
# Creates $DSH_HOME/profiles/dash (default ~/.dsh/profiles/dash) with
# dsh-base + dash-tui bundles and a `dash` launcher on PATH, then you run:
#
#     dash          # or: dsh --profile dash
#
# Re-running install.sh after editing the plugin re-compiles src/*.ts and
# re-copies the dist/ output.
set -eu

SRC="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME_DIR/profiles/dash"
BIN_DIR="${DASH_BIN_DIR:-$HOME/.local/bin}"

if ! command -v dsh >/dev/null 2>&1; then
  echo "[dash] dsh CLI not found — install it first: npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

mkdir -p "$PROFILE/node_modules/dash-tui" "$BIN_DIR"

# profile package.json — bundle order: dsh-base, then dash-tui
cat > "$PROFILE/package.json" <<EOF
{
  "name": "dsh-profile-dash",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dash-tui"
      ]
    }
  }
}
EOF

# profile root — an empty entry list; the tree is composed as patches
printf '# dsh profile root — composed from the bundle layers above.\n[]\n' > "$PROFILE/cordis.yml"

# user patch layer — same provider/model the local Web GUI uses (llm-pi-ai
# settings in $DSH_HOME/settings.yaml activate the opencode-go route).
cat > "$PROFILE/cordis.patch.yml" <<'EOF'
# DASH terminal profile — oh-my-pi usage logic on the DSH kernel.
# Override the default model here, or at launch time with
# DASH_PROVIDER / DASH_MODEL environment variables.

- id: agent-default-model
  config:
    provider: opencode-go
    model: deepseek-v4-flash

# Terminal trust model: no approval prompts and full access (the TUI has no
# questionnaire UI; the terminal is the trust boundary, like every other
# terminal coding agent). defaultPreset must be explicit and match the two
# knob rows below — the permission service rejects unmatchable combinations.
- id: approval
  config:
    policy: never

- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()

- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: danger-full-access
EOF

# compile the TypeScript sources (needs a one-time `npm install` in the repo);
# `sh install.sh --no-build` skips the compile and re-copies the existing dist/
if [ "${1:-}" != "--no-build" ]; then
  if [ ! -x "$SRC/node_modules/.bin/tsc" ]; then
    echo "[dash] TypeScript toolchain missing — run: (cd $SRC && npm install)" >&2
    exit 1
  fi
  "$SRC/node_modules/.bin/tsc" -p "$SRC" || exit 1
fi

# the plugin package itself (copied, not symlinked, so require()/import of the
# @deepseek-ai packages resolves through the shared profiles/node_modules)
rm -rf "$PROFILE/node_modules/dash-tui"
mkdir -p "$PROFILE/node_modules/dash-tui/dist"
cp -f "$SRC/package.json" "$SRC/cordis.patch.yml" "$PROFILE/node_modules/dash-tui/"
cp -f "$SRC"/dist/*.js "$PROFILE/node_modules/dash-tui/dist/"

# launcher
cat > "$BIN_DIR/dash" <<EOF
#!/bin/sh
# DASH — Deepseek Agentic Service Harness (terminal). oh-my-pi TUI on the DSH kernel.
exec dsh --profile dash "\$@"
EOF
chmod +x "$BIN_DIR/dash"

echo "[dash] installed:"
echo "  profile   $PROFILE"
echo "  launcher  $BIN_DIR/dash"
echo "  run:  dash        (or: dsh --profile dash)"
echo "  env:  DASH_PROVIDER / DASH_MODEL override the default model"
