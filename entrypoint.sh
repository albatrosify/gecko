#!/bin/bash
set -e

# Start MongoDB
echo "Starting MongoDB..."
mongod --bind_ip_all --fork --logpath /var/log/mongodb/mongodb.log

# Wait for MongoDB to start
echo "Waiting for MongoDB to be ready..."
# Use 'mongo' for 4.4 instead of 'mongosh'
until mongo --eval "db.adminCommand('ping')" >/dev/null 2>&1; do
  sleep 1
done

echo "MongoDB is ready."

# Execute the main application
exec "$@"
