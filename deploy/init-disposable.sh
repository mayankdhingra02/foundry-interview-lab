#!/bin/sh
set -eu
for migration in /foundry-migrations/*.sql; do
  psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 --file "$migration"
done
