# Compiled migration artifacts design

## Problem

`npm run build` compiles TypeScript into `dist`, but it does not copy the SQL
migrations. The compiled database module resolves its default migration
directory to `dist/migrations`, so `POSTGRES_AUTO_MIGRATE=true npm start` fails
before PostgreSQL migrations can run.

## Approved solution

The build copies the repository's versioned `migrations/*.sql` files into
`dist/migrations` after TypeScript compilation. The runtime keeps its current
module-relative lookup, making the compiled artifact self-contained and
independent of the process working directory.

The copy step:

- accepts only canonical versioned SQL names;
- sorts names deterministically;
- replaces only `dist/migrations`;
- copies bytes without transforming SQL;
- fails the build if no migration exists;
- exposes a function that can be tested with isolated temporary directories.

No listener, decoder, paper-trading, RPC, or execution behavior changes.

## Verification

- a unit test proves filtering, deterministic output and byte preservation;
- a static assertion proves `npm run build` invokes the copy step;
- `npm run build` produces `dist/migrations/001_initial.sql` through
  `010_transaction_inbox_timestamps.sql`;
- the compiled database module applies all migrations to an empty PostgreSQL
  schema and replays them without changes;
- build, check, lint and the full PostgreSQL suite remain green.

