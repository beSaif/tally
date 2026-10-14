import { applyD1Migrations, env } from 'cloudflare:test';
import { installFxStub } from './fx-stub';

// Fresh schema for every test file (isolated storage is per test, migrations are idempotent per file).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
installFxStub();
