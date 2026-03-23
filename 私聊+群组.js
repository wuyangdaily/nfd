const TOKEN = ENV_BOT_TOKEN // Get it from @BotFather
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET // A-Z, a-z, 0-9, _ and - 
const ADMIN_UID = String(ENV_ADMIN_UID || ''); // 强制为字符串，避免类型比较问题

const NOTIFY_INTERVAL = 3600 * 1000;
const fraudDb = 'https://raw.githubusercontent.com/wuyangdaily/nfd/refs/heads/main/data/fraud.db';
const notificationUrl = 'https://raw.githubusercontent.com/wuyangdaily/nfd/refs/heads/main/data/notification.txt'

const chatSessions = {};  // 存储所有聊天会话的状态

const enable_notification = true

let currentChatTarget = null;  // 当前聊天目标ID
const localFraudList = []; // 本地存储骗子ID的数组
let chatTargetUpdated = false; // 标志是否更新了聊天目标

const blockedUsers = []; // 本地存储被屏蔽用户的数组
let pendingMessage = null; // 全局变量保存待发送的消息

// ================= 模式相关变量 =================
let currentMode = 'private';     // 'private' 或 'group'

// 兼容不同的环境变量读取方式
let groupChatId = null;

// 持久化 KV 键名
const GROUP_CHAT_ID_KV_KEY = 'group_chat_id'; // 用于持久化群组 ID
let configLoadedPromise = null; // 用于确保配置加载完成

console.log(`[初始化] groupChatId = ${groupChatId}`);

// 在程序启动时加载会话状态
loadChatSession();
// 在程序启动时加载被屏蔽用户列表
loadBlockedUsers();
// 在程序启动时加载骗子列表
loadFraudList();
// 加载模式配置（异步，但为了顺序执行，不等待）
loadModeConfig();

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
 * 生成管理员命令键盘（支持两种模式）
 * uid: 用户 id（字符串或数字）
 * nicknamePlain: 纯文本昵称（不做 Markdown 转义），用于按钮显示
 * mode: 'private' 或 'group'，决定底部按钮布局
 * 私聊模式：选择和取消按钮各占一行
 * 群组模式：结束会话按钮占一行
 */
function generateAdminCommandKeyboard(uid, nicknamePlain, mode = 'private') {
  const commonRows = [
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
    ]
  ];

  let additionalRows;
  if (mode === 'group') {
    // 群组模式：一个“结束会话”按钮
    additionalRows = [[{ text: '结束会话', callback_data: `end_${uid}` }]];
  } else {
    // 私聊模式：“选择 xxx”和“取消 xxx”各占一行
    additionalRows = [
      [{ text: `选择 ${nicknamePlain}`, callback_data: `select_${uid}` }],
      [{ text: `取消 ${nicknamePlain}`, callback_data: `cancel_${uid}` }]
    ];
  }

  const rows = [...commonRows, ...additionalRows];
  return { reply_markup: { inline_keyboard: rows } };
}

// -------------------- KV 存储操作 --------------------

async function saveChatSession() {
  await nfd.put('chatSessions', JSON.stringify(chatSessions));
}

async function loadChatSession() {
  const storedSessions = await nfd.get('chatSessions');
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
  await nfd.put('blockedUsers', JSON.stringify(blockedUsers));
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
  const storedList = await nfd.get('blockedUsers');
  if (storedList) {
    blockedUsers.push(...JSON.parse(storedList));
  }
}

// 最近聊天目标函数
async function saveRecentChatTargets(chatId) {
  let recentChatTargets = await nfd.get('recentChatTargets', { type: "json" }) || [];
  recentChatTargets = recentChatTargets.filter(id => id !== chatId.toString());
  recentChatTargets.unshift(chatId.toString());
  if (recentChatTargets.length > 5) {
    recentChatTargets.pop();
  }
  await nfd.put('recentChatTargets', JSON.stringify(recentChatTargets));
}

async function getRecentChatTargets() {
  let recentChatTargets = await nfd.get('recentChatTargets', { type: "json" }) || [];
  return recentChatTargets.map(id => id.toString());
}

// 保存骗子id到kv空间
async function saveFraudList() {
  await nfd.put('localFraudList', JSON.stringify(localFraudList));
}

async function loadFraudList() {
  const storedList = await nfd.get('localFraudList');
  if (storedList) {
    localFraudList.push(...JSON.parse(storedList));
  }
}

// ================= 模式配置加载与保存 =================
async function loadModeConfig() {
  // 加载模式
  const mode = await nfd.get('mode');
  if (mode === 'group') {
    currentMode = 'group';
  } else {
    currentMode = 'private';
  }

  // 加载群组 ID：优先环境变量，否则 KV 中保存的值
  let loadedGroupId = null;
  if (typeof ENV_GROUP_CHAT_ID !== 'undefined' && ENV_GROUP_CHAT_ID) {
    loadedGroupId = ENV_GROUP_CHAT_ID;
  } else if (typeof env !== 'undefined' && env.ENV_GROUP_CHAT_ID) {
    loadedGroupId = env.ENV_GROUP_CHAT_ID;
  } else {
    const savedGroupId = await nfd.get(GROUP_CHAT_ID_KV_KEY);
    if (savedGroupId) {
      loadedGroupId = savedGroupId;
    }
  }
  groupChatId = loadedGroupId || null;
  console.log(`[loadModeConfig] currentMode=${currentMode}, groupChatId=${groupChatId}`);
}

async function saveModeConfig() {
  await nfd.put('mode', currentMode);
  // 注意：groupChatId 的保存由 /setgroup 命令负责，此处不覆盖
}

