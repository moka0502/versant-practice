# versant-practice（Claude向けプロジェクトガイド）

Versant練習問題を出題するアプリ。まずはWebアプリ(スマホブラウザ利用)として作り、動いたらiPhoneアプリ化(PWA→必要ならネイティブ)を検討する。
開発標準・テスト標準は全プロジェクト共通標準（~/.claude/CLAUDE.md）に従う。ここには本プロジェクト固有の情報のみを書く。

## 現在のスコープ

- VersantB「Repeating(リピーティング)」セクションに特化した問題演習機能のみ
- 他セクション(Sentence Builds, Story Retelling等)は将来の拡張候補。今は実装しない

## 技術方針

- バックエンド: Python
- 実行環境: Dockerコンテナ(このフォルダ自体をバインドマウント。コンテナを消してもコードはWindows側に残る)
- フロントエンド・DB構成は未確定。**実装着手前に必ずPlanモードで方針を決める**（ユーザーとの合意事項）

## 参考資料（既存アセット）

英語BOT(`english-quiz-bot`、Dockerコンテナ`magical_brattain`内`/home/node/english-quiz-bot`、`docker exec magical_brattain ...`でアクセス可)に、**現在停止中のVERSANT練習BOT機能**が存在する。設計時の参考にする（そのまま移植ではなく、要件のインプットとして扱う方針。ユーザー:「ほぼ一から作るかも」）。

- 仕様書: `docs/specs/versant.md`（公式VERSANT仕様準拠のPart A/B定義、CSVスキーマ、生成仕様）
- 問題バンク: `versant/versant_quizzes.csv`（48問。Part B=Repeatが未投稿分だけで10問以上あり、`script`のフレーズ区切り（例: `[If you need] [any help]...`）が既に付与されている＝リピーティング練習に転用しやすい形）
- 生成ロジック: `versant/versantquiz.py`（GPTプロンプト）、`versant/versant_generate.py`（週次生成）
- 投稿・動画・TTS周りの`versantrunner.py`やpart2共用モジュールはX投稿bot専用の実装なので、本アプリには不要（参考にしない）

## 開発環境の状態（2026-07-26セットアップ完了）

- devcontainer構築済み・動作確認済み（コンテナ名は再作成のたびに変わる。当時は`sharp_kalam`）
- `postCreate.sh`で自動セットアップされるもの: 共通標準CLAUDE.md配置、Obsidian daily-notes自動アーカイブ(SessionEndフック)、Node.js20+Claude Code CLI、gh/ffmpeg/fonts-liberation
- gh CLIはコンテナ内では**未認証**。GitHub操作が必要になったタイミングで`gh auth login`が要る
- Obsidian自動アーカイブは仕組みとして組み込み済みだが、**実際にセッション終了時にファイルが書き出されるかは未検証**（SessionEndフックの発火自体をまだ確認していない）

## バックログ

- Obsidian自動アーカイブフックの実地動作確認（未検証、上記参照）
- 実データ投入待ち: `versant/versant_quizzes.csv`を`magical_brattain`コンテナから取り出し、`versant_practice/csv_import.py`の暫定スキーマ（`id`+`script`列）を実カラム名に合わせて確定させる
- TTS生成待ち: OpenAI APIキーが未設定。`docs/decisions.md`のTTSスパイク（2〜3件で音質確認）はキー入手後に着手
- ホスティング先の決定待ち（GitHub Pages案あり、リポジトリ公開可否の判断が必要）
- PWAの正式アイコン画像（現状`prototype/icon.svg`は仮）、Service Workerの実機動作確認が未実施
- 詳細は`docs/decisions.md`の「未決定・要検証」を参照
