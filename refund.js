import axios from "axios";
import https from "https";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase URL or Service Role Key is not set!');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { qrc_id } = req.body;
    if (!qrc_id) return res.status(400).json({ error: "qrc_id is required" });

    // ⏱ Ждём 5 секунд перед началом
    await delay(5000);

    // ⚙️ Получаем запись из purchases
    const { data: purchase, error } = await supabase
      .from("purchases")
      .select("*")
      .eq("qr_id", qrc_id)
      .single();

    if (error || !purchase) {
      console.error("❌ Покупка не найдена:", error);
      return res.status(404).json({ error: "Purchase not found" });
    }

    const { amount, commit, refund_attempts = 0, api_login, steam_login } = purchase;

    if (!process.env.CFT_PFX_BASE64 || !process.env.CFT_PFX_PASSWORD) {
      return res.status(500).json({ error: "CFT_PFX_BASE64 or password not set" });
    }

    // 🔒 Настраиваем HTTPS агент для mTLS
    const pfxBuffer = Buffer.from(process.env.CFT_PFX_BASE64, "base64");
    const httpsAgent = new https.Agent({
      pfx: pfxBuffer,
      passphrase: process.env.CFT_PFX_PASSWORD,
      rejectUnauthorized: true,
    });

    const refundUrl = process.env.CFT_REFUND_URL;
    const refId = `${qrc_id}-${Date.now()}`;

    // 📦 Формируем тело запроса
    const refundBody = {
      longWait: false,
      refId,
      internalTxId: commit || undefined,
      amount: amount * 100, // в копейках
      refType: "qrcId",
      refData: qrc_id,
      remitInfo: "Возврат по покупке",
    };

    console.log("🔁 Попытка возврата №", refund_attempts + 1, "для", qrc_id);

    const response = await axios.post(refundUrl, refundBody, {
      headers: {
        "Content-Type": "application/json",
        authsp: process.env.CFT_PROD_AUTHSP || "socium-bank.ru",
      },
      timeout: 30000,
      httpsAgent,
      validateStatus: () => true,
    });

    const { status } = response;

    if (status === 200 || status === 202) {
      console.log("✅ Возврат успешен:", response.data);

      await supabase
        .from("purchases")
        .update({ status: "refund", refund_attempts: refund_attempts + 1 })
        .eq("qr_id", qrc_id);

      // 🧠 Ищем client_id по steam_login
      let client_id = null;
      const { data: client } = await supabase
        .from("client")
        .select("id_client")
        .eq("steam_login", steam_login)
        .single();
      if (client) client_id = client.id_client;

      // 📢 Уведомление в Telegram об успешном возврате
      const successMsg = `
✅ *Возврат средств выполнен успешно!*
QR: \`${qrc_id}\`
Партнёр: \`${api_login || "N/A"}\`
Steam: \`${steam_login || "N/A"}\`
${client_id ? `ID клиента: \`${client_id}\`\n` : ""}
Commit: \`${commit || "N/A"}\`
Сумма: *${amount} ₽*
Status: ${status}
      `;

      await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: successMsg,
        parse_mode: "Markdown",
      });

      return res.status(200).json({ success: true, data: response.data });
    } else {
      console.error("⚠️ Ошибка возврата:", response.status, response.data);

      const newAttempts = refund_attempts + 1;

      if (newAttempts < 5) {
        await supabase.from("purchases").update({ refund_attempts: newAttempts }).eq("qr_id", qrc_id);
        console.log(`🔁 Повторная попытка через 5 секунд (${newAttempts}/5)`);
        await delay(5000);
        return handler(req, res);
      } else {
        await supabase
          .from("purchases")
          .update({ status: "failed_refund", refund_attempts: newAttempts })
          .eq("qr_id", qrc_id);

        let client_id = null;
        const { data: client } = await supabase
          .from("client")
          .select("id_client")
          .eq("steam_login", steam_login)
          .single();
        if (client) client_id = client.id_client;

        // 🚨 Telegram уведомление об ошибке
        const failMsg = `
🚨 *Ошибка возврата средств*
QR: \`${qrc_id}\`
Партнёр: \`${api_login || "N/A"}\`
Steam: \`${steam_login || "N/A"}\`
${client_id ? `ID клиента: \`${client_id}\`\n` : ""}
Попыток: ${newAttempts}
Status: \`${response.status}\`
Message: ${JSON.stringify(response.data)}
        `;

        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: failMsg,
          parse_mode: "Markdown",
        });

        return res.status(500).json({ error: "Refund failed after 5 attempts" });
      }
    }
  } catch (err) {
    console.error("💥 Ошибка в refund.js:", err);
    return res.status(500).json({ error: err.message });
  }
}
