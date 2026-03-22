#!/bin/bash

# Script to generate combined attribution file for Rust and JavaScript dependencies
# Lists direct dependencies only — each library is responsible for attributing its own deps.
# Usage: npm run generate:attributions

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "Generating attribution file..."
echo ""

# Write HTML header
cat > ATTRIBUTIONS.html << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Third-Party Attributions</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 860px;
      margin: 0 auto;
      padding: 2rem;
      color: #222;
      line-height: 1.6;
    }
    h1 { border-bottom: 2px solid #e0e0e0; padding-bottom: 0.5rem; }
    h2 { margin-top: 2.5rem; color: #444; font-size: 1.2rem; text-transform: uppercase;
         letter-spacing: 0.05em; }
    .dep {
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      margin: 0.75rem 0;
      overflow: hidden;
    }
    .dep-header {
      padding: 0.4rem 1rem;
      background: #f8f8f8;
    }
    .dep-crate {
      display: flex;
      align-items: baseline;
      gap: 0.75rem;
      padding: 0.2rem 0;
    }
    .dep-name { font-weight: 600; }
    .dep-spdx { color: #666; font-size: 0.82rem; font-family: monospace; }
    .dep-license { color: #666; font-size: 0.82rem; font-family: monospace; }
    details > summary {
      cursor: pointer;
      padding: 0.4rem 1rem;
      font-size: 0.8rem;
      color: #555;
      background: #fafafa;
      border-top: 1px solid #e8e8e8;
      list-style: none;
    }
    details > summary::-webkit-details-marker { display: none; }
    details > summary::before { content: '▶ '; font-size: 0.65rem; }
    details[open] > summary::before { content: '▼ '; }
    details > summary:hover { background: #f0f0f0; }
    pre {
      margin: 0;
      padding: 1rem;
      font-size: 0.78rem;
      line-height: 1.5;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      background: #fdfdfd;
      border-top: 1px solid #e8e8e8;
    }
    hr { border: none; border-top: 2px solid #e0e0e0; margin: 2.5rem 0; }
    a { color: #0969da; }
  </style>
</head>
<body>
  <h1>Third-Party Software Attributions</h1>
  <p>This page lists the licenses for direct third-party dependencies used in this project.
  Each library is responsible for the attribution of its own dependencies.</p>

  <h2>Rust Dependencies</h2>
EOF

# Generate Rust dependencies attribution
echo "Collecting Rust dependencies..."
cd src-tauri
if ! command -v cargo-about &> /dev/null; then
    echo "Error: cargo-about is not installed. Please run: cargo install cargo-about"
    exit 1
fi

cargo about generate ../about.hbs >> ../ATTRIBUTIONS.html
cd ..

# Add JS section header
cat >> ATTRIBUTIONS.html << 'EOF'

  <hr>
  <h2>JavaScript / TypeScript Dependencies</h2>
EOF

# Generate JavaScript dependencies attribution (direct deps only, read from node_modules)
echo "Collecting JavaScript dependencies..."

python3 << 'PYEOF' >> ATTRIBUTIONS.html
import json, os, glob, html

with open('package.json') as f:
    pkg = json.load(f)

deps = sorted(pkg.get('dependencies', {}).keys())

for dep in deps:
    dep_dir = os.path.join('node_modules', dep)
    try:
        with open(os.path.join(dep_dir, 'package.json')) as f:
            dep_pkg = json.load(f)
    except FileNotFoundError:
        print(f'<div class="dep"><div class="dep-header"><span class="dep-name">{html.escape(dep)}</span>'
              f'<span class="dep-license">package not found in node_modules</span></div></div>')
        continue

    version = dep_pkg.get('version', 'unknown')
    license_str = dep_pkg.get('license', 'Unknown')
    repo = dep_pkg.get('repository', '')
    if isinstance(repo, dict):
        repo = repo.get('url', '')
    if repo.startswith('git+'):
        repo = repo[4:]
    if repo.endswith('.git'):
        repo = repo[:-4]

    repo_link = f' &mdash; <a href="{html.escape(repo)}">{html.escape(repo)}</a>' if repo else ''

    print('<div class="dep">')
    print(f'  <div class="dep-header">')
    print(f'    <div class="dep-crate">')
    print(f'      <span class="dep-name">{html.escape(dep)} v{html.escape(version)}</span>')
    print(f'      <span class="dep-spdx">{html.escape(license_str)}{repo_link}</span>')
    print(f'    </div>')
    print(f'  </div>')

    license_files = sorted(
        glob.glob(os.path.join(dep_dir, 'LICENSE*')) +
        glob.glob(os.path.join(dep_dir, 'LICENCE*')) +
        glob.glob(os.path.join(dep_dir, 'COPYING*'))
    )
    license_files = [f for f in license_files if not f.endswith('.spdx')]

    # Prefer MIT when multiple license files exist (dual-licensed), matching cargo-about behaviour
    if len(license_files) > 1:
        mit = [f for f in license_files if 'MIT' in os.path.basename(f).upper()]
        license_files = mit[:1] if mit else license_files[:1]

    if license_files:
        with open(license_files[0], errors='replace') as f:
            content = f.read().strip()
        print(f'  <details>')
        print(f'    <summary>View license text ({os.path.basename(license_files[0])})</summary>')
        print(f'    <pre>{html.escape(content)}</pre>')
        print(f'  </details>')

    print('</div>')
PYEOF

# Close HTML
cat >> ATTRIBUTIONS.html << 'EOF'

</body>
</html>
EOF

echo ""
echo "✓ Attribution file generated: ATTRIBUTIONS.html"
