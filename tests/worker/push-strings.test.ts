import { describe, expect, it } from 'vitest';
import { budgetText, monthlyText, reminderText, testText, weeklyText } from '../../src/worker/push/strings';

const NNBSP = ' ';
const MINUS = '−';

describe('notification texts', () => {
  it('reminder and test, in both languages', () => {
    expect(reminderText('en')).toEqual({ title: 'Anything spent today?', body: 'One sentence is enough.', log: 'Log now', skip: 'Skip today' });
    expect(reminderText('fr')).toEqual({ title: `Des dépenses aujourd’hui${NNBSP}?`, body: 'Une phrase suffit.', log: 'Noter', skip: 'Pas aujourd’hui' });
    expect(testText('en')).toEqual({ title: 'Notifications are on', body: 'This is how Tally will nudge you.' });
    expect(testText('fr').title).toBe('Notifications activées');
  });

  it('budget alerts at 50, 80 and 100%', () => {
    const base = { spentCents: 162_000, budgetCents: 200_000, currency: 'CHF', daysLeft: 17 };
    expect(budgetText('en', { ...base, threshold: 80 })).toEqual({ title: '80% of your budget', body: `1${NNBSP}620.00 of 2${NNBSP}000 CHF · 17 days left` });
    expect(budgetText('en', { ...base, threshold: 50 }).title).toBe('Halfway through your budget');
    expect(budgetText('en', { ...base, threshold: 100 }).title).toBe('Budget reached');
    expect(budgetText('fr', { ...base, threshold: 80 })).toEqual({ title: `80${NNBSP}% du budget`, body: `1${NNBSP}620.00 sur 2${NNBSP}000 CHF · 17 jours restants` });
    expect(budgetText('fr', { ...base, threshold: 50 }).title).toBe('La moitié du budget est atteinte');
    expect(budgetText('fr', { ...base, threshold: 100 }).title).toBe('Budget atteint');
    // A budget with cents keeps them; the last days of the month read naturally.
    expect(budgetText('en', { ...base, threshold: 50, budgetCents: 150_050, daysLeft: 1 }).body).toBe(`1${NNBSP}620.00 of 1${NNBSP}500.50 CHF · 1 day left`);
    expect(budgetText('en', { ...base, threshold: 50, daysLeft: 0 }).body).toBe(`1${NNBSP}620.00 of 2${NNBSP}000 CHF · last day of the month`);
    expect(budgetText('fr', { ...base, threshold: 50, daysLeft: 1 }).body).toMatch(/· 1 jour restant$/);
    expect(budgetText('fr', { ...base, threshold: 50, daysLeft: 0 }).body).toMatch(/· dernier jour du mois$/);
  });

  it('weekly summary: entries, or the change against the week before', () => {
    const week = { totalCents: 25_690, currency: 'CHF', count: 12, top: { name: 'Groceries', totalCents: 10_530 }, previousTotalCents: 0 };
    expect(weeklyText('en', week)).toEqual({ title: 'Last week: 256.90 CHF', body: 'Groceries led at 41% · 12 entries' });
    expect(weeklyText('en', { ...week, count: 1 }).body).toBe('Groceries led at 41% · 1 entry');
    expect(weeklyText('en', { ...week, previousTotalCents: 23_790 }).body).toBe('Groceries led at 41% · +8% vs the week before');
    expect(weeklyText('en', { ...week, previousTotalCents: 30_000 }).body).toBe(`Groceries led at 41% · ${MINUS}14% vs the week before`);
    expect(weeklyText('en', { ...week, previousTotalCents: 25_690 }).body).toBe('Groceries led at 41% · same as the week before');
    expect(weeklyText('en', { ...week, top: { name: null, totalCents: 10_530 } }).body).toBe('Other led at 41% · 12 entries');

    expect(weeklyText('fr', week)).toEqual({ title: `Semaine passée${NNBSP}: 256.90 CHF`, body: `Groceries en tête avec 41${NNBSP}% · 12 dépenses` });
    expect(weeklyText('fr', { ...week, count: 1 }).body).toBe(`Groceries en tête avec 41${NNBSP}% · 1 dépense`);
    expect(weeklyText('fr', { ...week, previousTotalCents: 23_790 }).body).toBe(`Groceries en tête avec 41${NNBSP}% · +8${NNBSP}% par rapport à la semaine d’avant`);
    expect(weeklyText('fr', { ...week, top: { name: null, totalCents: 10_530 } }).body).toMatch(/^Autre en tête/);
  });

  it('monthly report: against the budget, or with the entry count', () => {
    const month = { month: 9, totalCents: 128_460, currency: 'CHF', count: 38, top: { name: 'Groceries', totalCents: 41_230 }, budgetCents: 200_000 };
    expect(monthlyText('en', month)).toEqual({ title: `September: 1${NNBSP}284.60 CHF`, body: '64% of your budget · Groceries 412.30 led' });
    expect(monthlyText('en', { ...month, budgetCents: null }).body).toBe('Groceries 412.30 led · 38 entries');
    expect(monthlyText('en', { ...month, budgetCents: 0 }).body).toBe('Groceries 412.30 led · 38 entries');
    expect(monthlyText('en', { ...month, month: 12, currency: 'EUR' }).title).toBe(`December: 1${NNBSP}284.60 EUR`);

    expect(monthlyText('fr', month)).toEqual({ title: `Septembre${NNBSP}: 1${NNBSP}284.60 CHF`, body: `64${NNBSP}% du budget · Groceries en tête avec 412.30` });
    expect(monthlyText('fr', { ...month, budgetCents: null }).body).toBe('Groceries en tête avec 412.30 · 38 dépenses');
    expect(monthlyText('fr', { ...month, month: 8 }).title).toMatch(/^Août/);
  });

  it('puts a narrow no-break space before French punctuation, never a plain space', () => {
    const fr = [
      reminderText('fr').title,
      budgetText('fr', { threshold: 80, spentCents: 1, budgetCents: 2, currency: 'CHF', daysLeft: 3 }).title,
      weeklyText('fr', { totalCents: 100, currency: 'CHF', count: 1, top: { name: 'X', totalCents: 100 }, previousTotalCents: 50 }).title,
      weeklyText('fr', { totalCents: 100, currency: 'CHF', count: 1, top: { name: 'X', totalCents: 100 }, previousTotalCents: 50 }).body,
      monthlyText('fr', { month: 1, totalCents: 100, currency: 'CHF', count: 1, top: { name: 'X', totalCents: 100 }, budgetCents: 1000 }).title,
      monthlyText('fr', { month: 1, totalCents: 100, currency: 'CHF', count: 1, top: { name: 'X', totalCents: 100 }, budgetCents: 1000 }).body,
    ];
    for (const s of fr) {
      expect(s, s).not.toMatch(/ [:?!%]/);
      expect(s, s).toMatch(new RegExp(`${NNBSP}[:?!%]`));
    }
  });
});
