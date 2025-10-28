import express from "express";
import bodyParser from "body-parser";
import orderRoute from "./order.js";
import webhookRoute from "./webhook.js";
import refundRoute from "./refund.js";

const app = express();
app.use(bodyParser.json());

// 📦 Роуты
app.use("/api/order", orderRoute);
app.use("/api/webhook", webhookRoute);
app.use("/api/refund", refundRoute)

// 🟢 Старт сервера
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Second server running on port ${PORT}`));
