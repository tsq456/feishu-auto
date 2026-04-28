# 飞书机器人股票分析菜单

基于 Netlify Functions 的飞书应用机器人回调服务。流程如下：

1. 用户点击机器人自定义菜单。
2. 飞书推送 `application.bot.menu_v6` 事件到 Netlify Function。
3. Function 向用户或会话发送一张交互式卡片。
4. 用户输入股票代码并点击提交。
5. Function 收到 `card.action.trigger` 回调，机器人向会话发送 `/analyze 股票代码`。

> 注意：飞书开放接口通常不允许机器人替用户把内容写入客户端聊天输入框并以用户身份发送。本项目采用合规实现：由应用机器人代发文本消息 `/analyze 股票代码`。

## 文件

- `netlify/functions/feishu.js`：飞书回调入口和消息发送逻辑
- `netlify.toml`：Netlify Functions 配置，并把 `/feishu` 转发到函数
- `.env.example`：需要配置的环境变量

## 飞书开放平台配置

1. 创建企业自建应用，并启用「机器人」能力。
2. 在「权限管理」申请并发布权限：
   - `im:message:send_as_bot` 或当前租户文档中等价的机器人发消息权限
3. 在「事件与回调」里配置请求地址：
   - `https://你的-netlify-域名/.netlify/functions/feishu`
   - 或 `https://你的-netlify-域名/feishu`
4. 订阅事件/回调：
   - 机器人自定义菜单事件：`application.bot.menu_v6`
   - 卡片回传交互：`card.action.trigger`
5. 在「机器人自定义菜单」中新增菜单，动作选择「推送事件」，事件 ID 填：
   - `analyze_stock`
   - 如果想换 ID，同步修改 `FEISHU_MENU_EVENT_KEY`。
6. 如果开启了 Encrypt Key，把同一个值配置到 Netlify 环境变量 `FEISHU_ENCRYPT_KEY`。

## Netlify 环境变量

复制 `.env.example` 中的变量到 Netlify 项目环境变量：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
FEISHU_VERIFICATION_TOKEN=xxxxxxxxxxxxxxxx
FEISHU_ENCRYPT_KEY=xxxxxxxxxxxxxxxx
FEISHU_MENU_EVENT_KEY=analyze_stock
FEISHU_API_BASE_URL=https://open.feishu.cn
```

国际版 Lark 租户把 `FEISHU_API_BASE_URL` 改为：

```bash
https://open.larksuite.com
```

## 本地调试

```bash
npm install
npm run dev
```

本地回调地址通常是：

```text
http://localhost:8888/.netlify/functions/feishu
```

飞书要求公网 HTTPS 回调，本地调试可使用 Netlify Dev 的 tunnel、ngrok、Cloudflare Tunnel 等工具暴露地址。

## 部署

把本目录推到 Git 仓库并连接 Netlify，或使用 Netlify CLI：

```bash
npm install
npx netlify deploy --prod
```

部署完成后访问：

```text
https://你的-netlify-域名/.netlify/functions/feishu
```

如果返回 `{"ok":true,...}`，说明函数已可访问。

## 回调兼容

实现已包含：

- URL verification challenge 响应
- `application.bot.menu_v6` 菜单事件处理
- `card.action.trigger` 卡片提交处理
- `tenant_access_token` 获取与缓存
- `im/v1/messages` 发送交互式卡片和文本
- `x-lark-signature` 请求签名校验
- Encrypt Key 加密回调解密

如果部署后卡片能发送但按钮点击失败，优先检查飞书后台是否已配置「卡片回传交互」回调地址，以及应用版本是否已发布到当前租户。
