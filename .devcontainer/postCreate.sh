#!/bin/bash
set -e

# 共通開発標準・Obsidian連携をコンテナのホームに配置
mkdir -p ~/.claude/scripts
cp .devcontainer/global-standards.md ~/.claude/CLAUDE.md
cp .devcontainer/vault_archive.py ~/.claude/scripts/vault_archive.py
cp .devcontainer/global-settings.json ~/.claude/settings.json

# Pythonの依存関係
pip install -r requirements.txt -r requirements-dev.txt

# Node.js 20 + Claude Code CLI
# ベースイメージに古いyarnリポジトリが設定済みで、GPG鍵未検証によりapt updateが失敗するため無効化してから進める
sudo mv /etc/apt/sources.list.d/yarn.list /etc/apt/sources.list.d/yarn.list.disabled 2>/dev/null || true
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
sudo npm install -g @anthropic-ai/claude-code