// 确保配置加载完成（用于首次请求）
async function ensureConfigLoaded() {
  if (!configLoadedPromise) {
    configLoadedPromise = loadModeConfig();
  }
  await configLoadedPromise;
}

// ================= 群组话题管理 =================
// 创建论坛话题
async function createForumTopic(chatId, name) {
  const response = await requestTelegram('createForumTopic', makeReqBody({
    chat_id: chatId,
    name: name
  }));
  if (response.ok && response.result) {
    return response.result.message_thread_id;
  } else {
    console.error('创建话题失败:', response);
    return null;
  }
}

// 获取或创建用户话题
async function ensureUserTopic(userId, displayName) {
  let topicId = await nfd.get('user_topic_' + userId, { type: 'json' });
  if (!topicId && groupChatId) {
    topicId = await createForumTopic(groupChatId, displayName);
    if (topicId) {
      await nfd.put('user_topic_' + userId, JSON.stringify(topicId));
      await nfd.put('topic_user_' + topicId, userId);
    }
  }
  return topicId;
}

// 在群组话题中发送管理按钮消息（仅在创建话题时发送一次）
async function sendAdminButtonsInTopic(topicId, userId, nicknamePlain, nicknameEsc) {
  if (!groupChatId) return;
  const text = `用户: *${nicknameEsc}*\nUID: \`${userId}\``;
  const sent = await sendMessage({
    chat_id: groupChatId,
    message_thread_id: topicId,
    parse_mode: 'MarkdownV2',
    text: text,
    ...generateAdminCommandKeyboard(userId, nicknamePlain, 'group') // 群组模式使用 group 布局
  });
  if (sent.ok && sent.result) {
    // 不再保存 group_msg_map，因为已经有 topic_user 映射
    console.log(`[映射保存] 管理按钮消息发送成功，消息ID: ${sent.result.message_id}`);
  } else {
    console.error('[映射保存] 管理按钮消息发送失败');
  }
}

// 在群组话题中转发用户消息（复制）
async function forwardUserMessageToTopic(userId, topicId, message) {
  if (!groupChatId) return;
  const copyReq = await copyMessage({
    chat_id: groupChatId,
    message_thread_id: topicId,
    from_chat_id: userId,
    message_id: message.message_id
  });
  if (copyReq.ok && copyReq.result) {
    const copiedMsgId = copyReq.result.message_id;
    // 不再保存 group_msg_map，因为已经有 topic_user 映射
    console.log(`[映射保存] 用户消息副本 ${copiedMsgId} 已转发，不保存映射`);
  } else {
    console.error('[转发] 复制消息失败:', copyReq);
  }
  return copyReq;
}

