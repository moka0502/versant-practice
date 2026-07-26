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

# gh CLI（既存プロジェクトenglish-quiz-botのコンテナ環境で使用していたものを踏襲）
type -p curl >/dev/null || (sudo apt-get update && sudo apt-get install -y curl)
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update
sudo apt-get install -y gh

# ffmpeg + fonts-liberation（同上。音声/動画・画像生成が絡む機能を実装する際に必要）
sudo apt-get install -y ffmpeg fonts-liberation
