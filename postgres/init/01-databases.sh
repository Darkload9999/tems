#!/bin/sh
# Creates one database + owner per service. Runs once, on an empty data volume.
set -eu

psql -v ON_ERROR_STOP=1 --username postgres <<SQL
CREATE USER keycloak WITH PASSWORD '${KC_DB_PASSWORD}';
CREATE DATABASE keycloak OWNER keycloak;
CREATE USER tems WITH PASSWORD '${TEMS_DB_PASSWORD}';
CREATE DATABASE tems OWNER tems;
SQL
