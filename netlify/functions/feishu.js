const crypto = require("node:crypto");

const API_BASE_URL = process.env.FEISHU_API_BASE_URL || "https://open.feishu.cn";
const MENU_EVENT_KEY = process.env.FEISHU_MENU_EVENT_KEY || "analyze_stock";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(204, "");
  }

  if (event.httpMethod === "GET") {
    return response(200, {
      ok: true,
      service: "feishu-stock-analyze-netlify",
      endpoint: "/.netlify/functions/feishu"
    });
  }

  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method Not Allowed" });
  }

  try {
    const rawBody = getRawBody(event);
    verifyRequestSignature(event.headers || {}, rawBody);

    const payload = normalizePayload(JSON.parse(rawBody || "{}"));
    verifyCallbackToken(payload);

    const challenge = getChallenge(payload);
    if (challenge) {
      return response(200, { challenge });
    }

    const eventType = getEventType(payload);
    if (eventType === "application.bot.menu_v6") {
      await handleBotMenu(payload);
      return response(200, {});
    }

    if (eventType === "card.action.trigger") {
      await handleCardAction(payload);
      return response(200, cardToast("success", "已提交分析指令"));
    }

    if (eventType === "im.message.receive_v1") {
      await handleMessageReceive(payload);
      return response(200, {});
    }

    console.log("Ignored Feishu callback:", eventType || payload.type || "unknown");
    return response(200, {});
  } catch (error) {
    console.error("Feishu callback failed:", error);
    return response(error.statusCode || 500, {
      error: error.publicMessage || "Internal Server Error"
    });
  }
};

async function handleBotMenu(payload) {
  const body = payload.event || payload;
  const eventKey = body.event_key || body.eventKey || body.action?.value?.event_key;

  if (eventKey && eventKey !== MENU_EVENT_KEY) {
    console.log(`Ignored menu event_key=${eventKey}`);
    return;
  }

  const target = getMenuReplyTarget(body);
  if (!target.receiveId) {
    throw publicError(400, "Cannot find menu callback target user/chat");
  }

  await sendMessage(target.receiveIdType, target.receiveId, "interactive", buildStockInputCard(target));
}

async function handleCardAction(payload) {
  const body = payload.event || payload;
  const action = body.action || {};
  const value = action.value || {};
  const formValue = action.form_value || action.formValue || {};
  const stockCode = normalizeStockCode(
    formValue.stock_code ||
      formValue.stockCode ||
      value.stock_code ||
      value.stockCode ||
      value.code
  );

  if (!stockCode) {
    throw publicError(400, "Stock code is required");
  }

  const fallbackTarget = getMenuReplyTarget(body);
  const receiveIdType = value.receive_id_type || value.receiveIdType || fallbackTarget.receiveIdType;
  const receiveId = value.receive_id || value.receiveId || fallbackTarget.receiveId;

  if (!receiveIdType || !receiveId) {
    throw publicError(400, "Cannot find card callback target user/chat");
  }

  await sendMessage(receiveIdType, receiveId, "text", {
    text: `/analyze ${stockCode}`
  });
}

async function handleMessageReceive(payload) {
  const body = payload.event || payload;
  const message = body.message || {};
  const sender = body.sender || {};

  if (sender.sender_type === "app") {
    return;
  }

  if (message.message_type && message.message_type !== "text") {
    return;
  }

  const chatId = message.chat_id || body.chat_id || body.open_chat_id;
  if (!chatId) {
    throw publicError(400, "Cannot find message chat_id");
  }

  const text = getMessageText(message.content).trim();
  if (!text) {
    return;
  }

  if (/^(股票|分析|菜单|stock)$/i.test(text)) {
    await sendMessage("chat_id", chatId, "interactive", buildStockInputCard({
      receiveIdType: "chat_id",
      receiveId: chatId
    }));
    return;
  }

  const analyzeMatch = text.match(/^\/analyze\s+(.+)$/i);
  if (analyzeMatch) {
    const stockCode = normalizeStockCode(analyzeMatch[1]);
    await sendMessage("chat_id", chatId, "text", {
      text: `已收到分析指令：/analyze ${stockCode}`
    });
    return;
  }

  await sendMessage("chat_id", chatId, "text", {
    text: "请发送“股票”打开输入卡片，或直接发送 /analyze 股票代码"
  });
}

function buildStockInputCard(target) {
  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "股票分析"
      }
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "输入股票代码后提交，机器人会发送对应的分析指令。"
        }
      },
      {
        tag: "form",
        name: "stock_form",
        elements: [
          {
            tag: "input",
            name: "stock_code",
            label: {
              tag: "plain_text",
              content: "股票代码"
            },
            label_position: "top",
            placeholder: {
              tag: "plain_text",
              content: "例如 AAPL、TSLA、600519、00700"
            },
            max_length: 32
          },
          {
            tag: "button",
            type: "primary",
            name: "submit_stock_code",
            action_type: "form_submit",
            text: {
              tag: "plain_text",
              content: "提交"
            },
            value: {
              action: "submit_stock_code",
              receive_id_type: target.receiveIdType,
              receive_id: target.receiveId
            }
          }
        ]
      }
    ]
  };
}

