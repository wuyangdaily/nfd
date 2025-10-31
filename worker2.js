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
      let startMsg = "你可以用这个机器人跟我对话。写下您想要发送的消息（图片、视频），我会尽快回复您！";
      await setBotCommands();
      return sendMessage({
        chat_id: message.chat.id,
        text: startMsg,
      });
    } else if (command === '/help') {
      let helpMsg = "可用指令列表:\n" +
                    "/start - 启动机器人会话\n" +
                    "/help - 显示此帮助信息\n" +
                    "/search - 通过回复被转发的消息或 /search UID 查询用户昵称 (仅管理员)\n" +
                    "/fraud - 回复被转发的消息或 /fraud UID 添加骗子ID (仅管理员)\n" +
                    "/unfraud - 回复被转发的消息或 /unfraud UID 移除骗子ID (仅管理员)\n" +
                    "/block - 屏蔽用户 (仅管理员)\n" +
                    "/unblock - 解除屏蔽用户 (仅管理员)\n" +
                    "/checkblock - 检查用户是否被屏蔽 (仅管理员)\n" +
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
        return sendMessage({ chat_id: message.chat.id, text: '使用方法: 回复管理员收到的消息并输入 /search，或 /search <UID>' });
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
        return sendMessage({ chat_id: message.chat.id, text: '使用方法: 回复管理员收到的消息并输入 /fraud，或 /fraud <UID>' });
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
        return sendMessage({ chat_id: message.chat.id, text: '使用方法: 回复管理员收到的消息并输入 /unfraud，或 /unfraud <UID>' });
      }
    }
  } // end if command

  // 以下是管理员专用命令 - 以 /block, /unblock, /checkblock 为例（如果命令为回复消息触发）
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

  // 管理员消息处理（管理员可以直接私聊机器人并发送消息/媒体转发给目标用户）
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
        let nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${chatId}`;
        nickname = escapeMarkdown(nickname);
        const chatLink = `tg://user?id=${chatId}`;
        let messageText = `新的聊天目标: \n*${nickname}*\nUID: ${chatId}\n[点击不用bot直接私聊](${chatLink})`;
        if (await isFraud(chatId)) {
          messageText += `\n\n*请注意，对方是骗子!*`;
        }
        await sendMessage({
          chat_id: ADMIN_UID,
          parse_mode: 'MarkdownV2',
          text: messageText,
          ...generateKeyboard([{ text: `选择${nickname}`, callback_data: `select_${chatId}` }])
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

async function onCallbackQuery(callbackQuery) {
  const data = callbackQuery.data;
  const message = callbackQuery.message;

  // 权限检查：若需要限制 callback 的操作也可以用 isAdmin(callbackQuery.from.id)
  if (data.startsWith('select_')) {
    const selectedChatId = data.split('_')[1];
    if (currentChatTarget !== selectedChatId) {
      currentChatTarget = selectedChatId;
      chatTargetUpdated = true;
      await saveRecentChatTargets(selectedChatId);
      await setCurrentChatTarget(selectedChatId);
      const userInfo = await getUserInfo(selectedChatId);
      let nickname = userInfo ? `${userInfo.first_name} ${userInfo.last_name || ''}`.trim() : `UID:${selectedChatId}`;
      nickname = escapeMarkdown(nickname);
      const chatLink = userInfo.username ? `https://t.me/${userInfo.username}` : `tg://user?id=${selectedChatId}`;
      let messageText = `已切换到聊天目标:【 *${nickname}* ]\nuid：${selectedChatId}\n[点击不用bot直接私聊](${chatLink})`;
      if (await isFraud(selectedChatId)) {
        messageText += `\n\n*请注意，对方是骗子!*`;
      }
      await sendMessage({
        chat_id: ADMIN_UID,
        parse_mode: 'MarkdownV2',
        text: messageText
      });
      chatSessions[ADMIN_UID] = {
        target: selectedChatId,
        timestamp: Date.now()
      };
      await saveChatSession();
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
