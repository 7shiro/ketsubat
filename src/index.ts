import { Client } from 'pg';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  KETSUBAT_IMAGES: R2Bucket;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  USER_ID: string;
  GEMINI_API_KEY: string;
  DONATION_URL?: string;
}

interface GeminiInspectionResult {
  type: 'MANUSCRIPT' | 'PENALTY_PROOF' | 'INVALID';
  is_valid: boolean;
  stage_or_amount?: string;
  reason: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') return new Response('OK', { status: 200 });

    const signature = request.headers.get('x-line-signature');
    if (!signature) return new Response('Unauthorized', { status: 401 });

    const bodyText = await request.text();
    const isValid = await verifySignature(bodyText, signature, env.LINE_CHANNEL_SECRET);
    if (!isValid) return new Response('Invalid Signature', { status: 403 });

    ctx.waitUntil(handleLineWebhook(bodyText, env));
    return new Response('OK', { status: 200 });
  },

  // -------------------------------------------------------------
  // 2. Cron Trigger (毎夜20:00 締め切り監視＆ペナルティ判定＋次回タスク自動作成)
  // -------------------------------------------------------------
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
    await client.connect();

    // 締め切り時刻を過ぎたタスクを取得（COMPLETED / PENDING どちらも取得）
    const expiredTasks = await client.query(
      `SELECT id, task_name, required_count, is_recurring, interval_days, deadline, status 
       FROM tasks 
       WHERE deadline <= NOW()`
    );

    for (const task of expiredTasks.rows) {
      // まだ PENDING のタスクのみ勝敗判定を行う
      if (task.status === 'PENDING') {
        const subRes = await client.query(
          `SELECT COUNT(*) FROM submissions WHERE task_id = $1 AND submission_type = 'MANUSCRIPT'`,
          [task.id]
        );
        const submittedCount = parseInt(subRes.rows[0].count, 10);

        if (submittedCount >= task.required_count) {
          await client.query(`UPDATE tasks SET status = 'COMPLETED' WHERE id = $1`, [task.id]);
          await pushLine(
            env.USER_ID, 
            `🎉 【締め切り達成】\nタスク「${task.task_name}」をクリアしました！（提出: ${submittedCount}/${task.required_count}枚）`, 
            env.LINE_CHANNEL_ACCESS_TOKEN
          );
        } else {
          await client.query(`UPDATE tasks SET status = 'FAILED' WHERE id = $1`, [task.id]);
          
          const donationUrl = env.DONATION_URL || 'https://donation.yahoo.co.jp/';
          const penaltyMsg = 
            `🚨 【締め切り未達成・ペナルティ発生】\n` +
            `タスク「${task.task_name}」を落としました（提出: ${submittedCount}/${task.required_count}枚）。\n\n` +
            `💸 【反省のターン】\n` +
            `以下のリンクからPayPayで【1,000円】の寄付を行い、自分の手で敗北を噛み締めてください。\n\n` +
            `👉 Yahoo!ネット募金 (PayPay対応):\n${donationUrl}\n\n` +
            `⚠️ 寄付完了画面のスクショをこのLINEに送信すると、AIが確認してペナルティ解除となります。`;

          await pushLine(env.USER_ID, penaltyMsg, env.LINE_CHANNEL_ACCESS_TOKEN);
        }
      }

      // 🔁 繰り返しタスクの場合は次回タスクを生成（アクティブなタスクがまだ存在しない場合のみ作成）
      if (task.is_recurring) {
        const activeCheck = await client.query(
          `SELECT id FROM tasks WHERE task_name = $1 AND status = 'PENDING' AND deadline > NOW()`,
          [task.task_name]
        );

        if (activeCheck.rows.length === 0) {
          const intervalDays = task.interval_days || 1;
          await client.query(
            `INSERT INTO tasks (task_name, required_count, deadline, status, is_recurring, interval_days)
             VALUES ($1, $2, (CURRENT_DATE + INTERVAL '1 day' * $3 + TIME '20:00:00'), 'PENDING', TRUE, $3)`,
            [task.task_name, task.required_count, intervalDays]
          );

          await pushLine(
            env.USER_ID,
            `🔄 【次回タスクを自動作成しました】\nタスク「${task.task_name}」（${intervalDays}日周期）の次回締め切りを設定しました。`,
            env.LINE_CHANNEL_ACCESS_TOKEN
          );
        }
      }
    }

    await client.end();
  }
};

