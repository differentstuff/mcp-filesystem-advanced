#!/bin/bash

# setup.sh - Setup script for MCP Filesystem Server
# This script installs dependencies and compiles the TypeScript code
# for production use without symlinks or global installations.

set -e  # Exit on any error

echo "Setting up MCP Filesystem Server..."
echo "==================================="

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Working directory: $SCRIPT_DIR"

# Check if we're in the right directory
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
    echo "Error: package.json not found in $SCRIPT_DIR"
    echo "Please run this script from the project root directory."
    exit 1
fi

echo "Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "Error: npm install failed"
    exit 1
fi

echo "Compiling TypeScript to JavaScript..."
npm run build

if [ $? -ne 0 ]; then
    echo "Error: TypeScript compilation failed"
    exit 1
fi

echo "Setup completed successfully!"
echo ""
echo "The MCP Filesystem Server is now ready to use."
echo "Run it with: node dist/index.js"
echo "Or make it executable and run: chmod +x dist/index.js && ./dist/index.js"
