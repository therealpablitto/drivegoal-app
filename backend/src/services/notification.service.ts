import cron from 'node-cron';
import { prisma } from './prisma.service';

/**
 * Сервис уведомлений.
 * MVP: отправляет напоминания через Telegram Bot API.
 * Если BOT_TOKEN не задан — логирует в консоль (dev-режим).
 */

async function sendTelegramMessage(telegramId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log(`[Notification] → @${telegramId}: ${text}`);
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramId,
      text,
      parse_mode: 'HTML',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[Notification] Failed to send to ${telegramId}: ${err}`);
  }
}

/**
 * Вечернее напоминание — каждый день в 21:00 по МСК (UTC+3 = 18:00 UTC)
 * Пишет только тем, у кого нет записи сегодня
 */
export function scheduleDailyReminder(): void {
  // 18:00 UTC = 21:00 MSK
  cron.schedule('0 18 * * *', async () => {
    console.log('[Cron] Running daily reminder...');

    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    try {
      // Пользователи с активной целью у которых нет записи сегодня
      const usersWithGoal = await prisma.user.findMany({
        where: {
          telegramId: { not: null },
          goals: { some: { isActive: true } },
        },
        include: {
          goals: {
            where: { isActive: true },
            take: 1,
          },
        },
      });

      for (const user of usersWithGoal) {
        if (!user.telegramId || !user.goals[0]) continue;

        const entry = await prisma.entry.findUnique({
          where: {
            userId_goalId_date: {
              userId: user.id,
              goalId: user.goals[0].id,
              date: today,
            },
          },
        });

        if (!entry) {
          const stats = await prisma.userStats.findUnique({
            where: { userId: user.id },
          });
          const streak = stats?.currentStreak ?? 0;
          const streakText = streak > 0 ? ` 🔥 Стрик: ${streak} дней` : '';

          const name = user.firstName || user.username || 'друг';
          const message =
            `Привет, ${name}! Как прошёл твой день?${streakText}\n\n` +
            `Напиши, что сделал сегодня для своей цели — это займёт 1 минуту 💪`;

          await sendTelegramMessage(user.telegramId, message);
        }
      }

      console.log('[Cron] Daily reminder done');
    } catch (err) {
      console.error('[Cron] Daily reminder error:', err);
    }
  });

  console.log('[Notification] Daily reminder scheduled (18:00 UTC / 21:00 MSK)');
}

/**
 * Еженедельный отчёт — каждое воскресенье в 10:00 МСК (07:00 UTC)
 */
export function scheduleWeeklyReport(): void {
  cron.schedule('0 7 * * 0', async () => {
    console.log('[Cron] Running weekly report...');

    try {
      const usersWithGoal = await prisma.user.findMany({
        where: {
          telegramId: { not: null },
          goals: { some: { isActive: true } },
        },
        include: {
          goals: { where: { isActive: true }, take: 1 },
        },
      });

      for (const user of usersWithGoal) {
        if (!user.telegramId || !user.goals[0]) continue;

        const stats = await prisma.userStats.findUnique({ where: { userId: user.id } });
        if (!stats || stats.totalEntries === 0) continue;

        const name = user.firstName || user.username || 'друг';
        const streak = stats.currentStreak;
        const progress = stats.progressPercent.toFixed(0);

        const message =
          `📊 <b>Итоги недели, ${name}!</b>\n\n` +
          `📈 Прогресс к цели: <b>${progress}%</b>\n` +
          `🔥 Текущий стрик: <b>${streak} дней</b>\n` +
          `📝 Всего записей: <b>${stats.totalEntries}</b>\n\n` +
          `Открой приложение, чтобы увидеть полный AI-анализ недели 👇`;

        await sendTelegramMessage(user.telegramId, message);
      }

      console.log('[Cron] Weekly report done');
    } catch (err) {
      console.error('[Cron] Weekly report error:', err);
    }
  });

  console.log('[Notification] Weekly report scheduled (07:00 UTC / 10:00 MSK, Sunday)');
}

/**
 * Milestone уведомление — вызывается вручную из других сервисов
 */
export async function sendMilestoneNotification(
  userId: string,
  milestone: number
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.telegramId) return;

  const messages: Record<number, string> = {
    25: '🎉 Ты прошёл 25% пути к своей цели! Первый квартал позади — так держать!',
    50: '🚀 Половина пути пройдена! Ты на середине дороги к своей цели. Не останавливайся!',
    75: '💥 75%! Финишная прямая. Ещё немного — и цель достигнута!',
    90: '🏁 90%! Ты почти у цели. Не сдавайся сейчас — ты так близко!',
  };

  const text = messages[milestone];
  if (!text) return;

  await sendTelegramMessage(user.telegramId, text);
}
