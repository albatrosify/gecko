import axios from 'axios';
import { getDb } from './db.ts';
import { log } from './logger.ts';

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
  enabled?: boolean;
}

/**
 * Retrieves the global Telegram configuration from SQLite settings.
 */
export async function getTelegramConfig(): Promise<TelegramConfig> {
  try {
    const db = getDb();
    const { settings } = await import('./schema.ts');
    const { eq } = await import('drizzle-orm');

    const doc = db.select().from(settings).where(eq(settings.id, 'global')).get();
    const extra = (doc?.extra as any) || {};

    return {
      botToken: extra.telegramBotToken || '',
      chatId: extra.telegramChatId || '',
      enabled: Boolean(extra.telegramEnabled),
    };
  } catch (err: any) {
    log(`[Telegram] Failed to load config: ${err.message}`);
    return { botToken: '', chatId: '', enabled: false };
  }
}

/**
 * Sends a notification message via Telegram Bot API.
 * Safely fails without throwing so callers don't crash if Telegram is down.
 */
export async function sendTelegramNotification(
  message: string,
  options: {
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
    botToken?: string;
    chatId?: string;
  } = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    const config = await getTelegramConfig();
    const token = (options.botToken || config.botToken)?.trim();
    const chat = (options.chatId || config.chatId)?.trim();
    const isEnabled = options.botToken ? true : config.enabled;

    if (!isEnabled) {
      return { success: false, error: 'Telegram notifications are disabled.' };
    }

    if (!token || !chat) {
      return { success: false, error: 'Telegram Bot Token or Chat ID is not configured.' };
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await axios.post(
      url,
      {
        chat_id: chat,
        text: message,
        parse_mode: options.parseMode || 'HTML',
        disable_web_page_preview: true,
      },
      { timeout: 10000 }
    );

    if (response.data && response.data.ok) {
      log(`[Telegram] Notification sent successfully to chat ${chat}`);
      return { success: true };
    } else {
      const errMsg = response.data?.description || 'Unknown Telegram API response';
      log(`[Telegram] Telegram API error: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  } catch (err: any) {
    const errMsg = err.response?.data?.description || err.message || 'Network error';
    log(`[Telegram] Failed to send notification: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * Sends a test notification to verify Telegram Bot credentials.
 */
export async function testTelegramNotification(
  botToken?: string,
  chatId?: string
): Promise<{ success: boolean; error?: string }> {
  const timestamp = new Date().toLocaleTimeString();
  const testMessage = `🦎 <b>Gecko IPTV - Test Benachrichtigung</b>\n\n` +
    `Die Telegram-Benachrichtigungen wurden erfolgreich eingerichtet!\n` +
    `Zeitstempel: <code>${timestamp}</code>`;

  return sendTelegramNotification(testMessage, {
    botToken,
    chatId,
    parseMode: 'HTML',
  });
}
