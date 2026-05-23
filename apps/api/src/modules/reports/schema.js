import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const isoMonth = z.string().regex(/^\d{4}-\d{2}$/, 'must be YYYY-MM');

export const dailyReportSchema = z.object({ date: isoDate.optional() });
export const monthlyReportSchema = z.object({ month: isoMonth.optional() });