// 新函数：在验证成功后自动为用户创建话题（群组模式下）
async function initUserTopicIfNeeded(userId) {
  if (currentMode !== 'group' || !groupChatId) return;

  // 检查是否已有话题
  let topicId = await nfd.get('user_topic_' + userId, { type: 'json' });
  if (topicId) {
    // 已有话题，检查是否已发送过管理按钮
    const isInitialized = await nfd.get('topic_initialized_' + topicId);
    if (isInitialized) return; // 已初始化，无需重复
  }

  // 获取用户信息
  const userInfo = await getUserInfo(userId);
  const nicknamePlain = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${userId}`;
  const nicknameEsc = escapeMarkdown(nicknamePlain);

  // 创建话题（如果尚未存在）
  topicId = await ensureUserTopic(userId, nicknamePlain);
  if (topicId) {
    // 发送管理按钮消息（首次）
    await sendAdminButtonsInTopic(topicId, userId, nicknamePlain, nicknameEsc);
    await nfd.put('topic_initialized_' + topicId, '1');
    console.log(`[初始化] 为用户 ${userId} 创建话题 ${topicId} 并发送管理按钮`);
  }
}

async function setBotCommands() {
  const commands = [
    { command: 'start', description: '启动机器人会话' },
    { command: 'help', description: '显示帮助信息' },
    { command: 'mode', description: '切换私聊/群组模式 (仅管理员，无参数自动切换，带参数指定模式)' },
    { command: 'setgroup', description: '设置群组ID (仅管理员，临时生效，重启后恢复环境变量)' },
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

  // 确保配置加载完成（包括 groupChatId 和 currentMode）
  await ensureConfigLoaded();

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
 * 获取用户展示名（优先 first_name + last_name；找不到则 UID）
 * 如果 forMarkdownV2 为 true，会对文本做 MarkdownV2 转义
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
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createMathQuestion() {
  const operations = [
    { symbol: '+', name: '加' },
    { symbol: '-', name: '减' },
    { symbol: '×', name: '乘' },
    { symbol: '÷', name: '除' }
  ];
  
  const operation = operations[randInt(0, operations.length - 1)];
  
  let A, B, result, expr;
  
  switch (operation.symbol) {
    case '+':
      A = randInt(1, 50);
      B = randInt(1, 50);
      result = A + B;
      expr = `${A} + ${B}`;
      break;
    case '-':
      A = randInt(2, 100);
      B = randInt(1, A - 1);
      result = A - B;
      expr = `${A} - ${B}`;
      break;
    case '×':
      A = randInt(1, 12);
      B = randInt(1, 12);
      result = A * B;
      expr = `${A} × ${B}`;
      break;
    case '÷':
      B = randInt(2, 12);
      result = randInt(1, 12);
      A = B * result;
      expr = `${A} ÷ ${B}`;
      break;
    default:
      A = randInt(1, 50);
      B = randInt(1, 50);
      result = A + B;
      expr = `${A} + ${B}`;
  }
  
  return { expr, value: result };
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
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
  return {
    reply_markup: {
      inline_keyboard: [ options.map(opt => ({ text: opt.text, callback_data: opt.callback_data })) ]
    }
  };
}

async function sendVerify(chatId) {
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

  await deleteOldVerifyMsg(chatId);

  const q = createMathQuestion();
  const correct = q.value;
  const options = new Set();
  options.add(String(correct));
  while (options.size < 5) {
    const delta = randInt(-5, 5);
    let candidate = correct + delta;
    if (candidate <= 0) candidate = randInt(1, 10);
    if (candidate === correct) candidate += randInt(1, 3);
    options.add(String(candidate));
  }
  
  const optsArr = Array.from(options);
  shuffleArray(optsArr);
  const correctIndex = optsArr.findIndex(x => String(x) === String(correct));

  const btns = optsArr.map((t, idx) => {
    return {
      text: t,
      callback_data: `verify_${chatId}_${idx}`
    };
  });

  const text = `请先通过验证（1 分钟内回答）:\n${q.expr} = ?\n（错误3次将被锁定1小时）`;

  const sent = await sendMessage({
    chat_id: chatId,
    text,
    ...oneLineKeyboardForOptions(chatId, btns)
  });

  const key = 'verify-' + chatId;
  const rec = {
    expr: q.expr,
    correct: String(correct),
    options: optsArr,
    correctIndex,
    message_id: sent && sent.result ? sent.result.message_id : (sent && sent.message_id) || null,
    expires: Date.now() + 60 * 1000
  };
  await nfd.put(key, JSON.stringify(rec));
}

async function lockUser(chatId) {
  const lockKey = 'verify-lock-' + chatId;
  const until = Date.now() + 60 * 60 * 1000;
  await nfd.put(lockKey, JSON.stringify(until));
  return until;
}

async function isVerified(chatId) {
  const key = 'verified-' + chatId;
  const v = await nfd.get(key, { type: "json" });
  if (!v) return false;
  const ts = Number(v);
  if (!ts) return false;
  if (Date.now() - ts < 24 * 3600 * 1000) return true;
  await nfd.delete(key);
  return false;
}

// -------------------- 消息处理 --------------------

async function onMessage(message) {
  try { console.log('[onMessage] raw message:', JSON.stringify(message)); } catch(e){}

  const fromId = message.from ? message.from.id : null;
  const chatId = message.chat.id.toString();

  // 重要：忽略来自群组的普通用户消息（非管理员），避免验证消息发送到群组
  if (message.chat.type !== 'private' && !isAdmin(fromId)) {
    console.log('[忽略] 群组中的普通用户消息，来自', fromId);
    return;
  }

  if (!chatSessions[chatId]) {
    chatSessions[chatId] = {
      step: 0,
      lastInteraction: Date.now()
    };
  }

  const session = chatSessions[chatId];
  session.lastInteraction = Date.now();

  currentChatTarget = await getCurrentChatTarget();

  // ================= 处理群组模式下的管理员回复 =================
  if (groupChatId && String(chatId) === String(groupChatId) && isAdmin(fromId)) {
    let targetUserId = null;

    // 通过话题ID获取用户（唯一方式，不再使用 group_msg_map）
    if (message.message_thread_id) {
      targetUserId = await nfd.get('topic_user_' + message.message_thread_id, { type: 'json' });
      if (targetUserId) {
        console.log(`[群组回复] 通过话题ID ${message.message_thread_id} 找到用户 ${targetUserId}`);
      } else {
        console.log(`[群组回复] 话题ID ${message.message_thread_id} 未找到对应用户`);
      }
    }

    if (targetUserId) {
      try {
        let sendRes;
        if (message.text) {
          sendRes = await sendMessage({ chat_id: targetUserId, text: message.text });
          console.log('[群组回复] 发送文本消息给用户', targetUserId, '结果:', sendRes);
        } else {
          // 任何非文本消息（语音、视频、贴纸、动画等）都使用 copyMessage 转发
          sendRes = await copyMessage({
            chat_id: targetUserId,
            from_chat_id: groupChatId,
            message_id: message.message_id
          });
          console.log('[群组回复] 复制媒体消息给用户', targetUserId, '结果:', sendRes);
        }
        if (sendRes && sendRes.ok) {
          // 成功发送，不添加提示
        } else {
          await sendMessage({
            chat_id: groupChatId,
            message_thread_id: message.message_thread_id,
            text: `❌ 发送失败: ${sendRes ? JSON.stringify(sendRes) : '未知错误'}`,
            reply_to_message_id: message.message_id
          });
        }
      } catch (err) {
        console.error('[群组回复] 发送失败:', err);
        await sendMessage({
          chat_id: groupChatId,
          message_thread_id: message.message_thread_id,
          text: `❌ 发送失败: ${err.message}`,
          reply_to_message_id: message.message_id
        });
      }
      return;
    } else {
      // 无法确定目标用户
      let errorMsg = '⚠️ 无法确定要发送给哪位用户。\n\n';
      if (message.message_thread_id) {
        errorMsg += `当前话题ID: ${message.message_thread_id}\n未找到对应的用户映射。\n\n`;
      } else {
        errorMsg += '当前消息不在话题中（缺少 message_thread_id）。\n\n';
      }
      errorMsg += '请确保：\n1️⃣ 消息发送在机器人创建的话题内\n2️⃣ 话题已正确关联用户（用户曾发过消息）\n3️⃣ 如问题持续，请让用户重新发一条消息以重建映射。';
      await sendMessage({
        chat_id: groupChatId,
        message_thread_id: message.message_thread_id,
        text: errorMsg,
        reply_to_message_id: message.message_id
      });
      return;
    }
  }

  // 解析命令与参数
  const command = getCommandFromMessage(message);
  const args = message.text ? message.text.slice((command||'').length).trim() : '';

  debugLog('onMessage command=', command, 'args=', args, 'from=', fromId);

  // 命令分支
  if (message.text && command) {
    if (command === '/start') {
      const userId = fromId;
      if (isAdmin(userId)) {
        await sendMessage({
          chat_id: userId,
          text: "你可以用这个机器人跟我对话了。写下您想要发送的消息（图片、视频），我会尽快回复您！"
        });
        await nfd.put('verified-' + userId, JSON.stringify(Date.now()));
        // 管理员不需要自动创建话题
        return;
      }
      if (await isVerified(userId)) {
        await sendMessage({
          chat_id: userId,
          text: "你可以用这个机器人跟我对话了。写下您想要发送的消息（图片、视频），我会尽快回复您！"
        });
        // 验证已通过，若群组模式则创建话题
        await initUserTopicIfNeeded(userId);
      } else {
        await sendVerify(userId);
      }
      return;
    } else if (command === '/help') {
      let helpMsg = "可用指令列表:\n" +
                    "/start - 启动机器人会话（需先验证）\n" +
                    "/help - 显示帮助信息\n" +
                    "/mode - 切换私聊/群组模式 (仅管理员，无参数自动切换，带参数指定模式)\n" +
                    "/setgroup - 设置群组ID (仅管理员，临时生效，重启后恢复环境变量)\n" +
                    "/search - 查看指定uid用户最新昵称 (仅管理员)\n" +
                    "/block - 屏蔽用户 (仅管理员)\n" +
                    "/unblock - 解除屏蔽用户 (仅管理员)\n" +
                    "/checkblock - 检查用户是否被屏蔽 (仅管理员)\n" +
                    "/fraud - 添加骗子ID (仅管理员)\n" +
                    "/unfraud - 移除骗子ID (仅管理员)\n" +
                    "/list - 查看本地骗子ID列表 (仅管理员)\n" +
                    "/blocklist - 查看被屏蔽用户列表 (仅管理员)\n";
      return sendMessage({
        chat_id: chatId,
        text: helpMsg,
      });
    } else if (command === '/mode') {
      if (!(await requireAdmin(message))) return;
      const newMode = args.trim().toLowerCase();
      if (newMode === '') {
        if (currentMode === 'private') {
          if (!groupChatId) {
            return sendMessage({ chat_id: chatId, text: '无法切换到群组模式：未设置群组ID。请先使用 /setgroup 设置群组ID或配置环境变量 ENV_GROUP_CHAT_ID。' });
          }
          currentMode = 'group';
          await saveModeConfig();
          await sendMessage({ chat_id: chatId, text: '已切换到群组模式。所有用户消息将转发到群组话题中。' });
        } else {
          currentMode = 'private';
          await saveModeConfig();
          await sendMessage({ chat_id: chatId, text: '已切换到私聊模式。所有用户消息将私聊转发给管理员。' });
        }
        return;
      } else if (newMode === 'group') {
        if (!groupChatId) {
          return sendMessage({ chat_id: chatId, text: '请先设置群组ID（环境变量 ENV_GROUP_CHAT_ID 或使用 /setgroup 命令）。' });
        }
        currentMode = 'group';
        await saveModeConfig();
        await sendMessage({ chat_id: chatId, text: '已切换到群组模式。所有用户消息将转发到群组话题中。' });
      } else if (newMode === 'private') {
        currentMode = 'private';
        await saveModeConfig();
        await sendMessage({ chat_id: chatId, text: '已切换到私聊模式。所有用户消息将私聊转发给管理员。' });
      } else {
        await sendMessage({ chat_id: chatId, text: `当前模式: ${currentMode}\n使用方法: /mode 或 /mode private 或 /mode group` });
      }
      return;
    } else if (command === '/setgroup') {
      if (!(await requireAdmin(message))) return;
      const newGroupId = args.trim();
      if (!newGroupId) {
        return sendMessage({ chat_id: chatId, text: '使用方法: /setgroup 群组ID' });
      }
      groupChatId = newGroupId;
      await nfd.put(GROUP_CHAT_ID_KV_KEY, newGroupId);   // 持久化
      await sendMessage({ chat_id: chatId, text: `群组ID已设置为: ${groupChatId}（持久化保存）` });
      return;
    } else if (command === '/blocklist') {
      if (!(await requireAdmin(message))) return;
      return listBlockedUsers();
    } else if (command === '/unblock') {
      if (!(await requireAdmin(message))) return;
      if (message.reply_to_message) {
        return handleUnBlock(message);
      }
      if (args) {
        const index = parseInt(args.split(' ')[0], 10);
        if (!isNaN(index)) {
          return unblockByIndex(index);
        } else {
          return sendMessage({ chat_id: ADMIN_UID, text: '无效的序号。' });
        }
      }
      return sendMessage({
        chat_id: chatId,
        text: '使用方法: 请【回复某条消息并输入 /unblock 】 或 【使用 /unblock 屏蔽序号 】来解除屏蔽用户。\n 屏蔽序号可以通过 /blocklist 获取'
      });
    } else if (command === '/list') {
      if (!(await requireAdmin(message))) return;
      const storedList = await nfd.get('localFraudList');
      if (storedList) {
        localFraudList.length = 0;
        localFraudList.push(...JSON.parse(storedList));
      }
      if (localFraudList.length === 0) {
        return sendMessage({ chat_id: chatId, text: '本地没有骗子ID。' });
      } else {
        const fraudListText = await Promise.all(localFraudList.map(async uid => {
          const userInfo = await searchUserByUID(uid);
          const nickname = userInfo ? `${userInfo.user.first_name} ${userInfo.user.last_name || ''}`.trim() : '未知';
          return `UID: ${uid}, 昵称: ${nickname}`;
        }));
        return sendMessage({ chat_id: chatId, text: `本地骗子ID列表:\n${fraudListText.join('\n')}` });
      }
    } else if (command === '/search') {
      if (!(await requireAdmin(message))) return;
      if (message.reply_to_message) {
        const forwardedMsgId = message.reply_to_message.message_id;
        const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
        if (guestChatId) {
          const userInfo = await getChat(guestChatId);
          if (userInfo) {
            const nickname = `${userInfo.first_name} ${userInfo.last_name || ''}`.trim();
            return sendMessage({ chat_id: chatId, text: `UID: ${guestChatId}, 昵称: ${nickname}` });
          } else {
            return sendMessage({ chat_id: chatId, text: `找不到 UID: ${guestChatId} 的详细信息` });
          }
        } else {
          return sendMessage({ chat_id: chatId, text: '无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。' });
        }
      }
      if (args) {
        const searchId = args.split(' ')[0].toString();
        const userInfo = await getChat(searchId);
        if (userInfo) {
          const nickname = `${userInfo.first_name} ${userInfo.last_name || ''}`.trim();
          return sendMessage({ chat_id: chatId, text: `UID: ${searchId}, 昵称: ${nickname}` });
        } else {
          return sendMessage({ chat_id: chatId, text: `无法找到 UID: ${searchId} 的用户信息` });
        }
      } else {
        return sendMessage({ chat_id: chatId, text: '使用方法: 请回复某条消息并输入 /search，或 /search 用户UID' });
      }
    } else if (command === '/fraud') {
      if (!(await requireAdmin(message))) return;
      if (message.reply_to_message) {
        const forwardedMsgId = message.reply_to_message.message_id;
        const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
        if (guestChatId) {
          const idStr = String(guestChatId);
          if (!localFraudList.includes(idStr)) {
            localFraudList.push(idStr);
            await saveFraudList();
            return sendMessage({ chat_id: chatId, text: `已添加骗子ID: ${idStr}` });
          } else {
            return sendMessage({ chat_id: chatId, text: `骗子ID ${idStr} 已存在` });
          }
        } else {
          return sendMessage({ chat_id: chatId, text: '无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。' });
        }
      }
      if (args) {
        const fraudId = args.split(' ')[0].toString();
        if (!localFraudList.includes(fraudId)) {
          localFraudList.push(fraudId);
          await saveFraudList();
          return sendMessage({ chat_id: chatId, text: `已添加骗子ID: ${fraudId}` });
        } else {
          return sendMessage({ chat_id: chatId, text: `骗子ID: ${fraudId} 已存在` });
        }
      } else {
        return sendMessage({ chat_id: chatId, text: '使用方法: 请回复某条消息并输入 /fraud，或 /fraud 用户UID' });
      }
    } else if (command === '/unfraud') {
      if (!(await requireAdmin(message))) return;
      if (message.reply_to_message) {
        const forwardedMsgId = message.reply_to_message.message_id;
        const guestChatId = await nfd.get('msg-map-' + forwardedMsgId, { type: "json" });
        if (guestChatId) {
          const idStr = String(guestChatId);
          const idx = localFraudList.indexOf(idStr);
          if (idx > -1) {
            localFraudList.splice(idx, 1);
            await saveFraudList();
            return sendMessage({ chat_id: chatId, text: `已移除骗子ID: ${idStr}` });
          } else {
            return sendMessage({ chat_id: chatId, text: `骗子ID ${idStr} 不在本地列表中` });
          }
        } else {
          return sendMessage({ chat_id: chatId, text: '无法从该回复中找到对应用户（请确认回复的是管理员收到的转发消息）。' });
        }
      }
      if (args) {
        const fraudId = args.split(' ')[0].toString();
        const index = localFraudList.indexOf(fraudId);
        if (index > -1) {
          localFraudList.splice(index, 1);
          await saveFraudList();
          return sendMessage({ chat_id: chatId, text: `已移除骗子ID: ${fraudId}` });
        } else {
          return sendMessage({ chat_id: chatId, text: `骗子ID: ${fraudId} 不在本地列表中` });
        }
      } else {
        return sendMessage({ chat_id: chatId, text: '使用方法: 请回复某条消息并输入 /unfraud，或 /unfraud 用户UID' });
      }
    } else if (command === '/block') {
      if (!(await requireAdmin(message))) return;
      if (message.reply_to_message) {
        return handleBlock(message);
      } else {
        return sendMessage({
          chat_id: chatId,
          text: '使用方法: 请回复某条消息并输入 /block 来屏蔽用户。'
        });
      }
    } else if (command === '/checkblock') {
      if (!(await requireAdmin(message))) return;
      if (message.reply_to_message) {
        return checkBlock(message);
      } else {
        return sendMessage({
          chat_id: chatId,
          text: '使用方法: 请回复某条消息并输入 /checkblock 来检查用户是否被屏蔽。'
        });
      }
    }
  }

  // 管理员消息处理（非命令）
  if (isAdmin(fromId)) {
    if (message.reply_to_message) {
      const repliedMsgId = message.reply_to_message.message_id;
      const guestChatId = await nfd.get('msg-map-' + repliedMsgId, { type: "json" });
      console.log("guestChatId:", guestChatId);
      if (guestChatId) {
        currentChatTarget = guestChatId;
        await saveRecentChatTargets(guestChatId);
        if (message.text) {
          await sendMessage({
            chat_id: guestChatId,
            text: message.text,
          });
        } else {
          // 任何非文本消息都使用 copyMessage 转发
          console.log("Copying media message:", message.message_id);
          await copyMessage({
            chat_id: guestChatId,
            from_chat_id: chatId,
            message_id: message.message_id,
          });
        }
        // 使用后立即删除映射，避免累积
        await nfd.delete('msg-map-' + repliedMsgId);
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
      } else {
        // 任何非文本消息都使用 copyMessage 转发
        console.log("Copying media message:", message.message_id);
        await copyMessage({
          chat_id: currentChatTarget,
          from_chat_id: chatId,
          message_id: message.message_id,
        });
      }
    }
    return;
  }

  // 普通访客消息处理（此时一定是私聊）
  return handleGuestMessage(message);
}

async function handleGuestMessage(message) {
  const userId = message.from.id; // 用户ID
  const isblocked = await nfd.get('isblocked-' + userId, { type: "json" });

  if (isblocked) {
    return sendMessage({
      chat_id: userId,
      text: '您已被屏蔽，无法发送消息！'
    });
  }

  if (await isVerified(userId)) {
    // 已验证
  } else {
    const lockKey = 'verify-lock-' + userId;
    const lockVal = await nfd.get(lockKey, { type: "json" });
    if (lockVal && Number(lockVal) > Date.now()) {
      const remain = Number(lockVal) - Date.now();
      const minutes = Math.floor(remain/60000);
      const seconds = Math.floor((remain%60000)/1000);
      const bj = new Date(Number(lockVal)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      await sendMessage({ chat_id: userId, text: `验证失败次数已达到 3 次，您被限制再次验证。\n还剩 ${minutes} 分 ${seconds} 秒\n解封时间 ${bj} 后再试` });
      return;
    }
    await sendVerify(userId);
    return;
  }

  // 根据模式转发消息
  if (currentMode === 'group' && groupChatId) {
    const userInfo = await getUserInfo(userId);
    const nicknamePlain = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${userId}`;
    const nicknameEsc = escapeMarkdown(nicknamePlain);
    let topicId = await ensureUserTopic(userId, nicknamePlain);
    if (!topicId) {
      console.error('无法创建话题，群组ID可能不正确或机器人无权限');
      return;
    }
    const isFirst = !(await nfd.get('topic_initialized_' + topicId));
    if (isFirst) {
      await sendAdminButtonsInTopic(topicId, userId, nicknamePlain, nicknameEsc);
      await nfd.put('topic_initialized_' + topicId, '1');
    }
    await forwardUserMessageToTopic(userId, topicId, message);
    return;
  } else {
    // 私聊模式
    const forwardReq = await forwardMessage({
      chat_id: ADMIN_UID,
      from_chat_id: userId,
      message_id: message.message_id
    });

    if (forwardReq.ok) {
      await nfd.put('msg-map-' + forwardReq.result.message_id, userId);
      if (currentChatTarget !== userId) {
        chatTargetUpdated = false;
        if (!chatTargetUpdated) {
          const userInfo = await getUserInfo(userId);
          const nicknamePlain = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${userId}`;
          const nicknameEsc = escapeMarkdown(nicknamePlain);
          const chatLink = `tg://user?id=${userId}`;
          let messageText = `新的聊天目标: \n*${nicknameEsc}*\nUID: ${userId}\n[点击不用bot直接私聊](${chatLink})`;
          if (await isFraud(userId)) {
            messageText += `\n\n*请注意，对方是骗子!*`;
          }
          await sendMessage({
            chat_id: ADMIN_UID,
            parse_mode: 'MarkdownV2',
            text: messageText,
            ...generateAdminCommandKeyboard(userId, nicknamePlain, 'private') // 私聊模式使用 private 布局
          });
          chatTargetUpdated = true;
        }
      } else {
        chatTargetUpdated = true;
      }
      await saveRecentChatTargets(userId);
    }
    return handleNotify(message);
  }
}

