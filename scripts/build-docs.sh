#!/usr/bin/env bash
set -euo pipefail

# Documentation build entry point for Accord Protocol
# Generates Rustdoc (contracts/accord), TypeDoc (frontend public library),
# and an index landing page into a unified output directory.

OUTPUT_DIR="${1:-docs-site}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Building Accord Protocol Documentation ==="
echo "Target directory: $REPO_ROOT/$OUTPUT_DIR"

rm -rf "$REPO_ROOT/$OUTPUT_DIR"
mkdir -p "$REPO_ROOT/$OUTPUT_DIR"

# 1. Build Rustdoc for contracts/accord
echo "--- 1. Building Rustdoc for contracts/accord ---"
(
  cd "$REPO_ROOT"
  # Try building with -D warnings first to keep doc comments clean
  if RUSTDOCFLAGS="-D warnings" cargo doc -p accord --no-deps; then
    echo "Rustdoc built with zero warnings."
  else
    echo "Notice: Rustdoc built with existing warnings (recorded as follow-up)."
    cargo doc -p accord --no-deps
  fi
)

mkdir -p "$REPO_ROOT/$OUTPUT_DIR/rust"
if [ -d "$REPO_ROOT/target/doc" ]; then
  cp -r "$REPO_ROOT/target/doc"/* "$REPO_ROOT/$OUTPUT_DIR/rust/"
fi

# 2. Build TypeDoc for frontend public API
echo "--- 2. Building TypeDoc for frontend client API ---"
(
  cd "$REPO_ROOT/frontend"
  npx typedoc --options typedoc.json --out "$REPO_ROOT/$OUTPUT_DIR/typescript"
)

# 3. Publish the public status page
# The page is rendered from the committed status data; the health probes that
# refresh that data run in .github/workflows/status-page.yml.
echo "--- 3. Rendering the public status page ---"
node "$REPO_ROOT/scripts/status-page.mjs" render --out="$REPO_ROOT/$OUTPUT_DIR/status.html"

# 4. Create landing index.html linking both references
echo "--- 4. Generating documentation index ---"
cat > "$REPO_ROOT/$OUTPUT_DIR/index.html" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Accord Protocol — API Documentation</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --border: #1f2937;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #3b82f6;
      --accent-hover: #60a5fa;
    }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
      box-sizing: border-box;
    }
    .container {
      max-width: 800px;
      width: 100%;
      text-align: center;
    }
    h1 {
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      font-weight: 700;
      letter-spacing: -0.025em;
    }
    p.lead {
      color: var(--text-muted);
      font-size: 1.125rem;
      margin-bottom: 2.5rem;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
      text-align: left;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.75rem;
      text-decoration: none;
      color: inherit;
      transition: all 0.2s ease;
      display: flex;
      flex-direction: column;
    }
    .card:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
      box-shadow: 0 10px 25px -5px rgba(59, 130, 246, 0.1);
    }
    .badge {
      display: inline-block;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.25rem 0.5rem;
      border-radius: 0.375rem;
      margin-bottom: 1rem;
      width: fit-content;
    }
    .badge-rust {
      background: rgba(249, 115, 22, 0.15);
      color: #fb923c;
    }
    .badge-ts {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
    }
    .badge-status {
      background: rgba(34, 197, 94, 0.15);
      color: #22c55e;
    }
    .card h2 {
      margin: 0 0 0.5rem 0;
      font-size: 1.35rem;
    }
    .card p {
      margin: 0;
      color: var(--text-muted);
      font-size: 0.95rem;
      line-height: 1.5;
    }
    footer {
      margin-top: 3rem;
      font-size: 0.875rem;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Accord Protocol Documentation</h1>
    <p class="lead">Official API reference documentation for smart contracts and frontend client libraries.</p>
    <div class="cards">
      <a href="./rust/accord/index.html" class="card">
        <span class="badge badge-rust">Rustdoc</span>
        <h2>Smart Contract API</h2>
        <p>Documentation for the Accord Soroban smart contract crate, including data types, storage keys, errors, and public entrypoints.</p>
      </a>
      <a href="./typescript/index.html" class="card">
        <span class="badge badge-ts">TypeDoc</span>
        <h2>Frontend Client API</h2>
        <p>Documentation for frontend public TypeScript modules, including domain types, wallet connection, RPC helpers, and contract wrappers.</p>
      </a>
      <a href="./status.html" class="card">
        <span class="badge badge-status">Status</span>
        <h2>Service Status</h2>
        <p>Live status, recent availability and incident notes for the Accord indexer and analytics API.</p>
      </a>
    </div>
    <footer>
      Accord Protocol &bull; API Documentation
    </footer>
  </div>
</body>
</html>
EOF

echo "=== Documentation build complete: $OUTPUT_DIR ==="
