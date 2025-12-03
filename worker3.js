const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and - 
const ADMIN_UID = String(ENV_ADMIN_UID || ''); // 强制为字符串，避免类型比较问题

const NOTIFY_INTERVAL = 3600 * 1000;
const fraudDb = 'https://raw.githubusercontent.com/wuyangdaily/nfd/refs/heads/main/data/fraud.db';
const notificationUrl = 'https://raw.githubusercontent.com/wuyangdaily/nfd/refs/heads/main/data/notification.txt'
const startMsgUrl = 'https://raw.githubusercontent.com/wuyangdaily/nfd/refs/heads/main/data/startMessage.md';

const chatSessions = {};  // 存储所有聊天会话的状态

const enable_notification = true

let currentChatTarget = null;  // 当前聊天目标ID
const localFraudList = []; // 本地存储骗子ID的数组
let chatTargetUpdated = false; // 标志是否更新了聊天目标

const blockedUsers = []; // 本地存储被屏蔽用户的数组
let pendingMessage = null; // 全局变量保存待发送的消息

// 在程序启动时加载会话状态
loadChatSession();
// 在程序启动时加载被屏蔽用户列表
loadBlockedUsers();
// 在程序启动时加载骗子列表
loadFraudList();

function escapeMarkdown(text) {
  return text.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');
}

// -------------------- 权限 & 命令解析相关 --------------------

// 判断传入的 userId（可能是数字或字符串）是否为管理员
function isAdmin(userId) {
  return String(userId) === ADMIN_UID;
}

// debug 辅助（可部署后移除或注释）
function debugLog(...args) {
  try { console.log(...args); } catch(e) {}
}

/**
 * 从 message 里提取标准化的 bot 命令（去掉 @BotUsername）
 * 返回例如 "/block" 或 "/start"；如果没有命令返回 null
 */
function getCommandFromMessage(message) {
  if (!message || !message.text) return null;

  if (Array.isArray(message.entities)) {
    const cmdEnt = message.entities.find(e => e.type === 'bot_command');
    if (cmdEnt) {
      const raw = message.text.substr(cmdEnt.offset, cmdEnt.length);
      return raw.split('@')[0];
    }
  }
  return message.text.split(' ')[0].split('@')[0];
}

// -------------------- Telegram API wrapper --------------------

/**
 * Return url to telegram api, optionally with parameters added
 */
function apiUrl(methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}

function requestTelegram(methodName, body, params = null){
  return fetch(apiUrl(methodName, params), body)
    .then(r => r.json())
}

function makeReqBody(body){
  return {
    method:'POST',
    headers:{
      'content-type':'application/json'
    },
    body:JSON.stringify(body)
  }
}

// 带日志的 sendMessage（替换原有简单包装）
async function sendMessage(msg = {}) {
  try {
    const res = await requestTelegram('sendMessage', makeReqBody(msg));
    console.log('[sendMessage] request ->', JSON.stringify(msg), ' response ->', JSON.stringify(res));
    return res;
  } catch (err) {
    console.error('[sendMessage] error', err, 'msg=', JSON.stringify(msg));
    throw err;
  }
}

function copyMessage(msg = {}){
  return requestTelegram('copyMessage', makeReqBody(msg))
}

function forwardMessage(msg){
  return requestTelegram('forwardMessage', makeReqBody(msg))
}

function generateKeyboard(options) {
  return {
    reply_markup: {
      inline_keyboard: options.map(option => [{
        text: option.text,
        callback_data: option.callback_data
      }])
    }
  };
}

/**
 * 生成管理员命令键盘
 * uid: 用户 id（字符串或数字）
 * nicknamePlain: 纯文本昵称（不做 Markdown 转义），用于按钮显示
 * 按钮文本为中文显示（callback_data 保持 action_uid）
 */
function generateAdminCommandKeyboard(uid, nicknamePlain) {
  const rows = [
    [
      { text: '查看昵称', callback_data: `search_${uid}` },
      { text: '屏蔽用户', callback_data: `block_${uid}` }
    ],
    [
      { text: '解除屏蔽', callback_data: `unblock_${uid}` },
      { text: '检查屏蔽', callback_data: `checkblock_${uid}` }
    ],
    [
      { text: '添加骗子', callback_data: `fraud_${uid}` },
      { text: '移除骗子', callback_data: `unfraud_${uid}` }
    ],
    [
      { text: '查看骗子列表', callback_data: `list_${uid}` },
      { text: '查看屏蔽列表', callback_data: `blocklist_${uid}` }
    ],
    [
      { text: `选择 ${nicknamePlain}`, callback_data: `select_${uid}` }
    ],
    [
      { text: `取消 ${nicknamePlain}`, callback_data: `cancel_${uid}` }
    ]
  ];

  return {
    reply_markup: {
      inline_keyboard: rows
    }
  };
}

// -------------------- KV 存储操作 --------------------

async function saveChatSession() {
  await FRAUD_LIST.put('chatSessions', JSON.stringify(chatSessions));
}

async function loadChatSession() {
  const storedSessions = await FRAUD_LIST.get('chatSessions');
  if (storedSessions) {
    Object.assign(chatSessions, JSON.parse(storedSessions));
  }
}

