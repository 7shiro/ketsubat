# 📇 締め切り遵守システム ケツバット

LINEを通じて漫画の原稿制作や作画練習（クロッキー・デッサン等）の進捗を自動管理し、締め切り遵守と習慣化をサポートするセルフペナルティ型タスク管理システムです。

Cloudflare Workers、R2ストレージ、Gemini API (3.6-flash) によるサーバーレスなエッジ実行環境と、VPS上のPostgreSQL（Hyperdrive経由で高速接続）を組み合わせたハイブリッド構成で動作します。

---

## 🌟 主な機能

1. **LINEからのタスク登録・進捗確認**
   - 単発タスクおよび繰り返しタスク（毎日／指定日数ごと）の登録に対応。
   - `タスク一覧` と送信することで、現在進行中のタスク・目標枚数・締め切り日時を一覧表示。

2. **Gemini API による画像自動審査**
   - LINEに送られた画像が成果物（原稿、ネーム、下描き、ペン入れ、クロッキー、デッサン、CLIP STUDIO等のページ一覧サムネイル画面）であるかを自動判定。
   - 合格した画像のみをCloudflare R2へ自動保存し、目標枚数へのカウントを実行。

3. **タスク特定（`提出 [キーワード]`）機能**
   - 複数タスクを並行している場合、`提出 クロッキー` のように送信することで提出先タスクを指定可能（`LIKE` 部分一致検索対応）。

4. **締め切り監視＆反省（ペナルティ）機能 (Cron Trigger)**
   - 毎夜 **20:00 JST** に自動で判定処理が実行。
   - 目標枚数未達成の場合、タスクが `FAILED` となり、**1,000円の寄付命令（Yahoo!ネット募金 / PayPay）** がLINEに通知される。
   - 寄付完了画面（スクショ）を送信することで、AIが確認してペナルティ解除（`PENALTY_PAID`）を処理。
   - 繰り返しタスクの場合、次回締め切りのタスクを自動生成。

---

## 🛠 システム構成・技術スタック

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) (TypeScript)
- **Database**: PostgreSQL / [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
- **Object Storage**: [Cloudflare R2](https://developers.cloudflare.com/r2/) (`KETSUBAT_IMAGES`)
- **AI Vision Model**: Google Gemini API (`gemini-3.6-flash`)
- **Messaging**: LINE Messaging API (Webhook / Reply / Push)
- **Scheduled Task**: Cloudflare Cron Triggers (`0 11 * * *` = JST 20:00)

---

## 🗄 データベース構成 (PostgreSQL)

```sql
-- タスク管理テーブル
CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  task_name VARCHAR(255) NOT NULL,
  required_count INT NOT NULL,
  deadline TIMESTAMP WITH TIME ZONE NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING', -- PENDING / COMPLETED / FAILED / PENALTY_PAID
  is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
  interval_days INT DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 提出物管理テーブル
CREATE TABLE submissions (
  id SERIAL PRIMARY KEY,
  task_id INT REFERENCES tasks(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  submission_type VARCHAR(50) NOT NULL DEFAULT 'MANUSCRIPT', -- MANUSCRIPT / PENALTY_PROOF
  stage VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ユーザーセッション（提出先ロック）管理テーブル
CREATE TABLE user_states (
  user_id VARCHAR(255) PRIMARY KEY,
  selected_task_id INT REFERENCES tasks(id) ON DELETE SET NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);