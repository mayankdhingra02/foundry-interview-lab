# Local and staged deployment recipe

Local product development uses `npm run dev` and the development file store; follow `docs/development.md`. The disposable PostgreSQL profile is a migration/test environment with an auth-shaped SQL stub, not a login service:

```sh
docker compose -f deploy/compose.yml --profile qualification up -d
docker compose -f deploy/compose.yml --profile qualification down
```

Provision `postgres:16-alpine` deliberately before using that profile. Data is ephemeral, bound only to localhost, and discarded when its container is recreated. Do not use it for learner history. The automated qualification CLI creates its own random-port disposable container; it does not use this Compose database or `DATABASE_URL`.

For a staff/staging deployment, provision a real Supabase identity/database, apply every reviewed migration, configure a privileged server connection, and create an untracked `.env.production` from `.env.example`. `AUTH_MODE=local` never enables local identity in production. Supply matching public Supabase configuration to the image build; `NEXT_PUBLIC_*` values are build-time browser configuration and the anon key is public, never the service-role secret. Keep model, database, voice and billing credentials in deployment secrets. Keep optional paid/voice features disabled until qualified.

```sh
docker compose --env-file .env.production -f deploy/compose.yml --profile app build
docker compose --env-file .env.production -f deploy/compose.yml --profile app up -d
```

The web port binds localhost. Add a reviewed TLS reverse proxy, trusted network rules and account configuration before allowing external traffic. No public deployment was performed for this recipe. The trusted worker's Docker socket has administrative host authority; use a dedicated execution host, a properly permissioned socket/group, and a restricted deployment identity. The web container gets no Docker socket. Learner containers receive no host mounts, network, or product secrets. Managed remote execution remains unavailable until its cancellation and integrity contract is qualified.

On Linux set `FOUNDRY_DOCKER_GID` to the socket group ID. On Docker Desktop configure `FOUNDRY_DOCKER_SOCKET` to the actual enabled socket path. Docker daemon and approved Python image must already be available to that socket. Check `/api/health` for process liveness and `/api/health/readiness` for storage/schema/worker/runtime readiness. See `docs/operations.md` for migration qualification, reconciliation, backup/restore, thresholds, rollback, and open release work.
