# Figma GitHub Token Sync

A Figma plugin that bi-directionally syncs your Figma variables to and from a JSON file stored in a GitHub, GitLab, or Bitbucket repository. Token files follow the [W3C Design Token Community Group (DTCG)](https://design-tokens.github.io/community-group/format/) specification.

---

## Features

- **Push** — export all Figma variable collections to your repo as W3C-compliant JSON
- **Pull with diff** — see exactly what changed (added / updated / removed) before anything is applied
- **Multi-mode support** — Light/Dark (and any other modes) are preserved in the token files
- **Variable aliases** — same-collection and cross-collection aliases, including chains (A → B → C), round-trip correctly
- **Auto repo/branch picker** — connect once to browse repos and branches without typing
- **Branch creation** — if the target branch doesn't exist, the plugin creates it from your default branch on first push
- **Secure** — your PAT is stored only in Figma's local `clientStorage`, never transmitted anywhere except the provider API over HTTPS
- **GitHub, GitLab, Bitbucket** — switch providers with a single setting change

---

## Token file format

One JSON file is written per Figma variable collection, placed in the configured tokens directory (default: `tokens/`).

### Single-mode collection

```json
{
  "spacing": {
    "4": { "$value": 16, "$type": "number", "$description": "16px" },
    "8": { "$value": 32, "$type": "number" }
  }
}
```

### Multi-mode collection (e.g. Light / Dark)

```json
{
  "$metadata": {
    "collection": "Colors",
    "modes": ["Light", "Dark"]
  },
  "Light": {
    "brand": {
      "primary": { "$value": "#0066CC", "$type": "color" }
    }
  },
  "Dark": {
    "brand": {
      "primary": { "$value": "#3B82F6", "$type": "color" }
    }
  }
}
```

### Variable aliases

Aliases between variables are stored as W3C references:

```json
{
  "semantic": {
    "background": { "$value": "{neutral.0}", "$type": "color" }
  }
}
```

### Supported token types

| Figma type | W3C `$type` |
|---|---|
| `COLOR` | `color` |
| `FLOAT` | `number` |
| `STRING` | `string` |
| `BOOLEAN` | `boolean` |

---

## Getting started

### 1. Install the plugin

1. Clone or download this repository
2. Run `npm install && npm run build` to generate the `dist/` files
3. In Figma, go to **Plugins → Development → Import plugin from manifest**
4. Select the `manifest.json` file

### 2. Create a personal access token

**GitHub:**
1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) → **Generate new token (classic)**
2. Give it a name (e.g. "Figma Token Sync") and select the `repo` scope
3. Click **Generate token** and copy it

**GitLab:**
1. Go to [gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens)
2. Create a token with the `api` scope
3. Copy it

**Bitbucket:**
1. Go to **Bitbucket Settings → App passwords → Create app password**
2. Enable **Repositories: Read** and **Repositories: Write**
3. Enter as `username:app_password` in the plugin

### 3. Connect and configure

On first open, the plugin shows the onboarding screen:

1. Select your provider (GitHub, GitLab, or Bitbucket)
2. Paste your personal access token and click **Connect**
3. Select your repository from the dropdown
4. Pick or type a branch name (it will be created from your default branch on first push)
5. Set the tokens path (default: `tokens/`)
6. Click **Start syncing** — the plugin switches to the Sync tab

Settings are saved locally in Figma. You won't need to sign in again.

---

## Usage

### Push (Figma → repo)

Exports every variable collection in the current Figma file as a separate JSON file in your tokens directory. Existing files are updated in place (no duplicate commits).

### Pull (repo → Figma)

Downloads all JSON files from your tokens directory and shows a diff — added, updated, and removed token counts per file — before applying anything. Confirm to proceed, or cancel to leave Figma untouched.

> **Tip:** save a named version in Figma (Menu → Save to version history) before applying a pull as a restore point.

---

## Development

```bash
npm install

# one-off build
npm run build

# watch mode (rebuilds on save)
npm run watch
```

Output goes to `dist/`. The plugin `manifest.json` points to `dist/code.js` and `dist/ui.html`.

### Project structure

```
src/
  code.ts          # Figma plugin main thread — reads/writes variables, clientStorage
  ui.tsx           # React UI — settings, sync, logging
  ui.html          # HTML shell + styles
  types.ts         # Shared types (W3C tokens, messages, settings)
  lib/
    provider.ts    # GitProvider interface
    github.ts      # GitHub REST API implementation
    gitlab.ts      # GitLab REST API implementation
    bitbucket.ts   # Bitbucket REST API implementation
    tokens.ts      # Figma ↔ W3C DTCG conversion, diff logic
examples/
  01-single-collection/   # Raw primitives, no aliases
  02-two-collections/     # Primitives + semantic (one alias level)
  03-three-collections/   # Primitives + semantic-color + semantic-size + components (two levels, parallel fan-out)
```

---

## Example files

The [`examples/`](https://github.com/louriach/Figma-Github-token-sync/tree/main/examples) folder contains ready-to-use token files covering the main alias scenarios:

| Folder | Collections | Tests |
|--------|-------------|-------|
| [`01-single-collection/`](https://github.com/louriach/Figma-Github-token-sync/tree/main/examples/01-single-collection/tokens) | `primitives` | Basic push/pull, no aliases |
| [`02-two-collections/`](https://github.com/louriach/Figma-Github-token-sync/tree/main/examples/02-two-collections/tokens) | `primitives` + `semantic` | Cross-collection aliases, one level deep |
| [`03-three-collections/`](https://github.com/louriach/Figma-Github-token-sync/tree/main/examples/03-three-collections/tokens) | `primitives` + `semantic-color` + `semantic-size` + `components` | Parallel fan-out + two-level alias chain |

To test: commit a `tokens/` folder to your repo, point the plugin at that path, and pull.

---

## Roadmap

- [ ] Selective collection sync (choose which files to pull)
- [ ] GitLab OAuth (Device Authorization Grant)
- [ ] VS Code extension using the same token format

---

## License

MIT
