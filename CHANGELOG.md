# Changelog

## 0.2.0

- `databases` in `nocollide.json`: one Postgres database, SQLite file or Redis DB index per slot (#16, #17, #18, #19)
- Postgres databases are cloned from the main database, dropped on `down` and `gc`, kept with `--keep-data`
- `compose`: one `COMPOSE_PROJECT_NAME` per slot (#20)
- `init` detects database URLs and Compose files, and leaves shared service ports such as `DB_PORT` alone (#21)
- `up` hides passwords when it prints database URLs
- `ports` may be empty when `databases` or `compose` is set
- `init` now detects a plain `PORT=` line in `.env.example` (#13)
- `nocollide port` prints plain numbers when `FORCE_COLOR` is set (#10)

## 0.1.0

- First release: `init`, `up`, `down`, `ls`, `gc`, `run` and `port`