async function handleLineWebhook(bodyText: string, env: Env) {
  try {
    const body: any = JSON.parse(bodyText);
    const events = body.events || [];

    for (const event of events) {
      const userId = event.source?.userId || env.USER_ID;

      // ---------------------------------------------------------
      // A. テキストメッセージ受信
      // ---------------------------------------------------------
      if (event.type === 'message' && event.message.type === 'text') {
        const text: string = event.message.text.trim();
        const replyToken = event.replyToken;

        // A-1. タスク提出ターゲットの選択命令（例: 「提出 クロッキー」）
        if (text.startsWith('提出')) {
          const keyword = text.replace(/^提出\s*/, '').trim();

          const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
          await client.connect();

          const targetTaskRes = await client.query(
            `SELECT id, task_name FROM tasks 
             WHERE status = 'PENDING' AND deadline > NOW() AND task_name LIKE $1 
             ORDER BY deadline ASC LIMIT 1`,
            [`%${keyword}%`]
          );

          if (targetTaskRes.rows.length === 0) {
            await replyLine(
              replyToken,
              `⚠️ 「${keyword}」に該当する進行中のタスクが見つかりませんでした。`,
              env.LINE_CHANNEL_ACCESS_TOKEN
            );
            await client.end();
            continue;
          }

          const targetTask = targetTaskRes.rows[0];

          await client.query(
            `INSERT INTO user_states (user_id, selected_task_id, updated_at) 
             VALUES ($1, $2, NOW()) 
             ON CONFLICT (user_id) DO UPDATE SET selected_task_id = $2, updated_at = NOW()`,
            [userId, targetTask.id]
          );

          await client.end();

          await replyLine(
            replyToken,
            `🎯 提出先を「${targetTask.task_name}」にセットしました！\n画像を送信してください。`,
            env.LINE_CHANNEL_ACCESS_TOKEN
          );
          continue;
        }

        // A-2. 「タスク一覧」の表示要求
        if (text === 'タスク一覧' || text === 'タスクリスト') {
          const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
          await client.connect();

          const tasksRes = await client.query(
            `SELECT t.id, t.task_name, t.required_count, t.deadline, t.is_recurring, t.interval_days,
                    COUNT(s.id) AS submitted_count
             FROM tasks t
             LEFT JOIN submissions s ON t.id = s.task_id AND s.submission_type = 'MANUSCRIPT'
             WHERE t.status = 'PENDING'
             GROUP BY t.id
             ORDER BY t.deadline ASC`
          );

          await client.end();

          if (tasksRes.rows.length === 0) {
            await replyLine(
              replyToken,
              `📋 【進行中のタスク】\n──────────\n現在進行中のタスクはありません。`,
              env.LINE_CHANNEL_ACCESS_TOKEN
            );
            continue;
          }

          let msg = `📋 【進行中のタスク一覧】\n──────────\n`;
          for (const task of tasksRes.rows) {
            const deadlineStr = new Date(task.deadline).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
            const repeatStr = task.is_recurring ? `（${task.interval_days}日ごと繰返）` : '';
            msg += `・${task.task_name}${repeatStr}\n  進捗：${task.submitted_count}/${task.required_count}枚\n  締切：${deadlineStr}\n\n`;
          }

          await replyLine(replyToken, msg.trim(), env.LINE_CHANNEL_ACCESS_TOKEN);
          continue;
        }

        // A-3. 「タスク登録」処理
        const match = text.match(/^タスク登録\s+(.+)\s+(\d+)枚\s+(\d+)日後(?:\s+(?:(毎日)|(\d+)日)(?:繰り返し|ごと))?$/);

        if (match) {
          const taskName = match[1];
          const requiredCount = parseInt(match[2], 10);
          const firstDays = parseInt(match[3], 10);
          
          const isDaily = !!match[4];
          const customDays = match[5] ? parseInt(match[5], 10) : null;
          
          const intervalDays = isDaily ? 1 : customDays;
          const isRecurring = intervalDays !== null;

          const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
          await client.connect();

          const result = await client.query(
            `INSERT INTO tasks (task_name, required_count, deadline, status, is_recurring, interval_days)
             VALUES ($1, $2, (CURRENT_DATE + INTERVAL '1 day' * $3 + TIME '20:00:00'), 'PENDING', $4, $5)
             RETURNING id, deadline`,
            [taskName, requiredCount, firstDays, isRecurring, intervalDays || 1]
          );

          const newTask = result.rows[0];
          const deadlineStr = new Date(newTask.deadline).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
          await client.end();

          const recurringText = isRecurring ? `\n繰り返し：${intervalDays}日ごと` : '\n繰り返し：なし';

          await replyLine(
            replyToken,
            `📝 【タスク新規登録】\n──────────\nタスク名：${taskName}\n目標枚数：${requiredCount}枚\n初回締切：${deadlineStr}${recurringText}`,
            env.LINE_CHANNEL_ACCESS_TOKEN
          );
        } else if (text.startsWith('タスク登録')) {
          await replyLine(
            replyToken,
            `⚠️ フォーマットが違います\n以下の形式で送信してください：\n\n【単発】\nタスク登録 [名前] [枚数]枚 [日数]日後\n\n【繰り返し】\nタスク登録 [名前] [枚数]枚 [初回日数]日後 毎日繰り返し\nタスク登録 [名前] [枚数]枚 [初回日数]日後 7日ごと`,
            env.LINE_CHANNEL_ACCESS_TOKEN
          );
        }
      }

      // ---------------------------------------------------------
      // B. 画像メッセージ受信
      // ---------------------------------------------------------
      if (event.type === 'message' && event.message.type === 'image') {
        const messageId = event.message.id;
        const replyToken = event.replyToken;

        const imgRes = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
          headers: { 'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }
        });
        const imgBuffer = await imgRes.arrayBuffer();

        const aiResult = await inspectImageWithGemini(imgBuffer, 'image/jpeg', env.GEMINI_API_KEY);

        const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
        await client.connect();

        if (!aiResult.is_valid || aiResult.type === 'INVALID') {
          await replyLine(
            replyToken, 
            `❌ 【審査不合格】\n原稿または寄付完了画面として確認できませんでした。\n\n理由：${aiResult.reason}`, 
            env.LINE_CHANNEL_ACCESS_TOKEN
          );
          await client.end();
          continue;
        }

        if (aiResult.type === 'PENALTY_PROOF') {
          const failedTaskRes = await client.query(
            `SELECT id, task_name FROM tasks WHERE status = 'FAILED' ORDER BY deadline DESC LIMIT 1`
          );

          if (failedTaskRes.rows.length > 0) {
            const failedTask = failedTaskRes.rows[0];
            await client.query(`UPDATE tasks SET status = 'PENALTY_PAID' WHERE id = $1`, [failedTask.id]);
            
            await replyLine(
              replyToken, 
              `💸 【反省を受理しました】\nタスク「${failedTask.task_name}」に対する寄付（${aiResult.stage_or_amount}）を確認しました。\n判定理由：${aiResult.reason}\n\n次は原稿で成果を出しましょう！`, 
              env.LINE_CHANNEL_ACCESS_TOKEN
            );
          } else {
            await replyLine(
              replyToken, 
              `ℹ️ 寄付スクショを受領しましたが、現在処理待ちのペナルティはありません。`, 
              env.LINE_CHANNEL_ACCESS_TOKEN
            );
          }

          await client.end();
          continue;
        }

        let currentTask: { id: number; task_name: string; required_count: number } | null = null;

        const stateRes = await client.query(
          `SELECT t.id, t.task_name, t.required_count FROM user_states us
           JOIN tasks t ON us.selected_task_id = t.id
           WHERE us.user_id = $1 AND t.status = 'PENDING' AND t.deadline > NOW()`,
          [userId]
        );

        if (stateRes.rows.length > 0) {
          currentTask = stateRes.rows[0];
        } else {
          const taskRes = await client.query(
            `SELECT id, task_name, required_count FROM tasks WHERE status = 'PENDING' AND deadline > NOW() ORDER BY deadline ASC LIMIT 1`
          );
          if (taskRes.rows.length > 0) {
            currentTask = taskRes.rows[0];
          }
        }

        if (!currentTask) {
          await replyLine(
            replyToken, 
            `⚠️ 現在進行中のアクティブなタスクが見つかりません。`, 
            env.LINE_CHANNEL_ACCESS_TOKEN
          );
          await client.end();
          continue;
        }

        const r2Key = `tasks/${currentTask.id}/${Date.now()}.jpg`;
        await env.KETSUBAT_IMAGES.put(r2Key, imgBuffer, { httpMetadata: { contentType: 'image/jpeg' } });

        await client.query(
          `INSERT INTO submissions (task_id, r2_key, submission_type, stage) VALUES ($1, $2, 'MANUSCRIPT', $3)`,
          [currentTask.id, r2Key, aiResult.stage_or_amount]
        );

        const countRes = await client.query(
          `SELECT COUNT(*) FROM submissions WHERE task_id = $1 AND submission_type = 'MANUSCRIPT'`,
          [currentTask.id]
        );
        const currentCount = parseInt(countRes.rows[0].count, 10);

        let isClearedMsg = '';
        if (currentCount >= currentTask.required_count) {
          await client.query(`UPDATE tasks SET status = 'COMPLETED' WHERE id = $1`, [currentTask.id]);
          isClearedMsg = `\n🎉 目標枚数を達成しました！`;
        }

        await client.end();

        await replyLine(
          replyToken, 
          `✅ 【原稿審査合格 (${aiResult.stage_or_amount})】\n──────────\n対象タスク：${currentTask.task_name}\n提出数：${currentCount}/${currentTask.required_count}枚${isClearedMsg}\n判定理由：${aiResult.reason}`, 
          env.LINE_CHANNEL_ACCESS_TOKEN
        );
      }
    }
  } catch (err) {
    console.error("Webhook Background Processing Error:", err);
  }
}