async function sendMessage(receiveIdType, receiveId, msgType, content) {
  const token = await getTenantAccessToken();
  const url = `${API_BASE_URL}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: msgType,
      content: JSON.stringify(content)
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    console.error("Feishu send message failed:", data);
    throw publicError(502, data.msg || "Feishu send message failed");
  }

  return data.data;
}

let cachedTenantToken = null;

async function getTenantAccessToken() {
  if (cachedTenantToken && cachedTenantToken.expiresAt > Date.now() + 60_000) {
    return cachedTenantToken.token;
  }

  const appId = requireEnv("FEISHU_APP_ID");
  const appSecret = requireEnv("FEISHU_APP_SECRET");
  const res = await fetch(`${API_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    console.error("Feishu tenant token failed:", data);
    throw publicError(502, data.msg || "Feishu tenant token failed");
  }

  cachedTenantToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + Math.max((data.expire || 7200) - 120, 60) * 1000
  };

  return cachedTenantToken.token;
}

function normalizePayload(payload) {
  if (payload.encrypt) {
    return JSON.parse(decryptFeishuPayload(payload.encrypt));
  }
  return payload;
}

function decryptFeishuPayload(encrypted) {
  const encryptKey = requireEnv("FEISHU_ENCRYPT_KEY");
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const encryptedBuffer = Buffer.from(encrypted, "base64");
  const iv = encryptedBuffer.subarray(0, 16);
  const ciphertext = encryptedBuffer.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function verifyRequestSignature(headers, rawBody) {
  if (process.env.FEISHU_SKIP_SIGNATURE === "true") {
    return;
  }

  const signature = getHeader(headers, "x-lark-signature");
  const timestamp = getHeader(headers, "x-lark-request-timestamp");
  const nonce = getHeader(headers, "x-lark-request-nonce");

  if (!signature && !timestamp && !nonce) {
    return;
  }

  if (!signature || !timestamp || !nonce) {
    throw publicError(401, "Missing Feishu signature headers");
  }

  const signKey = process.env.FEISHU_ENCRYPT_KEY || process.env.FEISHU_VERIFICATION_TOKEN || "";
  if (!signKey) {
    throw publicError(500, "FEISHU_ENCRYPT_KEY or FEISHU_VERIFICATION_TOKEN is required to verify signature");
  }

  const expected = crypto
    .createHash("sha256")
    .update(`${timestamp}${nonce}${signKey}${rawBody}`)
    .digest("hex");

  if (!safeEqual(signature, expected)) {
    throw publicError(401, "Invalid Feishu signature");
  }
}

function verifyCallbackToken(payload) {
  const expected = process.env.FEISHU_VERIFICATION_TOKEN;
  if (!expected) {
    return;
  }

  const actual = payload.token || payload.header?.token;
  if (actual && actual !== expected) {
    throw publicError(401, "Invalid Feishu verification token");
  }
}

function getMenuReplyTarget(body) {
  const openChatId =
    body.context?.open_chat_id ||
    body.context?.chat_id ||
    body.chat_id ||
    body.open_chat_id;

  if (openChatId) {
    return {
      receiveIdType: "chat_id",
      receiveId: openChatId
    };
  }

  const openId =
    body.operator?.operator_id?.open_id ||
    body.operator?.open_id ||
    body.user_id?.open_id ||
    body.open_id ||
    body.user?.open_id;

  return {
    receiveIdType: "open_id",
    receiveId: openId
  };
}

function getEventType(payload) {
  return payload.header?.event_type || payload.event_type || payload.type;
}

function getChallenge(payload) {
  if (payload.type === "url_verification") {
    return payload.challenge;
  }
  if (payload.header?.event_type === "url_verification") {
    return payload.event?.challenge || payload.challenge;
  }
  return null;
}

function normalizeStockCode(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase()
    .slice(0, 32);
}

function getMessageText(content) {
  if (!content) {
    return "";
  }

  try {
    const parsed = JSON.parse(content);
    return parsed.text || "";
  } catch {
    return String(content);
  }
}

function getRawBody(event) {
  if (!event.body) {
    return "";
  }
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

function getHeader(headers, name) {
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === lower);
  return key ? headers[key] : undefined;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw publicError(500, `${name} is required`);
  }
  return value;
}

function cardToast(type, content) {
  return {
    toast: {
      type,
      content
    }
  };
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}

function publicError(statusCode, publicMessage) {
  const error = new Error(publicMessage);
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}
