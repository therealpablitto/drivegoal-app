import { Telegraf, Scenes, session } from 'telegraf';
import { prisma } from './prisma.service';
import { suggestSubcategories, analyzeEntry, generateWeeklyReport } from './ai.service';
import { updateStreak } from './streak.service';

// ─── Types ──────────────────────────────────────────────────────────────────

interface WizardState {
  goalTitle?: string;
  suggestedSubcategories?: Array<{
    name: string;
    emoji: string;
    weight: number;
    color: string;
    description: string;
  }>;
}

type BotContext = Scenes.WizardContext & {
  wizard: Scenes.WizardContext['wizard'] & { state: WizardState };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function findOrCreateUser(telegramId: string, firstName?: string, username?: string) {
  const existing = await prisma.user.findUnique({ where: { telegramId } });
  if (existing) return existing;
  return prisma.user.create({ data: { telegramId, firstName, username } });
}

function progressBar(percent: number, length = 20): string {
  const filled = Math.round((Math.min(percent, 100) / 100) * length);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, length - filled));
}

function trendLabel(trend: string): string {
  if (trend === 'improving') return '📈 растёт';
  if (trend === 'declining') return '📉 снижается';
  return '➡️ стабильно';
}

// ─── Onboarding Wizard ───────────────────────────────────────────────────────

const onboardingWizard = new Scenes.WizardScene<BotContext>(
  'onboarding',

  // Step 0 — приветствие + запрос цели
  async (ctx) => {
    const name = ctx.from?.first_name || 'друг';
    await ctx.reply(
      `Привет, ${name}! 👋\n\n` +
      `Я Drive — AI-трекер большой цели.\n\n` +
      `Каждый день пишешь что сделал → AI анализирует → видишь реальный прогресс.\n\n` +
      `Напиши свою большую цель 👇\n\n` +
      `_Например: "Купить машину за 800 000 ₽" или "Запустить стартап за год"_`,
      { parse_mode: 'Markdown' }
    );
    return ctx.wizard.next();
  },

  // Step 1 — получаем цель, AI предлагает подкатегории
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) {
      await ctx.reply('Напиши текстом свою цель 👇');
      return;
    }

    const goalTitle = ctx.message.text.trim();
    if (goalTitle.length < 5) {
      await ctx.reply('Слишком коротко — опиши цель подробнее 👇');
      return;
    }

    ctx.wizard.state.goalTitle = goalTitle;
    await ctx.reply('⏳ AI анализирует цель...');

    try {
      const subs = await suggestSubcategories(goalTitle);
      ctx.wizard.state.suggestedSubcategories = subs;

      const subsText = subs
        .map((s) => `${s.emoji} *${s.name}* — ${s.description}`)
        .join('\n');

      await ctx.reply(
        `🎯 Цель: *${goalTitle}*\n\n` +
        `AI предлагает трекать:\n\n${subsText}\n\nПодходит?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [['✅ Да, подходит!'], ['🔄 Придумай другие']],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      );
    } catch (e) {
      console.error('[Bot] AI error in onboarding:', e);
      await ctx.reply('Ошибка AI. Попробуй заново — /start');
      return ctx.scene.leave();
    }

    return ctx.wizard.next();
  },

  // Step 2 — подтверждение, создание цели
  async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;

    const text = ctx.message.text;

    if (text.includes('Придумай другие') || text.includes('🔄')) {
      await ctx.reply('⏳ Генерирую другие варианты...');
      try {
        const subs = await suggestSubcategories(ctx.wizard.state.goalTitle! + ' — альтернативные направления');
        ctx.wizard.state.suggestedSubcategories = subs;
        const subsText = subs.map((s) => `${s.emoji} *${s.name}* — ${s.description}`).join('\n');
        await ctx.reply(
          `Вот другие варианты:\n\n${subsText}\n\nПодходит?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              keyboard: [['✅ Да, подходит!'], ['🔄 Придумай другие']],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          }
        );
        return; // остаёмся на этом шаге
      } catch (e) {
        await ctx.reply('Ошибка AI. Используем предыдущий вариант — нажми ✅');
        return;
      }
    }

    // Создаём пользователя, цель, подкатегории
    const telegramId = ctx.from!.id.toString();
    const user = await findOrCreateUser(telegramId, ctx.from?.first_name, ctx.from?.username);

    await prisma.goal.updateMany({
      where: { userId: user.id },
      data: { isActive: false },
    });

    const goal = await prisma.goal.create({
      data: { userId: user.id, title: ctx.wizard.state.goalTitle! },
    });

    await prisma.subcategory.createMany({
      data: (ctx.wizard.state.suggestedSubcategories || []).map((s) => ({
        goalId: goal.id,
        name: s.name,
        emoji: s.emoji,
        weight: s.weight,
        color: s.color,
      })),
    });

    const subsLine = (ctx.wizard.state.suggestedSubcategories || [])
      .map((s) => `${s.emoji} ${s.name}`)
      .join('  ');

    await ctx.reply(
      `✅ Цель создана!\n\n` +
      `🎯 *${ctx.wizard.state.goalTitle}*\n` +
      `Направления: ${subsLine}\n\n` +
      `Теперь каждый день просто напиши мне *что сделал* — я проанализирую прогресс.\n\n` +
      `📊 /stats — прогресс\n` +
      `📋 /report — недельный отчёт\n` +
      `❓ /help — помощь`,
      { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
    );

    return ctx.scene.leave();
  }
);