async function generateRecentChatButtons() {
  const recentChatTargets = await getRecentChatTargets();
  const buttons = await Promise.all(recentChatTargets.map(async chatId => {
    const userInfo = await getUserInfo(chatId);
    const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${chatId}`;
    return {
      text: `发给：${nickname}`,
      callback_data: `select_${chatId}`
    };
  }));
  return generateKeyboard(buttons);
}

async function saveBlockedUsers() {
  await FRAUD_LIST.put('blockedUsers', JSON.stringify(blockedUsers));
}

async function searchUserByUID(uid) {
  const userInfo = await getUserInfo(uid);
  if (userInfo) {
    const nickname = `${userInfo.first_name} ${userInfo.last_name || ''}`.trim();
    return { user: userInfo, text: `UID: ${uid}, 昵称: ${nickname}` };
  } else {
    return null;
  }
}

async function loadBlockedUsers() {
  const storedList = await FRAUD_LIST.get('blockedUsers');
  if (storedList) {
    blockedUsers.push(...JSON.parse(storedList));
  }
}

// 最近聊天目标函数
async function saveRecentChatTargets(chatId) {
  let recentChatTargets = await FRAUD_LIST.get('recentChatTargets', { type: "json" }) || [];
  recentChatTargets = recentChatTargets.filter(id => id !== chatId.toString());
  recentChatTargets.unshift(chatId.toString());
  if (recentChatTargets.length > 5) {
    recentChatTargets.pop();
  }
  await FRAUD_LIST.put('recentChatTargets', JSON.stringify(recentChatTargets));
}

async function getRecentChatTargets() {
  let recentChatTargets = await FRAUD_LIST.get('recentChatTargets', { type: "json" }) || [];
  return recentChatTargets.map(id => id.toString());
}

// 保存骗子id到kv空间
async function saveFraudList() {
  await FRAUD_LIST.put('localFraudList', JSON.stringify(localFraudList));
}

async function loadFraudList() {
  const storedList = await FRAUD_LIST.get('localFraudList');
  if (storedList) {
    localFraudList.push(...JSON.parse(storedList));
  }
}

async function setBotCommands() {
  const commands = [
    { command: 'start', description: '启动机器人会话' },
    { command: 'help', description: '显示帮助信息' },
    { command: 'search', description: '查看指定uid用户最新昵称 (仅管理员)' },
    { command: 'block', description: '屏蔽用户 (仅管理员)' },
    { command: 'unblock', description: '解除屏蔽用户 (仅管理员)' },
    { command: 'checkblock', description: '检查用户是否被屏蔽 (仅管理员)' },
    { command: 'fraud', description: '添加骗子ID - [本地库] (仅管理员)' },
    { command: 'unfraud', description: '移除骗子ID - [本地库] (仅管理员)' },
    { command: 'list', description: '查看骗子ID列表 - [本地库] (仅管理员)' },
    { command: 'blocklist', description: '查看屏蔽用户列表 - [本地库] (仅管理员)' }
  ];

  return requestTelegram('setMyCommands', makeReqBody({ commands }));
}

// -------------------- Cloudflare Worker HTTP 入口 --------------------

addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname === WEBHOOK) {
    event.respondWith(handleWebhook(event))
  } else if (url.pathname === '/registerWebhook') {
    event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
  } else if (url.pathname === '/unRegisterWebhook') {
    event.respondWith(unRegisterWebhook(event))
  } else if (url.pathname === '/setCommands') {
    event.respondWith(setBotCommands())
  } else {
    event.respondWith(new Response('No handler for this request'))
  }
})

async function handleWebhook(event) {
  if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }

  const update = await event.request.json()
  try { console.log('[onUpdate] incoming update:', JSON.stringify(update)); } catch(e){}

  event.waitUntil(onUpdate(update))

  return new Response('Ok')
}

async function onUpdate(update) {
  if (update.message) {
    await onMessage(update.message);
  } else if (update.callback_query) {
    await onCallbackQuery(update.callback_query);
  }
}

// -------------------- Telegram helper getters --------------------

async function getUserInfo(chatId) {
  const response = await requestTelegram('getChat', makeReqBody({ chat_id: chatId }));
  console.log(`Response for getUserInfo with chatId ${chatId}:`, response);
  if (response.ok) {
    return response.result;
  } else {
    console.error(`Failed to get user info for chat ID ${chatId}:`, response);
    return null;
  }
}

async function getChatMember(chatId) {
  const response = await requestTelegram('getChatMember', makeReqBody({ chat_id: chatId, user_id: chatId }));
  console.log(`Response for getChatMember with chatId ${chatId}:`, response);
  if (response.ok) {
    return response.result;
  } else {
    console.error(`Failed to get chat member info for chat ID ${chatId}:`, response);
    return null;
  }
}

async function getUserProfilePhotos(userId) {
  const response = await requestTelegram('getUserProfilePhotos', makeReqBody({ user_id: userId }));
  console.log(`Response for getUserProfilePhotos with userId ${userId}:`, response);
  if (response.ok) {
    const photos = response.result.photos;
    if (photos.length > 0) {
      return `用户存在，头像数量: ${photos.length}`;
    } else {
      return '用户存在，但没有头像';
    }
  } else {
    console.error(`Failed to get user profile photos for user ID ${userId}:`, response);
    return null;
  }
}

async function getChat(chatId) {
  const response = await requestTelegram('getChat', makeReqBody({ chat_id: chatId }));
  console.log(`Response for getChat with chatId ${chatId}:`, response);
  if (response.ok) {
    return response.result;
  } else {
    console.error(`Failed to get chat info for chat ID ${chatId}:`, response);
    return null;
  }
}

/**
 * 新增：获取用户展示名（优先 first_name + last_name；找不到则 UID）
 * 如果 forMarkdownV2 为 true，会对文本做 MarkdownV2 转义，适合直接放到 parse_mode:'MarkdownV2' 文本中。
 */
async function getDisplayName(uid, forMarkdownV2 = false) {
  try {
    const userInfo = await getUserInfo(uid);
    let name;
    if (userInfo) {
      name = `${userInfo.first_name || ''} ${userInfo.last_name || ''}`.trim();
      if (!name) name = `UID:${uid}`;
    } else {
      name = `UID:${uid}`;
    }
    if (forMarkdownV2) return escapeMarkdown(name);
    return name;
  } catch (e) {
    console.warn('[getDisplayName] failed for', uid, e);
    return forMarkdownV2 ? escapeMarkdown(`UID:${uid}`) : `UID:${uid}`;
  }
}

// -------------------- requireAdmin (async, 带回退通知) --------------------

/**
 * 返回 boolean：是否为管理员。
 * 若不是管理员，会尝试发送提示：
 *  1) 先向当前会话 message.chat.id 发送 '此命令仅限管理员使用。'
 *  2) 若发送失败或 telegram 返回 ok:false，则回退向 message.from.id 私聊发送
 */
async function requireAdmin(message) {
  const senderId = message && message.from ? message.from.id : null;
  const idToCheck = senderId || (message && message.chat ? message.chat.id : null);

  debugLog('requireAdmin called. senderId=', senderId, 'idToCheck=', idToCheck, 'ADMIN_UID=', ADMIN_UID);

  if (isAdmin(idToCheck)) {
    return true;
  }

  // 不是管理员：先尝试在当前会话通知
  const chatTarget = message && message.chat && message.chat.id ? message.chat.id : senderId;

  try {
    const res = await sendMessage({ chat_id: chatTarget, text: '此命令仅限管理员使用。' });
    // 若 telegram 返回 ok:false，尝试回退通知
    if (!res || !res.ok) {
      debugLog('[requireAdmin] send to chat failed, trying fallback. res=', res);
      if (senderId && String(senderId) !== String(chatTarget)) {
        try {
          await sendMessage({ chat_id: senderId, text: '此命令仅限管理员使用。' });
        } catch (e2) {
          console.error('[requireAdmin] fallback sendMessage failed', e2);
        }
      }
    }
  } catch (err) {
    console.error('[requireAdmin] sendMessage to chatTarget failed', err);
    // 回退私聊通知
    if (senderId && String(senderId) !== String(chatTarget)) {
      try {
        await sendMessage({ chat_id: senderId, text: '此命令仅限管理员使用。' });
      } catch (e2) {
        console.error('[requireAdmin] fallback sendMessage failed', e2);
      }
    }
  }

  return false;
}

// -------------------- 验证模块 --------------------
/*
 Keys used in KV (nfd):
 - verify-<chatId> : JSON { question, options:[], correct, message_id, expires }
 - verify-attempts-<chatId> : number
 - verify-lock-<chatId> : timestamp (ms)  -> unlock time
 - verified-<chatId> : timestamp (ms) -> verification passed time
*/

function randInt(min, max) {
  return Math.floor(Math.random()*(max-min+1)) + min;
}

function createMathQuestion() {
  // 随机生成一个简单表达式，四则运算
  const ops = ['+', '-', '*', '/'];
  // 生成表达式深度 1 或 2（比如 "3 + 4" 或 "3 * (2 + 1)" ）
  // 为保持简单，生成 "a op b" 或 "(a op b) op2 c"
  const a = randInt(1, 20);
  const b = randInt(1, 20);
  const op = ops[randInt(0, ops.length-1)];
  let expr = `${a} ${op} ${b}`;
  let value = evalExpression(a, op, b);

  if (Math.random() < 0.4) {
    const c = randInt(1, 10);
    const op2 = ops[randInt(0, ops.length-1)];
    expr = `(${expr}) ${op2} ${c}`;
    value = evalExpression(value, op2, c);
  }

  // 规范化结果到整数（除法采用整除或保留一位小数再四舍五入）
  if (!Number.isFinite(value)) value = 0;
  // 对除法进行整数或保留1位
  if (Math.abs(value - Math.round(value)) > 0.0001) {
    value = Math.round(value * 10) / 10; // 保留1位
  } else {
    value = Math.round(value);
  }

  return { expr, value };
}

function evalExpression(x, op, y) {
  try {
    switch(op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/':
        if (y === 0) return x; // 避免除零
        return x / y;
    }
  } catch (e) {
    return 0;
  }
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function deleteOldVerifyMsg(chatId) {
  try {
    const key = 'verify-' + chatId;
    const v = await nfd.get(key, { type: "json" });
    if (v && v.message_id) {
      try {
        await requestTelegram('deleteMessage', makeReqBody({ chat_id: chatId, message_id: v.message_id }));
      } catch (e) {
        console.warn('[deleteOldVerifyMsg] deleteMessage failed', e);
      }
    }
    await nfd.delete(key);
  } catch (e) {
    console.warn('[deleteOldVerifyMsg] failed', e);
  }
}

function oneLineKeyboardForOptions(chatId, options) {
  // options: array of { text, callback_data }
  // Single row with 5 buttons
  return {
    reply_markup: {
      inline_keyboard: [ options.map(opt => ({ text: opt.text, callback_data: opt.callback_data })) ]
    }
  };
}

async function sendVerify(chatId) {
  // 先检查是否被锁定
  const lockKey = 'verify-lock-' + chatId;
  const lockVal = await nfd.get(lockKey, { type: "json" });
  if (lockVal && Number(lockVal) > Date.now()) {
    // 仍在锁定期
    const remain = Number(lockVal) - Date.now();
    const minutes = Math.floor(remain/60000);
    const seconds = Math.floor((remain%60000)/1000);
    const bj = new Date(Number(lockVal)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    await sendMessage({ chat_id: chatId, text: `验证失败次数已达到 3 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试` });
    return;
  }

  // 每次生成题目前把旧题删除（确保只保留一个验证消息）
  await deleteOldVerifyMsg(chatId);

  const q = createMathQuestion();
  const correct = q.value;
  // 生成 4 个干扰项（总共 5 个选项）
  const options = new Set();
  options.add(String(correct));
  while (options.size < 5) {
    // 随机附近值或完全随机
    const delta = randInt(-10, 10);
    let candidate = correct + delta;
    if (!Number.isFinite(candidate)) candidate = randInt(0, 100);
    // 保证格式一致：若为浮点则保留1位
    if (Math.abs(candidate - Math.round(candidate)) > 0.0001) {
      candidate = Math.round(candidate * 10) / 10;
    } else {
      candidate = Math.round(candidate);
    }
    options.add(String(candidate));
  }
  const optsArr = Array.from(options);
  // 随机排列
  shuffleArray(optsArr);

  // 找到正确选项索引
  const correctIndex = optsArr.findIndex(x => String(x) === String(correct));

  // 构建按钮（single row）
  const btns = optsArr.map((t, idx) => {
    return {
      text: t,
      callback_data: `verify_${chatId}_${idx}` // verify_<chatId>_<index>
    };
  });

  const text = `请先通过验证（1 分钟内回答）:\n${q.expr} = ?\n（错误3次将被锁定1小时）`;

  const sent = await sendMessage({
    chat_id: chatId,
    text,
    ...oneLineKeyboardForOptions(chatId, btns)
  });

  // 保存题目到 KV
  const key = 'verify-' + chatId;
  const rec = {
    expr: q.expr,
    correct: String(correct),
    options: optsArr,
    correctIndex,
    message_id: sent && sent.result ? sent.result.message_id : (sent && sent.message_id) || null,
    expires: Date.now() + 60 * 1000 // 1 minute
  };
  await nfd.put(key, JSON.stringify(rec));
  // attempts 保留在 verify-attempts-<chatId> 中（不在这里重置）
}

async function lockUser(chatId) {
  const lockKey = 'verify-lock-' + chatId;
  const until = Date.now() + 60 * 60 * 1000; // 1 hour
  await nfd.put(lockKey, JSON.stringify(until));
  return until;
}

async function isVerified(chatId) {
  const key = 'verified-' + chatId;
  const v = await nfd.get(key, { type: "json" });
  if (!v) return false;
  const ts = Number(v);
  if (!ts) return false;
  // 24 hours valid
  if (Date.now() - ts < 24 * 3600 * 1000) return true;
  // expired -> delete
  await nfd.delete(key);
  return false;
}

// -------------------- 消息处理 --------------------

async function onMessage(message) {
  try { console.log('[onMessage] raw message:', JSON.stringify(message)); } catch(e){}

  const chatId = message.chat.id.toString();

  // 初始化会话状态
  if (!chatSessions[chatId]) {
    chatSessions[chatId] = {
      step: 0,
      lastInteraction: Date.now()
    };
  }

  const session = chatSessions[chatId];

  // 更新最后交互时间
  session.lastInteraction = Date.now();

  // 获取当前聊天目标
  currentChatTarget = await getCurrentChatTarget();

  if (message.reply_to_message) {
    const repliedChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
    if (repliedChatId) {
      currentChatTarget = repliedChatId;
      await setCurrentChatTarget(repliedChatId);
      await saveRecentChatTargets(repliedChatId);
      const userInfo = await getUserInfo(repliedChatId);
      let nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${repliedChatId}`;
      nickname = escapeMarkdown(nickname);
      const chatLink = userInfo.username ? `https://t.me/${userInfo.username}` : `tg://user?id=${repliedChatId}`;
      await sendMessage({
        chat_id: ADMIN_UID,
        parse_mode: 'MarkdownV2',
        text: `已切换到聊天目标:【 *${nickname}* 】 \nuid：${repliedChatId}\n[点击不用bot直接私聊](${chatLink})`
      });
    }
  }

  // 解析命令与参数
  const command = getCommandFromMessage(message); // '/start' '/block' '/fraud' ...
  const args = message.text ? message.text.slice((command||'').length).trim() : '';

  debugLog('onMessage command=', command, 'args=', args, 'from=', message.from && message.from.id);

  // 若 message.text 存在且识别出命令，走命令分支
  if (message.text && command) {
    if (command === '/start') {
      // 要求先验证
      await sendVerify(chatId);
      return;
    } else if (command === '/help') {
      let helpMsg = "可用指令列表:\n" +
                    "/start - 启动机器人会话（需先验证）\n" +
                    "/help - 显示帮助信息\n" +
                    "/search - 查看指定uid用户最新昵称 (仅管理员)\n" +
                    "/block - 屏蔽用户 (仅管理员)\n" +
                    "/unblock - 解除屏蔽用户 (仅管理员)\n" +
                    "/checkblock - 检查用户是否被屏蔽 (仅管理员)\n" +
                    "/fraud - 添加骗子ID (仅管理员)\n" +
                    "/unfraud - 移除骗子ID (仅管理员)\n" +
                    "/list - 查看本地骗子ID列表 (仅管理员)\n" +
                    "/blocklist - 查看被屏蔽用户列表 (仅管理员)\n";
      return sendMessage({
        chat_id: message.chat.id,
        text: helpMsg,
      });
    } else if (command === '/blocklist') {
      if (!(await requireAdmin(message))) return;
      return listBlockedUsers();
    } else if (command === '/unblock') {
      if (!(await requireAdmin(message))) return;
      // 两种方式：回复 or /unblock <index>
      if (args) {
        const index = parseInt(args.split(' ')[0], 10);
        if (!isNaN(index)) {
          return unblockByIndex(index);
        } else {
          return sendMessage({ chat_id: ADMIN_UID, text: '无效的序号。' });
        }
      } else {
        // 没有 args — 由 reply_to_message 分支处理
      }
    } else if (command === '/list') {
      if (!(await requireAdmin(message))) return;
      // 处理 /list 命令
      const storedList = await FRAUD_LIST.get('localFraudList');
      if (storedList) {
        localFraudList.length = 0;
        localFraudList.push(...JSON.parse(storedList));
      }

      if (localFraudList.length === 0) {
        return sendMessage({ chat_id: message.chat.id, text: '本地没有骗子ID。' });
      } else {
        const fraudListText = await Promise.all(localFraudList.map(async uid => {
          const userInfo = await searchUserByUID(uid);
          const nickname = userInfo ? `${userInfo.user.first_name} ${userInfo.user.last_name || ''}`.trim() : '未知';
          return `UID: ${uid}, 昵称: ${nickname}`;
        }));
        return sendMessage({ chat_id: message.chat.id, text: `本地骗子ID列表:\n${fraudListText.join('\n')}` });
      }
    } else if (command === '/search') {
      if (!(await requireAdmin(message))) return;

      // 优先：如果是回复管理员收到的被转发消息，取映射
      if (message.reply_to_message) {
        const forwardedMsgId = message.reply_to_message.message_id;
        const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
        if (guestChatId) {
          const userInfo = await getChat(guestChatId);
          if (userInfo) {
            const nickname = `${userInfo.first_name} ${userInfo.last_name || ''}`.trim();
            return sendMessage({ chat_id: message.chat.id, text: `UID: ${guestChatId}, 昵称: ${nickname}` });
          } else {
            return sendMessage({ chat_id: message.chat.id, text: `找不到 UID: ${guestChatId} 的详细信息` });
          }
        } else {
          // 回退：若 reply_to_message 不是转发映射（也可能是其他消息），提示
          return sendMessage({ chat_id: message.chat.id, text: '无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。' });
        }
      }

      // 回退：支持 /search <uid>
      if (args) {
        const searchId = args.split(' ')[0].toString();
        const userInfo = await getChat(searchId);
        if (userInfo) {
          const nickname = `${userInfo.first_name} ${userInfo.last_name || ''}`.trim();
          return sendMessage({ chat_id: message.chat.id, text: `UID: ${searchId}, 昵称: ${nickname}` });
        } else {
          return sendMessage({ chat_id: message.chat.id, text: `无法找到 UID: ${searchId} 的用户信息` });
        }
      } else {
        return sendMessage({ chat_id: message.chat.id, text: '使用方法: 请回复某条消息并输入 /search，或 /search 用户UID' });
      }
    } else if (command === '/fraud') {
      if (!(await requireAdmin(message))) return;

      // 优先：回复方式（取转发映射）
      if (message.reply_to_message) {
        const forwardedMsgId = message.reply_to_message.message_id;
        const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
        if (guestChatId) {
          const idStr = String(guestChatId);
          if (!localFraudList.includes(idStr)) {
            localFraudList.push(idStr);
            await saveFraudList();
            return sendMessage({ chat_id: message.chat.id, text: `已添加骗子ID: ${idStr}` });
          } else {
            return sendMessage({ chat_id: message.chat.id, text: `骗子ID ${idStr} 已存在` });
          }
        } else {
          return sendMessage({ chat_id: message.chat.id, text: '无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。' });
        }
      }

      // 回退：支持 /fraud <uid>
      if (args) {
        const fraudId = args.split(' ')[0].toString();
        if (!localFraudList.includes(fraudId)) {
          localFraudList.push(fraudId);
          await saveFraudList();
          return sendMessage({ chat_id: message.chat.id, text: `已添加骗子ID: ${fraudId}` });
        } else {
          return sendMessage({ chat_id: message.chat.id, text: `骗子ID: ${fraudId} 已存在` });
        }
      } else {
        return sendMessage({ chat_id: message.chat.id, text: '使用方法: 请回复某条消息并输入 /fraud，或 /fraud 用户UID' });
      }
    } else if (command === '/unfraud') {
      if (!(await requireAdmin(message))) return;

      // 优先：回复方式
      if (message.reply_to_message) {
        const forwardedMsgId = message.reply_to_message.message_id;
        const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
        if (guestChatId) {
          const idStr = String(guestChatId);
          const idx = localFraudList.indexOf(idStr);
          if (idx > -1) {
            localFraudList.splice(idx, 1);
            await saveFraudList();
            return sendMessage({ chat_id: message.chat.id, text: `已移除骗子ID: ${idStr}` });
          } else {
            return sendMessage({ chat_id: message.chat.id, text: `骗子ID ${idStr} 不在本地列表中` });
          }
        } else {
          return sendMessage({ chat_id: message.chat.id, text: '无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。' });
        }
      }

      // 回退：支持 /unfraud <uid>
      if (args) {
        const fraudId = args.split(' ')[0].toString();
        const index = localFraudList.indexOf(fraudId);
        if (index > -1) {
          localFraudList.splice(index, 1);
          await saveFraudList();
          return sendMessage({ chat_id: message.chat.id, text: `已移除骗子ID: ${fraudId}` });
        } else {
          return sendMessage({ chat_id: message.chat.id, text: `骗子ID: ${fraudId} 不在本地列表中` });
        }
      } else {
        return sendMessage({ chat_id: message.chat.id, text: '使用方法: 请回复某条消息并输入 /unfraud，或 /unfraud 用户UID' });
      }
    }
  } // end if command

  // 以下是管理员专用命令（如果命令为回复消息触发）
  if (message.text && getCommandFromMessage(message) === '/block') {
    if (!(await requireAdmin(message))) return;
    if (message.reply_to_message) {
      return handleBlock(message);
    } else {
      return sendMessage({
        chat_id: message.chat.id,
        text: '使用方法: 请回复某条消息并输入 /block 来屏蔽用户。'
      });
    }
  }

  if (message.text && getCommandFromMessage(message) === '/unblock') {
    if (!(await requireAdmin(message))) return;
    if (message.reply_to_message) {
      return handleUnBlock(message);
    } else {
      return sendMessage({
        chat_id: message.chat.id,
        text: '使用方法: 请【 回复某条消息并输入 /unblock 】 或 【使用 /unblock 屏蔽序号 】来解除屏蔽用户。\n 屏蔽序号可以通过 /blocklist 获取'
      });
    }
  }

  if (message.text && getCommandFromMessage(message) === '/checkblock') {
    if (!(await requireAdmin(message))) return;
    if (message.reply_to_message) {
      return checkBlock(message);
    } else {
      return sendMessage({
        chat_id: message.chat.id,
        text: '使用方法: 请回复某条消息并输入 /checkblock 来检查用户是否被屏蔽。'
      });
    }
  }

  // 管理员消息处理
  if (isAdmin(message.from && message.from.id ? message.from.id : message.chat.id)) {
    if (message.reply_to_message) {
      const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
      console.log("guestChatId:", guestChatId);
      if (guestChatId) {
        currentChatTarget = guestChatId;
        await saveRecentChatTargets(guestChatId);
        if (message.text) {
          await sendMessage({
            chat_id: guestChatId,
            text: message.text,
          });
        } else if (message.photo || message.video || message.document || message.audio) {
          console.log("Copying media message:", message.message_id);
          await copyMessage({
            chat_id: guestChatId,
            from_chat_id: message.chat.id,
            message_id: message.message_id,
          });
        }
      }
    } else {
      if (!currentChatTarget) {
        pendingMessage = message;
        const recentChatButtons = await generateRecentChatButtons();
        return sendMessage({
          chat_id: ADMIN_UID,
          text: "没有设置当前聊天目标!\n请先通过【回复某条消息】或【点击下方按钮】来设置聊天目标。",
          reply_markup: recentChatButtons.reply_markup
        });
      }
      if (message.text) {
        await sendMessage({
          chat_id: currentChatTarget,
          text: message.text,
        });
      } else if (message.photo || message.video || message.document || message.audio) {
        console.log("Copying media message:", message.message_id);
        await copyMessage({
          chat_id: currentChatTarget,
          from_chat_id: message.chat.id,
          message_id: message.message_id,
        });
      }
    }
    return; // 确保管理员自己不会收到消息
  }

  // 普通访客消息处理
  return handleGuestMessage(message);
}

async function sendDirectMessage(text) {
  if (currentChatTarget) {
    return sendMessage({
      chat_id: currentChatTarget,
      text: text
    });
  } else {
    return sendMessage({
      chat_id: ADMIN_UID,
      text: "没有设置当前聊天目标，请先通过回复某条消息来设置聊天目标。"
    });
  }
}

async function handleGuestMessage(message) {
  const chatId = message.chat.id;
  let isblocked = await nfd.get('isblocked-' + chatId, { type: "json" });

  if (isblocked) {
    return sendMessage({
      chat_id: chatId,
      text: '您已被屏蔽，无法发送消息！'
    });
  }

  // 验证流程
  // 1) 检查是否已验证（24 小时内）
  // 2) 检查是否正在被锁定（1 小时）
  // 3) 若未验证 -> 发送验证题并返回（不转发消息）
  if (await isVerified(chatId)) {
    // 已验证 -> 继续正常逻辑（转发）
  } else {
    // 未验证 -> 检查是否锁定
    const lockKey = 'verify-lock-' + chatId;
    const lockVal = await nfd.get(lockKey, { type: "json" });
    if (lockVal && Number(lockVal) > Date.now()) {
      const remain = Number(lockVal) - Date.now();
      const minutes = Math.floor(remain/60000);
      const seconds = Math.floor((remain%60000)/1000);
      const bj = new Date(Number(lockVal)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      await sendMessage({ chat_id: chatId, text: `验证失败次数已达到 3 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试` });
      return;
    }

    // 发送验证并返回，不转发
    await sendVerify(chatId);
    return;
  }

  // 若已验证，才会走到这里并转发
  const forwardReq = await forwardMessage({
    chat_id: ADMIN_UID,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  });

  if (forwardReq.ok) {
    await nfd.put('msg-map-' + forwardReq.result.message_id, chatId);
    if (currentChatTarget !== chatId) {
      chatTargetUpdated = false;
      if (!chatTargetUpdated) {
        const userInfo = await getUserInfo(chatId);
        // 纯文本昵称（用于按钮）
        const nicknamePlain = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${chatId}`;
        // 转义昵称用于 MarkdownV2 文本显示
        const nicknameEsc = escapeMarkdown(nicknamePlain);
        const chatLink = `tg://user?id=${chatId}`;
        let messageText = `新的聊天目标: \n*${nicknameEsc}*\nUID: ${chatId}\n[点击不用bot直接私聊](${chatLink})`;
        if (await isFraud(chatId)) {
          messageText += `\n\n*请注意，对方是骗子!*`;
        }
        // 这里改为使用管理员命令键盘（两列每行两个，中文按钮）
        await sendMessage({
          chat_id: ADMIN_UID,
          parse_mode: 'MarkdownV2',
          text: messageText,
          ...generateAdminCommandKeyboard(chatId, nicknamePlain)
        });
        chatTargetUpdated = true;
      }
    } else {
      chatTargetUpdated = true;
    }
    await saveRecentChatTargets(chatId);
  }
  return handleNotify(message);
}

async function sendPhoto(msg) {
  return requestTelegram('sendPhoto', makeReqBody(msg))
}

async function sendVideo(msg) {
  return requestTelegram('sendVideo', makeReqBody(msg))
}

async function sendDocument(msg) {
  return requestTelegram('sendDocument', makeReqBody(msg))
}

async function sendAudio(msg) {
  return requestTelegram('sendAudio', makeReqBody(msg))
}

// -------------------- 回调处理（完整实现，包含会话内确认 & 取消行为） --------------------

async function onCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const message = callbackQuery.message;

  // 解析 action 和 uid（早解析以便 verify bypass admin-check）
  const parts = data.split('_');
  const action = parts[0];
  const rest = parts.slice(1);

  // 允许 verify 动作由普通用户触发（否则用户无法点按钮）
  if (action === 'verify') {
    // 格式: verify_<chatId>_<optionIndex>
    const chatId = rest[0];
    const selIdx = parseInt(rest[1], 10);

    // minimal ack
    try {
      await requestTelegram('answerCallbackQuery', makeReqBody({
        callback_query_id: callbackQuery.id
      }));
    } catch (e) {}

    // 处理验证逻辑
    const key = 'verify-' + chatId;
    const recRaw = await nfd.get(key);
    if (!recRaw) {
      await sendMessage({ chat_id: chatId, text: '验证已过期或不存在，请重试。' });
      await sendVerify(chatId);
      return;
    }
    const rec = JSON.parse(recRaw);

    // 检查过期
    if (Date.now() > rec.expires) {
      await sendMessage({ chat_id: chatId, text: '验证已超时，请重新验证。' });
      await deleteOldVerifyMsg(chatId);
      await sendVerify(chatId);
      return;
    }

    // 检查锁定
    const lockKey = 'verify-lock-' + chatId;
    const lockVal = await nfd.get(lockKey, { type: "json" });
    if (lockVal && Number(lockVal) > Date.now()) {
      const remain = Number(lockVal) - Date.now();
      const minutes = Math.floor(remain/60000);
      const seconds = Math.floor((remain%60000)/1000);
      const bj = new Date(Number(lockVal)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      await sendMessage({ chat_id: chatId, text: `验证失败次数已达到 3 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试` });
      return;
    }

    // 获取 attempts
    const attemptKey = 'verify-attempts-' + chatId;
    let attempts = await nfd.get(attemptKey, { type: "json" }) || 0;

    // 判断是否正确
    if (selIdx === rec.correctIndex) {
      // 通过：标记 verified，清理旧题与 attempts
      await nfd.put('verified-' + chatId, JSON.stringify(Date.now()));
      await nfd.delete(key);
      await nfd.delete(attemptKey);
      // 删除验证消息
      try {
        if (rec.message_id) {
          await requestTelegram('deleteMessage', makeReqBody({ chat_id: chatId, message_id: rec.message_id }));
        }
      } catch (e) {}

      // 发送欢迎语
      await sendMessage({
        chat_id: chatId,
        text: "你可以用这个机器人跟我对话了。写下您想要发送的消息（图片、视频），我会尽快回复您！"
      });
      return;
    } else {
      // 错误：+1 attempts，保存
      attempts = Number(attempts) + 1;
      await nfd.put(attemptKey, JSON.stringify(attempts));

      if (attempts >= 3) {
        const until = await lockUser(chatId);
        await deleteOldVerifyMsg(chatId);
        await nfd.delete(attemptKey);
        const remainMs = until - Date.now();
        const minutes = Math.floor(remainMs/60000);
        const seconds = Math.floor((remainMs%60000)/1000);
        const bj = new Date(until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        await sendMessage({
          chat_id: chatId,
          text: `验证失败次数已达到 3 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试`
        });
        return;
      } else {
        // 错误但未达到 3 次：重新生成题（删除旧题）
        await deleteOldVerifyMsg(chatId);
        await sendVerify(chatId);
        return;
      }
    }
  }

  // 非 verify 的回调，以下仍然限制管理员
  if (!isAdmin(callbackQuery.from && callbackQuery.from.id)) {
    try {
      await requestTelegram('answerCallbackQuery', makeReqBody({
        callback_query_id: callbackQuery.id,
        text: '仅限管理员使用该按钮。',
        show_alert: false
      }));
    } catch (e) { /* ignore */ }
    return sendMessage({ chat_id: callbackQuery.from.id, text: '仅限管理员使用该按钮。' });
  }

  // 解析 action 和 uid for admin actions
  const parts2 = data.split('_');
  const action2 = parts2[0];
  const uid = parts2.slice(1).join('_'); // 允许 uid 中可能含下划线（防护）

  // 标志本次 callback 是否已经用 answerCallbackQuery 回应（防止重复）
  let answered = false;

  try {
    switch (action2) {
      case 'select': {
        const selectedChatId = uid;

        // 获取展示名（纯文本）
        const userInfo = await getUserInfo(selectedChatId);
        const namePlain = userInfo ? `${userInfo.first_name || ''} ${userInfo.last_name || ''}`.trim() : `UID:${selectedChatId}`;

        if (currentChatTarget !== selectedChatId) {
          currentChatTarget = selectedChatId;
          chatTargetUpdated = true;
          await saveRecentChatTargets(selectedChatId);
          await setCurrentChatTarget(selectedChatId);

          // 保存会话（KV & 内存）
          chatSessions[ADMIN_UID] = {
            target: selectedChatId,
            timestamp: Date.now()
          };
          await saveChatSession();

          // 向管理员会话发送固定格式的普通会话消息
          const confirmationText = `已选择当前聊天目标：${namePlain}${selectedChatId}`;
          // 如果可能，回复到原通知消息
          const sendOpts = { chat_id: ADMIN_UID, text: confirmationText };
          if (message && message.message_id) sendOpts.reply_to_message_id = message.message_id;
          await sendMessage(sendOpts);

          // 如果对方在骗子列表，额外在会话中提示也可以保留（原代码会在通知时提示，此处可选）
          // 如果有 pendingMessage，继续转发
          if (pendingMessage) {
            try {
              if (pendingMessage.text) {
                await sendMessage({
                  chat_id: currentChatTarget,
                  text: pendingMessage.text,
                });
              } else if (pendingMessage.photo || pendingMessage.video || pendingMessage.document || pendingMessage.audio) {
                await copyMessage({
                  chat_id: currentChatTarget,
                  from_chat_id: ADMIN_UID,
                  message_id: pendingMessage.message_id,
                });
              }
              await sendMessage({
                chat_id: ADMIN_UID,
                text: "消息已成功转发给目标用户。",
                reply_to_message_id: pendingMessage.message_id
              });
            } catch (error) {
              await sendMessage({
                chat_id: ADMIN_UID,
                text: "消息转发失败，请重试。",
                reply_to_message_id: pendingMessage.message_id
              });
            }
            pendingMessage = null;
          }
        } else {
          // 已经是当前目标，仍向会话发送相同格式的确认消息
          const confirmationText = `已选择当前聊天目标：${namePlain}${selectedChatId}`;
          const sendOpts = { chat_id: ADMIN_UID, text: confirmationText };
          if (message && message.message_id) sendOpts.reply_to_message_id = message.message_id;
          await sendMessage(sendOpts);
        }
        break;
      }

      case 'search': {
        const searchId = uid;
        const userInfo = await getChat(searchId);
        if (userInfo) {
          const nickname = `${userInfo.first_name || ''} ${userInfo.last_name || ''}`.trim();
          await sendMessage({ chat_id: ADMIN_UID, text: `UID: ${searchId}, 昵称: ${nickname}` });
        } else {
          await sendMessage({ chat_id: ADMIN_UID, text: `无法找到 UID: ${searchId} 的用户信息` });
        }
        break;
      }

      case 'block': {
        const guestChatId = uid;
        if (String(guestChatId) === ADMIN_UID) {
          await sendMessage({ chat_id: ADMIN_UID, text: '不能屏蔽自己' });
          break;
        }
        const userInfo2 = await getUserInfo(guestChatId);
        const nickname = userInfo2 ? `${userInfo2.first_name} ${userInfo2.last_name || ''}`.trim() : `UID:${guestChatId}`;
        await nfd.put('isblocked-' + guestChatId, true);

        if (!blockedUsers.includes(guestChatId)) {
          blockedUsers.push(guestChatId);
          await saveBlockedUsers();
        }

        await sendMessage({
          chat_id: ADMIN_UID,
          text: `用户 ${nickname} 已被屏蔽`,
        });
        break;
      }

      case 'unblock': {
        const guestChatId = uid;
        const userInfo2 = await getUserInfo(guestChatId);
        const nickname2 = userInfo2 ? `${userInfo2.first_name} ${userInfo2.last_name || ''}`.trim() : `UID:${guestChatId}`;
        await nfd.put('isblocked-' + guestChatId, false);

        const index = blockedUsers.indexOf(guestChatId);
        if (index > -1) {
          blockedUsers.splice(index, 1);
          await saveBlockedUsers();
        }

        await sendMessage({
          chat_id: ADMIN_UID,
          text: `用户 ${nickname2} 已解除屏蔽`,
        });
        break;
      }

      case 'checkblock': {
        const guestChatId = uid;
        let isBlocked = await nfd.get('isblocked-' + guestChatId, { type: "json" });
        const userInfo2 = await getUserInfo(guestChatId);
        const nickname3 = userInfo2 ? `${userInfo2.first_name} ${userInfo2.last_name || ''}`.trim() : `UID:${guestChatId}`;
        await sendMessage({
          chat_id: ADMIN_UID,
          text: `用户 ${nickname3}` + (isBlocked ? ' 已被屏蔽' : ' 未被屏蔽')
        });
        break;
      }

      case 'fraud': {
        const fraudId = uid;
        if (!localFraudList.includes(String(fraudId))) {
          localFraudList.push(String(fraudId));
          await saveFraudList();
          await sendMessage({ chat_id: ADMIN_UID, text: `已添加骗子ID: ${fraudId}` });
        } else {
          await sendMessage({ chat_id: ADMIN_UID, text: `骗子ID ${fraudId} 已存在` });
        }
        break;
      }

      case 'unfraud': {
        const fraudId = uid;
        const idx = localFraudList.indexOf(String(fraudId));
        if (idx > -1) {
          localFraudList.splice(idx, 1);
          await saveFraudList();
          await sendMessage({ chat_id: ADMIN_UID, text: `已移除骗子ID: ${fraudId}` });
        } else {
          await sendMessage({ chat_id: ADMIN_UID, text: `骗子ID ${fraudId} 不在本地列表中` });
        }
        break;
      }

      case 'list': {
        // 列出本地骗子ID
        if (localFraudList.length === 0) {
          await sendMessage({ chat_id: ADMIN_UID, text: '本地没有骗子ID。' });
        } else {
          const fraudListText = await Promise.all(localFraudList.map(async uid => {
            const userInfo = await searchUserByUID(uid);
            const nickname = userInfo ? `${userInfo.user.first_name} ${userInfo.user.last_name || ''}`.trim() : '未知';
            return `UID: ${uid}, 昵称: ${nickname}`;
          }));
          await sendMessage({ chat_id: ADMIN_UID, text: `本地骗子ID列表:\n${fraudListText.join('\n')}` });
        }
        break;
      }

      case 'blocklist': {
        // 列出被屏蔽用户
        if (blockedUsers.length === 0) {
          await sendMessage({ chat_id: ADMIN_UID, text: '没有被屏蔽的用户。' });
        } else {
          const blockedListText = await Promise.all(blockedUsers.map(async (uid, index) => {
            const userInfo = await getUserInfo(uid);
            const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : '未知';
            return `${index + 1}. UID: ${uid}, 昵称: ${nickname}`;
          }));
          await sendMessage({ chat_id: ADMIN_UID, text: `被屏蔽的用户列表:\n${blockedListText.join('\n')}` });
        }
        break;
      }

      case 'cancel': {
        // 删除原通知消息（如果可用），然后发送确认
        try {
          const namePlain = await getDisplayName(uid, false);

          if (message && message.chat && message.message_id) {
            try {
              await requestTelegram('deleteMessage', makeReqBody({
                chat_id: message.chat.id,
                message_id: message.message_id
              }));
            } catch (e) {
              console.warn('[onCallbackQuery][cancel] deleteMessage failed, will continue', e);
            }
          }

          pendingMessage = null;

          if (currentChatTarget && String(currentChatTarget) === String(uid)) {
            currentChatTarget = null;
            try {
              await FRAUD_LIST.delete('currentChatTarget');
            } catch (e) {
              console.warn('[onCallbackQuery][cancel] delete currentChatTarget from KV failed', e);
            }
            await sendMessage({
              chat_id: ADMIN_UID,
              text: `已取消选择并清空当前聊天目标：${namePlain}${uid}`
            });
          } else {
            await sendMessage({
              chat_id: ADMIN_UID,
              text: `已取消选择：${namePlain}${uid}，当前聊天目标保持不变。`
            });
          }
        } catch (e) {
          console.error('[onCallbackQuery][cancel] overall failed', e);
          pendingMessage = null;
          await sendMessage({ chat_id: ADMIN_UID, text: `已取消操作（UID: ${uid}）。` });
        }
        break;
      }

      default:
        await sendMessage({ chat_id: ADMIN_UID, text: `未知操作: ${action2}` });
        break;
    }
  } catch (err) {
    console.error('[onCallbackQuery] handler error', err);
    await sendMessage({ chat_id: ADMIN_UID, text: `处理回调出错: ${err && err.message ? err.message : err}` });
  }

  // 如果到这里还没有用 answerCallbackQuery 回应，做一次最小 ACK 避免 Telegram 一直 loading
  if (!answered) {
    try {
      await requestTelegram('answerCallbackQuery', makeReqBody({
        callback_query_id: callbackQuery.id
      }));
    } catch (e) {
      console.warn('[onCallbackQuery] final answerCallbackQuery failed', e);
    }
  }
}

// 新增：获取当前聊天目标
async function getCurrentChatTarget() {
  const session = await FRAUD_LIST.get('currentChatTarget', { type: 'json' });
  if (session) {
    const elapsed = Date.now() - session.timestamp;
    if (elapsed < 30 * 60 * 1000) {
      return session.target;
    } else {
      await FRAUD_LIST.delete('currentChatTarget');
    }
  }
  return null;
}

async function setCurrentChatTarget(target) {
  const session = {
    target: target,
    timestamp: Date.now()
  };
  await FRAUD_LIST.put('currentChatTarget', JSON.stringify(session));
}

async function handleNotify(message) {
  let chatId = message.chat.id;
  if (await isFraud(chatId)) {
    return sendMessage({
      chat_id: ADMIN_UID,
      parse_mode: 'Markdown',
      text: `*请注意对方是骗子*！！ \n UID：${chatId}`
    });
  }
  if (enable_notification) {
    let lastMsgTime = await nfd.get('lastmsg-' + chatId, { type: "json" });
    if (!lastMsgTime || Date.now() - lastMsgTime > NOTIFY_INTERVAL) {
      await nfd.put('lastmsg-' + chatId, Date.now());
      return sendMessage({
        chat_id: ADMIN_UID,
        text: await fetch(notificationUrl).then(r => r.text())
      });
    }
  }
}

async function handleBlock(message) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  if (String(guestChatId) === ADMIN_UID) {
    return sendMessage({
      chat_id: ADMIN_UID,
      text: '不能屏蔽自己'
    });
  }
  const userInfo = await getUserInfo(guestChatId);
  const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
  await nfd.put('isblocked-' + guestChatId, true);

  blockedUsers.push(guestChatId);
  await saveBlockedUsers();
  return sendMessage({
    chat_id: ADMIN_UID,
    text: `用户 ${nickname} 已被屏蔽`,
  });
}

async function handleUnBlock(message) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  const userInfo = await getUserInfo(guestChatId);
  const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
  await nfd.put('isblocked-' + guestChatId, false);

  const index = blockedUsers.indexOf(guestChatId);
  if (index > -1) {
    blockedUsers.splice(index, 1);
    await saveBlockedUsers();
  }

  return sendMessage({
    chat_id: ADMIN_UID,
    text: `用户 ${nickname} 已解除屏蔽`,
  });
}

async function checkBlock(message) {
  const guestChatId = await nfd.get('msg-map-' + message.reply_to_message.message_id, { type: "json" });
  let isBlocked = await nfd.get('isblocked-' + guestChatId, { type: "json" });
  const userInfo = await getUserInfo(guestChatId);
  const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
  return sendMessage({
    chat_id: ADMIN_UID,
    text: `用户 ${nickname}` + (isBlocked ? ' 已被屏蔽' : ' 未被屏蔽')
  });
}

async function listBlockedUsers() {
  if (blockedUsers.length === 0) {
    return sendMessage({
      chat_id: ADMIN_UID,
      text: '没有被屏蔽的用户。'
    });
  } else {
    const blockedListText = await Promise.all(blockedUsers.map(async (uid, index) => {
      const userInfo = await getUserInfo(uid);
      const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : '未知';
      return `${index + 1}. UID: ${uid}, 昵称: ${nickname}`;
    }));
    return sendMessage({
      chat_id: ADMIN_UID,
      text: `被屏蔽的用户列表:\n${blockedListText.join('\n')}`
    });
  }
}

async function unblockByIndex(index) {
  if (index < 1 || index > blockedUsers.length) {
    return sendMessage({
      chat_id: ADMIN_UID,
      text: '无效的序号。'
    });
  }
  const guestChatId = blockedUsers[index - 1];
  await nfd.put('isblocked-' + guestChatId, false);
  blockedUsers.splice(index - 1, 1);
  await saveBlockedUsers();
  const userInfo = await getUserInfo(guestChatId);
  const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
  return sendMessage({
    chat_id: ADMIN_UID,
    text: `用户 ${nickname} 已解除屏蔽`,
  });
}

async function sendPlainText(chatId, text) {
  return sendMessage({
    chat_id: chatId,
    text
  });
}

async function registerWebhook (event, requestUrl, suffix, secret) {
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`;
  const r = await (await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))).json();
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2));
}

async function unRegisterWebhook (event) {
  const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json();
  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2));
}

async function isFraud(id){
  id = id.toString();
  if (localFraudList.includes(id)) {
    return true;
  }
  const db = await fetch(fraudDb).then(r => r.text());
  const arr = db.split('\n').filter(v => v);
  return arr.includes(id);
}
