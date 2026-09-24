# eatwise-mcp

Local-first MCP server behind **Eatwise** (外卖营养教练 / 吃出来的饮食教练) — a Chinese
dietary coach that gives transparent meal reviews and practical next-meal actions.

The server stores, **only with explicit user consent**, a basic profile and confirmed
meals in a local SQLite database on the user's own machine, and deterministically
recomputes meal nutrition from a bundled food database (Taiwan TFND entries plus USDA
FNDDS typical portions — redistributable open data only).

- 9 tools: `history_status`, `configure_local_storage`, `get_profile`,
  `update_profile`, `review_and_save_meal`, `list_meals`, `get_day_review`,
  `export_local_data`, `delete_local_data`
- Zero runtime dependencies; uses Node.js built-in `node:sqlite` (Node >= 22.5)
- No network calls, no accounts, no cloud sync, no payment flows
- Data location: `CHICHULAIDE_LOCAL_HISTORY_PATH` env var, otherwise the platform
  default (`~/Library/Application Support/Chichulaide` on macOS)

## Run

```sh
npx -y --allow-git=all --package \
  git+https://github.com/harrylabsj/eatwise-mcp#<pinned-commit> eatwise-mcp
```

(`--allow-git=all` opts out of npm 12's default block on git-type fetching.)

## Privacy

See [PRIVACY.md](PRIVACY.md). Data never leaves the device; export and deletion are
user-initiated tools. Meals are kept 180 days by default and the retention is
user-adjustable.

This engine is extracted unchanged from the
[chichulaide](https://github.com/harrylabsj/chichulaide) monorepo (`ai_backend/`),
which also powers the WorkBuddy expert 外卖营养教练.
