# Variable Sync to Repo

A Figma plugin that bi-directionally syncs your Figma variables to and from a JSON file stored in a GitHub, GitLab, or Bitbucket repository. Token files follow the [W3C Design Token Community Group (DTCG)](https://design-tokens.github.io/community-group/format/) specification.

---

## Features

- **Push** — choose which variable collections to export; each becomes a JSON file in your repo
- **Pull with diff** — a single table shows every file with variable count, mode count, and a live diff (added / updated / removed) before anything is applied
- **Selective sync** — check or uncheck individual files on both push and pull
- **Variable groups** — Figma group separators (`/`) round-trip correctly as nested JSON objects
- **Multi-mode support** — Light/Dark (and any other modes) are preserved in the token files
- **Variable aliases** — same-collection and cross-collection aliases, including chains (A → B → C), round-trip correctly
- **Automatic version snapshot** — before every pull the plugin saves a named version in Figma so you can revert if needed
- **Operation history** — view past push/pull operations and revert any pull to its pre-apply state
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

Find **Variable Sync to Repo** in the [Figma Community]([https://www.figma.com/community](https://www.figma.com/community/plugin/1634946014443748648)) and click **Install**.

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

Opens a table of all variable collections in the current file. Check or uncheck collections, then click **Push collections** to write each selected collection to its own JSON file in your tokens directory. Existing files are updated in place.

### Pull (repo → Figma)

Opens a table of all JSON files in your tokens directory. For each file you can see the variable count, mode count, and a live diff against your current Figma variables (additions in green, updates in amber, removals in red). Select which files to apply, then click **Update local variables**. The plugin automatically saves a named version in Figma before making any changes — expand any entry in History and click **Revert** to roll back.

---

## Want to run this locally?

Some teams prefer to fork and run their own build — for example to customise the token format or add a private provider.

```bash
git clone https://github.com/louriach/Figma-Github-token-sync.git
cd Figma-Github-token-sync
npm install
npm run build        # one-off build → dist/
npm run watch        # rebuild on save
```

Then in Figma: **Plugins → Development → Import plugin from manifest** and select `manifest.json`.

### Project structure

```
src/
  code.ts        # Figma plugin thread — reads/writes variables, clientStorage
  ui.tsx         # React UI
  ui.html        # HTML shell + styles
  types.ts       # Shared types
  lib/
    provider.ts  # GitProvider interface
    github.ts    # GitHub implementation
    gitlab.ts    # GitLab implementation
    bitbucket.ts # Bitbucket implementation
    tokens.ts    # Figma ↔ W3C DTCG conversion + diff
examples/
  01-single-collection/
  02-two-collections/
  03-three-collections/
```

---

## Example files

The [`examples/`](https://github.com/louriach/Figma-Github-token-sync/tree/main/examples) folder contains ready-to-use token files covering the main alias scenarios:

| Folder | Collections | Tests |
|--------|-------------|-------|
| [`01-single-collection/`](https://github.com/louriach/Figma-Variable-Sync-to-Repo/tree/main/examples/01-single-collection/tokens) | `primitives` | Basic push/pull, no modes, no aliases |
| [`02-two-collections/`](https://github.com/louriach/Figma-Variable-Sync-to-Repo/tree/main/examples/02-two-collections/tokens) | `primitives` + `color` (Light/Dark) | Cross-collection aliases, multi-mode |
| [`03-three-collections/`](https://github.com/louriach/Figma-Variable-Sync-to-Repo/tree/main/examples/03-three-collections/tokens) | `primitives` + `color` (Light/Dark) + `spacing` (Compact/Default/Comfortable) + `typography` (Mobile/Tablet/Desktop) | Parallel fan-out, realistic mode structures |

To test: commit a `tokens/` folder to your repo, point the plugin at that path, and pull.

---

## License

MIT
