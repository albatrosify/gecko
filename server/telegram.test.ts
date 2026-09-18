import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTelegramNotification, testTelegramNotification } from './telegram.ts';
import axios from 'axios';

vi.mock('axios');
vi.mock('./logger.ts', () => ({
  log: vi.fn(),
}));

// Mock db/schema
const mockSettings = {
  id: 'global',
  extra: {
    telegramBotToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
    telegramChatId: '987654321',
    telegramEnabled: true,
  },
};

vi.mock('./db.ts', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => mockSettings,
        }),
      }),
    }),
  }),
}));

describe('Telegram Notification Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.extra.telegramEnabled = true;
    mockSettings.extra.telegramBotToken = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
    mockSettings.extra.telegramChatId = '987654321';
  });

  it('sends a notification successfully when enabled', async () => {
    (axios.post as any).mockResolvedValueOnce({
      data: { ok: true, result: { message_id: 101 } },
    });

    const res = await sendTelegramNotification('Test Message');
    expect(res.success).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/sendMessage',
      {
        chat_id: '987654321',
        text: 'Test Message',
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      { timeout: 10000 }
    );
  });

  it('does not send notification when disabled', async () => {
    mockSettings.extra.telegramEnabled = false;

    const res = await sendTelegramNotification('Test Message');
    expect(res.success).toBe(false);
    expect(res.error).toContain('disabled');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('fails gracefully when token or chat id is missing', async () => {
    mockSettings.extra.telegramBotToken = '';

    const res = await sendTelegramNotification('Test Message');
    expect(res.success).toBe(false);
    expect(res.error).toContain('not configured');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('handles Telegram API error responses without crashing', async () => {
    (axios.post as any).mockResolvedValueOnce({
      data: { ok: false, description: 'Bad Request: chat not found' },
    });

    const res = await sendTelegramNotification('Test Message');
    expect(res.success).toBe(false);
    expect(res.error).toBe('Bad Request: chat not found');
  });

  it('handles network / axios errors safely', async () => {
    (axios.post as any).mockRejectedValueOnce({
      response: { data: { description: 'Unauthorized' } },
    });

    const res = await sendTelegramNotification('Test Message');
    expect(res.success).toBe(false);
    expect(res.error).toBe('Unauthorized');
  });

  it('sends test notification with explicit credentials', async () => {
    (axios.post as any).mockResolvedValueOnce({
      data: { ok: true },
    });

    const res = await testTelegramNotification('custom_token', 'custom_chat');
    expect(res.success).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.telegram.org/botcustom_token/sendMessage',
      expect.objectContaining({
        chat_id: 'custom_chat',
        text: expect.stringContaining('Gecko IPTV - Test Benachrichtigung'),
      }),
      { timeout: 10000 }
    );
  });
});