// ─── Bot ──────────────────────────────────────────────────────────────────────

export function startBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[Bot] TELEGRAM_BOT_TOKEN not set — bot disabled');
    return;
  }

  const bot = new Telegraf<BotContext>(token);
  const stage = new Scenes.Stage<BotContext>([onboardingWizard]);

  bot.use(session());
  bot.use(stage.middleware());

  // ── /start ──────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const telegramId = ctx.from.id.toString();
    const user = await prisma.user.findUnique({ where: { telegramId } });

    if (!user) return ctx.scene.enter('onboarding');

    const goal = await prisma.goal.findFirst({
      where: { userId: user.id, isActive: true },
    });

    if (!goal) return ctx.scene.enter('onboarding');

    const stats = await prisma.userStats.findUnique({ where: { userId: user.id } });
    const name = ctx.from.first_name || 'друг';

    if (!stats) {
      await ctx.reply(
        `С возвращением, ${name}! 👋\n\n` +
        `🎯 *${goal.title}*\n\n` +
        `Записей пока нет. Напиши что сделал сегодня 👇`,
        { parse_mode: 'Markdown' }
      );
    } else {
      const bar = progressBar(stats.progressPercent);
      await ctx.reply(
        `С возвращением, ${name}! 👋\n\n` +
        `🎯 *${goal.title}*\n\n` +
        `Прогресс: *${stats.progressPercent}%*\n` +
        `[${bar}]\n\n` +
        `🔥 Стрик: *${stats.currentStreak}* дн.  📅 Записей: ${stats.totalEntries}\n\n` +
        `Напиши что сделал сегодня 👇`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ── /stats ──────────────────────────────────────────────────────────────────
  bot.command('stats', async (ctx) => {
    const telegramId = ctx.from.id.toString();
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return ctx.scene.enter('onboarding');

    const goal = await prisma.goal.findFirst({
      where: { userId: user.id, isActive: true },
      include: { subcategories: true },
    });
    if (!goal) return ctx.scene.enter('onboarding');

    const stats = await prisma.userStats.findUnique({ where: { userId: user.id } });
    if (!stats) return ctx.reply('Записей ещё нет. Напиши что сделал сегодня!');

    const entries = await prisma.entry.findMany({
      where: { userId: user.id, goalId: goal.id },
      orderBy: { date: 'desc' },
      take: 7,
    });

    const bar = progressBar(stats.progressPercent);
    const lastEntriesText = entries.length > 0
      ? entries
          .map((e) => {
            const day = new Date(e.date).toLocaleDateString('ru', {
              weekday: 'short', day: 'numeric', month: 'short',
            });
            const mini = progressBar(e.totalScore, 10);
            return `${day}: [${mini}] ${Math.round(e.totalScore)}`;
          })
          .join('\n')
      : 'Нет записей';

    await ctx.reply(
      `📊 *Статистика*\n\n` +
      `🎯 ${goal.title}\n\n` +
      `Прогресс: *${stats.progressPercent}%*\n` +
      `[${bar}]\n\n` +
      `🔥 Стрик: *${stats.currentStreak}* дн. (рекорд: ${stats.longestStreak})\n` +
      `📅 Всего записей: ${stats.totalEntries}\n\n` +
      `*Последние 7 дней:*\n${lastEntriesText}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── /report ─────────────────────────────────────────────────────────────────
  bot.command('report', async (ctx) => {
    const telegramId = ctx.from.id.toString();
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return ctx.scene.enter('onboarding');

    const goal = await prisma.goal.findFirst({
      where: { userId: user.id, isActive: true },
      include: { subcategories: true },
    });
    if (!goal) return ctx.scene.enter('onboarding');

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const entries = await prisma.entry.findMany({
      where: { userId: user.id, goalId: goal.id, date: { gte: weekAgo } },
      include: { entryScores: { include: { subcategory: true } } },
      orderBy: { date: 'asc' },
    });

    if (entries.length === 0) {
      return ctx.reply('За последнюю неделю нет записей. Начни трекать прогресс!');
    }

    await ctx.reply('⏳ Генерирую недельный отчёт...');

    try {
      const summary = entries.map((e) => ({
        date: new Date(e.date).toLocaleDateString('ru'),
        totalScore: e.totalScore,
        topCategories: e.entryScores
          .filter((s) => s.score >= 5)
          .map((s) => s.subcategory.name),
      }));

      const report = await generateWeeklyReport(goal.title, summary);

      await ctx.reply(
        `📋 *Недельный отчёт*\n\n` +
        `${report.summary}\n\n` +
        `${trendLabel(report.trend)}\n` +
        `💪 Лучшее направление: *${report.topCategory}*\n` +
        `📉 Слабое направление: *${report.weakCategory}*\n\n` +
        `*Инсайты:*\n${report.insights.map((i) => `• ${i}`).join('\n')}\n\n` +
        `🎯 *На следующую неделю:*\n${report.nextWeekFocus}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error('[Bot] Report error:', e);
      await ctx.reply('Ошибка при генерации отчёта. Попробуй позже.');
    }
  });

  // ── /newgoal ────────────────────────────────────────────────────────────────
  bot.command('newgoal', async (ctx) => {
    return ctx.scene.enter('onboarding');
  });

  // ── /help ───────────────────────────────────────────────────────────────────
  bot.help((ctx) => {
    ctx.reply(
      `📖 *Как пользоваться Drive*\n\n` +
      `Просто пиши каждый день что сделал — AI анализирует прогресс автоматически.\n\n` +
      `*Команды:*\n` +
      `/stats — прогресс и статистика\n` +
      `/report — недельный AI-отчёт\n` +
      `/newgoal — поставить новую цель\n` +
      `/help — эта справка\n\n` +
      `🔥 Главный мотиватор — не прерывай стрик!`,
      { parse_mode: 'Markdown' }
    );
  });

  // ── Текстовые сообщения → дневная запись ─────────────────────────────────
  bot.on('text', async (ctx) => {
    const telegramId = ctx.from.id.toString();
    const user = await prisma.user.findUnique({ where: { telegramId } });
    if (!user) return ctx.scene.enter('onboarding');

    const goal = await prisma.goal.findFirst({
      where: { userId: user.id, isActive: true },
      include: { subcategories: true },
    });
    if (!goal) return ctx.scene.enter('onboarding');

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return; // пропускаем команды

    if (text.length < 10) {
      return ctx.reply('Расскажи подробнее — что именно сделал сегодня? 👇');
    }

    await ctx.reply('⏳ AI анализирует запись...');

    try {
      const subcategoryNames = goal.subcategories.map((s) => s.name);
      const analysis = await analyzeEntry(text, goal.title, subcategoryNames);

      // Сохраняем запись (upsert — один раз в день)
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const entry = await prisma.entry.upsert({
        where: { userId_goalId_date: { userId: user.id, goalId: goal.id, date: today } },
        create: {
          userId: user.id,
          goalId: goal.id,
          rawText: text,
          date: today,
          totalScore: analysis.totalScore,
          aiComment: analysis.overallComment,
        },
        update: {
          rawText: text,
          totalScore: analysis.totalScore,
          aiComment: analysis.overallComment,
        },
      });

      // Сохраняем баллы по подкатегориям
      await prisma.entryScore.deleteMany({ where: { entryId: entry.id } });
      for (const sub of analysis.subcategories) {
        const subcategory = goal.subcategories.find((s) => s.name === sub.name);
        if (!subcategory) continue;
        await prisma.entryScore.create({
          data: {
            entryId: entry.id,
            subcategoryId: subcategory.id,
            score: sub.score,
            actions: sub.actions,
            aiComment: sub.comment,
          },
        });
      }

      // Обновляем стрик
      const streak = await updateStreak(user.id, goal.id, today, analysis.totalScore);

      // Формируем ответ
      const scoreBar = progressBar(analysis.totalScore, 15);
      const scoresText = analysis.subcategories
        .map((s) => {
          const sub = goal.subcategories.find((gs) => gs.name === s.name);
          const mini = progressBar(s.score * 10, 8);
          return `${sub?.emoji || '•'} ${s.name}: [${mini}] ${s.score}/10`;
        })
        .join('\n');

      const streakMsg =
        streak.isNew && streak.currentStreak > 1
          ? `\n\n🔥 Стрик: *${streak.currentStreak}* дней подряд!`
          : streak.currentStreak === 1
          ? `\n\n✅ Запись добавлена`
          : '';

      await ctx.reply(
        `📊 *Анализ дня*\n\n` +
        `Балл: *${Math.round(analysis.totalScore)}/100*\n` +
        `[${scoreBar}]\n\n` +
        `${scoresText}\n\n` +
        `💬 ${analysis.overallComment}` +
        streakMsg,
        { parse_mode: 'Markdown' }
      );

      if (analysis.suggestions.length > 0) {
        await ctx.reply(
          `💡 *Рекомендации:*\n${analysis.suggestions.map((s) => `• ${s}`).join('\n')}`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      console.error('[Bot] Entry analysis error:', e);
      await ctx.reply('Ошибка при анализе. Попробуй ещё раз или напиши /help');
    }
  });

  // ── Ошибки ──────────────────────────────────────────────────────────────────
  bot.catch((err) => {
    console.error('[Bot] Error:', err);
  });

  // ── Запуск ──────────────────────────────────────────────────────────────────
  console.log('[Bot] Starting @DriveGoal_bot (long polling)...');
  bot.launch({ dropPendingUpdates: true })
    .catch((err) => console.error('[Bot] Stopped with error:', err));
  console.log('[Bot] @DriveGoal_bot polling active ✅');
}
