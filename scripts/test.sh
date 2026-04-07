#!/bin/bash
set -e

# Oblivinx3x Test Script
echo "Running Oblivinx3x Test Suite..."

cd "$(dirname "$0")/.."

# 1. Ensure the module is compiled and ready
if [ ! -f "packages/oblivinx3x/native/index.node" ]; then
    echo "Native module not found! Running build.sh first..."
    ./scripts/build.sh
fi

# 2. Run the unit and integration tests using node:test
echo "Running Javascript Integration Tests via native Node test runner..."
node --test tests/integration/**/*.test.js tests/unit/**/*.test.js

echo "All tests passed successfully!"