// -------------------- 回调处理 --------------------

async function onCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const message = callbackQuery.message;

  const parts = data.split('_');
  const action = parts[0];
  const rest = parts.slice(1);

  if (action === 'verify') {
    const chatId = rest[0];
    const selIdx = parseInt(rest[1], 10);
    if (String(callbackQuery.from.id) !== String(chatId)) {
      try {
        await requestTelegram('answerCallbackQuery', makeReqBody({
          callback_query_id: callbackQuery.id,
          text: '不要乱动别人的操作哟👻',
          show_alert: true
        }));
      } catch (e) {}
      return;
    }
    try {
      await requestTelegram('answerCallbackQuery', makeReqBody({
        callback_query_id: callbackQuery.id
      }));
    } catch (e) {}

    const key = 'verify-' + chatId;
    const recRaw = await nfd.get(key);
    if (!recRaw) {
      await sendMessage({ chat_id: chatId, text: '验证已过期或不存在，请重试。' });
      await sendVerify(chatId);
      return;
    }
    const rec = JSON.parse(recRaw);
    if (Date.now() > rec.expires) {
      await sendMessage({ chat_id: chatId, text: '验证已超时，请重新验证。' });
      await deleteOldVerifyMsg(chatId);
      await sendVerify(chatId);
      return;
    }
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
    const attemptKey = 'verify-attempts-' + chatId;
    let attempts = await nfd.get(attemptKey, { type: "json" }) || 0;
    if (selIdx === rec.correctIndex) {
      await nfd.put('verified-' + chatId, JSON.stringify(Date.now()));
      await nfd.delete(key);
      await nfd.delete(attemptKey);
      try {
        if (rec.message_id) {
          await requestTelegram('deleteMessage', makeReqBody({ chat_id: chatId, message_id: rec.message_id }));
        }
      } catch (e) {}
      await sendMessage({
        chat_id: chatId,
        text: "你可以用这个机器人跟我对话了。写下您想要发送的消息（图片、视频），我会尽快回复您！"
      });
      // 验证成功后自动创建话题（群组模式下）
      await initUserTopicIfNeeded(chatId);
      return;
    } else {
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
        await deleteOldVerifyMsg(chatId);
        await sendVerify(chatId);
        return;
      }
    }
  }

  // 非 verify 的回调，仅限管理员
  if (!isAdmin(callbackQuery.from && callbackQuery.from.id)) {
    try {
      await requestTelegram('answerCallbackQuery', makeReqBody({
        callback_query_id: callbackQuery.id,
        text: '仅限管理员使用该按钮。',
        show_alert: false
      }));
    } catch (e) { }
    return sendMessage({ chat_id: callbackQuery.from.id, text: '仅限管理员使用该按钮。' });
  }

  // 判断当前是否在群组话题中
  const isGroupMode = (currentMode === 'group' && groupChatId && String(message.chat.id) === String(groupChatId));
  const targetChatId = isGroupMode ? message.chat.id : ADMIN_UID;
  const targetThreadId = isGroupMode ? message.message_thread_id : undefined;

  const parts2 = data.split('_');
  const action2 = parts2[0];
  const uid = parts2.slice(1).join('_');
  let answered = false;

  try {
    switch (action2) {
      case 'select': {
        const selectedChatId = uid;
        const userInfo = await getUserInfo(selectedChatId);
        const namePlain = userInfo ? `${userInfo.first_name || ''} ${userInfo.last_name || ''}`.trim() : `UID:${selectedChatId}`;
        if (currentChatTarget !== selectedChatId) {
          currentChatTarget = selectedChatId;
          chatTargetUpdated = true;
          await saveRecentChatTargets(selectedChatId);
          await setCurrentChatTarget(selectedChatId);
          chatSessions[ADMIN_UID] = { target: selectedChatId, timestamp: Date.now() };
          await saveChatSession();
          const confirmationText = `已选择当前聊天目标：${namePlain}${selectedChatId}`;
          const sendOpts = { chat_id: targetChatId, text: confirmationText };
          if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
          if (message && message.message_id) sendOpts.reply_to_message_id = message.message_id;
          await sendMessage(sendOpts);
          if (pendingMessage) {
            try {
              if (pendingMessage.text) {
                await sendMessage({ chat_id: currentChatTarget, text: pendingMessage.text });
              } else {
                // 任何非文本消息都使用 copyMessage 转发
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
          const confirmationText = `已选择当前聊天目标：${namePlain}${selectedChatId}`;
          const sendOpts = { chat_id: targetChatId, text: confirmationText };
          if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
          if (message && message.message_id) sendOpts.reply_to_message_id = message.message_id;
          await sendMessage(sendOpts);
        }
        break;
      }
      case 'search': {
        const searchId = uid;
        const userInfo = await getChat(searchId);
        let text;
        if (userInfo) {
          const nickname = `${userInfo.first_name || ''} ${userInfo.last_name || ''}`.trim();
          text = `UID: ${searchId}, 昵称: ${nickname}`;
        } else {
          text = `无法找到 UID: ${searchId} 的用户信息`;
        }
        const sendOpts = { chat_id: targetChatId, text };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'block': {
        const guestChatId = uid;
        if (String(guestChatId) === ADMIN_UID) {
          await sendMessage({ chat_id: targetChatId, text: '不能屏蔽自己', ...(targetThreadId ? { message_thread_id: targetThreadId } : {}) });
          break;
        }
        const userInfo = await getUserInfo(guestChatId);
        const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
        await nfd.put('isblocked-' + guestChatId, true);
        if (!blockedUsers.includes(guestChatId)) {
          blockedUsers.push(guestChatId);
          await saveBlockedUsers();
        }
        const sendOpts = { chat_id: targetChatId, text: `用户 ${nickname} 已被屏蔽` };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'unblock': {
        const guestChatId = uid;
        const userInfo = await getUserInfo(guestChatId);
        const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
        await nfd.put('isblocked-' + guestChatId, false);
        const index = blockedUsers.indexOf(guestChatId);
        if (index > -1) {
          blockedUsers.splice(index, 1);
          await saveBlockedUsers();
        }
        const sendOpts = { chat_id: targetChatId, text: `用户 ${nickname} 已解除屏蔽` };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'checkblock': {
        const guestChatId = uid;
        let isBlocked = await nfd.get('isblocked-' + guestChatId, { type: "json" });
        const userInfo = await getUserInfo(guestChatId);
        const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${guestChatId}`;
        const sendOpts = { chat_id: targetChatId, text: `用户 ${nickname}` + (isBlocked ? ' 已被屏蔽' : ' 未被屏蔽') };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'fraud': {
        const fraudId = uid;
        let text;
        if (!localFraudList.includes(String(fraudId))) {
          localFraudList.push(String(fraudId));
          await saveFraudList();
          text = `已添加骗子ID: ${fraudId}`;
        } else {
          text = `骗子ID ${fraudId} 已存在`;
        }
        const sendOpts = { chat_id: targetChatId, text };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'unfraud': {
        const fraudId = uid;
        let text;
        const idx = localFraudList.indexOf(String(fraudId));
        if (idx > -1) {
          localFraudList.splice(idx, 1);
          await saveFraudList();
          text = `已移除骗子ID: ${fraudId}`;
        } else {
          text = `骗子ID ${fraudId} 不在本地列表中`;
        }
        const sendOpts = { chat_id: targetChatId, text };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'list': {
        let text;
        if (localFraudList.length === 0) {
          text = '本地没有骗子ID。';
        } else {
          const fraudListText = await Promise.all(localFraudList.map(async uid => {
            const userInfo = await searchUserByUID(uid);
            const nickname = userInfo ? `${userInfo.user.first_name} ${userInfo.user.last_name || ''}`.trim() : '未知';
            return `UID: ${uid}, 昵称: ${nickname}`;
          }));
          text = `本地骗子ID列表:\n${fraudListText.join('\n')}`;
        }
        const sendOpts = { chat_id: targetChatId, text };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'blocklist': {
        let text;
        if (blockedUsers.length === 0) {
          text = '没有被屏蔽的用户。';
        } else {
          const blockedListText = await Promise.all(blockedUsers.map(async (uid, index) => {
            const userInfo = await getUserInfo(uid);
            const nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : '未知';
            return `${index + 1}. UID: ${uid}, 昵称: ${nickname}`;
          }));
          text = `被屏蔽的用户列表:\n${blockedListText.join('\n')}`;
        }
        const sendOpts = { chat_id: targetChatId, text };
        if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
        await sendMessage(sendOpts);
        break;
      }
      case 'end': {
        const targetUid = uid;                // 用户 ID
        const chatId = message.chat.id;       // 群组 ID
        const topicId = message.message_thread_id; // 当前话题 ID

        if (!topicId) {
          await sendMessage({
            chat_id: chatId,
            text: '无法获取话题 ID，请确认消息是否位于话题中。'
          });
          break;
        }

        // 调用 Telegram API 删除话题
        const delRes = await requestTelegram('deleteForumTopic', makeReqBody({
          chat_id: chatId,
          message_thread_id: topicId
        }));

        if (delRes.ok) {
          // 清理 KV 中的映射
          await nfd.delete('user_topic_' + targetUid);      // 用户 -> 话题
          await nfd.delete('topic_user_' + topicId);        // 话题 -> 用户
          await nfd.delete('topic_initialized_' + topicId); // 话题初始化标记

          // 可选：删除原来的管理按钮消息
          try {
            await requestTelegram('deleteMessage', makeReqBody({
              chat_id: chatId,
              message_id: message.message_id
            }));
          } catch (e) {
            console.warn('[deleteMessage] 删除原消息失败', e);
          }
          // 注意：不再发送私聊通知
        } else {
          await sendMessage({
            chat_id: chatId,
            text: `删除话题失败: ${JSON.stringify(delRes)}`
          });
        }
        break;
      }
      case 'cancel': {
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
          let text;
          if (currentChatTarget && String(currentChatTarget) === String(uid)) {
            currentChatTarget = null;
            try {
              await nfd.delete('currentChatTarget');
            } catch (e) {
              console.warn('[onCallbackQuery][cancel] delete currentChatTarget from KV failed', e);
            }
            text = `已取消选择并清空当前聊天目标：${namePlain}${uid}`;
          } else {
            text = `已取消选择：${namePlain}${uid}，当前聊天目标保持不变。`;
          }
          const sendOpts = { chat_id: targetChatId, text };
          if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
          await sendMessage(sendOpts);
        } catch (e) {
          console.error('[onCallbackQuery][cancel] overall failed', e);
          pendingMessage = null;
          const sendOpts = { chat_id: targetChatId, text: `已取消操作（UID: ${uid}）。` };
          if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
          await sendMessage(sendOpts);
        }
        break;
      }
      default:
        await sendMessage({ chat_id: targetChatId, text: `未知操作: ${action2}`, ...(targetThreadId ? { message_thread_id: targetThreadId } : {}) });
        break;
    }
  } catch (err) {
    console.error('[onCallbackQuery] handler error', err);
    const sendOpts = { chat_id: targetChatId, text: `处理回调出错: ${err && err.message ? err.message : err}` };
    if (targetThreadId) sendOpts.message_thread_id = targetThreadId;
    await sendMessage(sendOpts);
  }

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

async function getCurrentChatTarget() {
  const session = await nfd.get('currentChatTarget', { type: 'json' });
  if (session) {
    const elapsed = Date.now() - session.timestamp;
    if (elapsed < 30 * 60 * 1000) {
      return session.target;
    } else {
      await nfd.delete('currentChatTarget');
    }
  }
  return null;
}

async function setCurrentChatTarget(target) {
  const session = {
    target: target,
    timestamp: Date.now()
  };
  await nfd.put('currentChatTarget', JSON.stringify(session));
}

async function handleNotify(message) {
  let chatId = message.chat.id;
  if (await isFraud(chatId)) {
    return sendMessage({
      chat_id: ADMIN_UID,
      parse_mode: 'Markdown',
      text: `*请注意对方是骗子*！！ \n UID: ${chatId}`
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
