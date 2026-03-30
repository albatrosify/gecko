#!/bin/bash
set -e

# Clean up any stale lock files
rm -f /data/db/mongod.lock

# Ensure correct permissions (in case of volume mounts)
chown -R node:node /data/db /var/log/mongodb

# Start MongoDB
echo "Starting MongoDB..."
if ! mongod --bind_ip_all --fork --logpath /var/log/mongodb/mongodb.log; then
  echo "MongoDB failed to start. Log output:"
  cat /var/log/mongodb/mongodb.log
  exit 1
fi

# Wait for MongoDB to start
echo "Waiting for MongoDB to be ready..."
# Use 'mongo' for 4.4 instead of 'mongosh'
until mongo --eval "db.adminCommand('ping')" >/dev/null 2>&1; do
  sleep 1
done

echo "MongoDB is ready."

# Execute the main application
exec "$@"
