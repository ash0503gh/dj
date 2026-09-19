#!/usr/bin/env bash
set -e

# Upgrade pip and install all dependencies
pip install --upgrade pip
pip install -r requirements.txt

# Ensure required runtime directories exist
mkdir -p outputs stems uploads
