import express from "express";
import bodyParser from "body-parser";
import orderRoute from "./order.js";

const app = express();
app.use(bodyParser.json());

// Основной роут для заказов (HTTPS)
app.use("/api/order", orderRoute);

// HTTPS-сервер
const PORT = process.env.PORT || 443;
app.listen(PORT, () => {
  console.log(`✅ Main HTTPS server running on port ${PORT}`);
});