async function verifySignature(body: string, signature: string, channelSecret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const digest = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return digest === signature;
}

async function inspectImageWithGemini(buffer: ArrayBuffer, mimeType: string, apiKey: string): Promise<GeminiInspectionResult> {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
  
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  const base64Data = btoa(binary);

  const prompt = `
あなたはマンガ制作や作画練習の提出成果物をチェックする監査役です。送られた画像を分析し、以下の基準で厳格に判定してください。

【合格判定の基準】
以下のいずれかに該当する場合は、無条件で合格 (MANUSCRIPT) としてください：
・マンガ原稿（ネーム、下描き、ペン入れ、仕上げ、コマ割りされたページ）
・作画練習・画力向上目的の制作物（クロッキー、人物のポーズ練習、スケッチ、デッサン、キャラクターデザイン、作画の練習描画）
・クリスタ等の制作ソフトにおける「ページ一覧画面」「サムネイル一覧画面」（複数ページが並んでいるスクリーンショット）
・デジタル・アナログ（紙の手書き写真）を問わず、絵や線画が描かれているもの

【不合格判定の基準 (INVALID)】
以下の場合のみ不合格としてください：
・完全な白紙、真っ黒な画像、内容が何も描かれていないもの
・実写の風景、食べ物、ペットなど、イラスト・絵・練習物と一切関係ない写真
・意味をなさない適当な落書き（数秒で描いたような線が数本あるだけなど）

【判定分類】
1. MANUSCRIPT: 上記の合格基準を満たす原稿・作画練習物・クロッキー・スケッチ等。
2. PENALTY_PROOF: PayPayやYahoo!ネット募金などの決済・寄付完了画面（1,000円以上）。
3. INVALID: 不正・無関係な画像。

【出力フォーマット】
必ず以下のJSON形式のみで回答してください：
{
  "type": "MANUSCRIPT" | "PENALTY_PROOF" | "INVALID",
  "is_valid": true または false,
  "stage_or_amount": "クロッキー" | "ポーズ練習" | "ネーム" | "ペン入れ" | "1000円寄付確認" など簡潔なテキスト,
  "reason": "判定理由（1〜2文）"
}
`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Data } }] }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });

    const data: any = await res.json();

    if (!res.ok || !data.candidates || !data.candidates[0]) {
      return {
        type: 'INVALID',
        is_valid: false,
        reason: `Gemini API連携エラー (${res.status}): 画像の解析に失敗しました。`
      };
    }

    return JSON.parse(data.candidates[0].content.parts[0].text) as GeminiInspectionResult;
  } catch (err: any) {
    return {
      type: 'INVALID',
      is_valid: false,
      reason: "画像解析処理中に例外エラーが発生しました。"
    };
  }
}

async function replyLine(replyToken: string, text: string, token: string) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
}

async function pushLine(userId: string, text: string, token: string) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] })
  });
}