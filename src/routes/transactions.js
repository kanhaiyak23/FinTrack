import { Router } from 'express';
import { accountsRepo, transactionsRepo } from '../models/store.js';
import { validateBody } from '../middleware/validate.js';
import { ApiError } from '../middleware/errors.js';

export const transactionsRouter = Router();

const TX_TYPES = ['income', 'expense'];

transactionsRouter.get('/', (req, res) => {
  const { accountId, category, from, to } = req.query;
  const transactions = transactionsRepo.listByUser(req.userId, { accountId, category, from, to });
  res.json({ transactions, count: transactions.length });
});

transactionsRouter.post(
  '/',
  validateBody([
    { field: 'accountId', type: 'string', required: true },
    { field: 'amount', type: 'number', required: true, min: 0.01 },
    { field: 'type', type: 'string', required: true, enum: TX_TYPES },
    { field: 'category', type: 'string', required: true },
    { field: 'note', type: 'string', required: false },
    { field: 'occurredAt', type: 'string', required: false },
  ]),
  (req, res, next) => {
    const { accountId, amount, type, category, note, occurredAt } = req.body;
    if (!accountsRepo.findById(accountId, req.userId)) {
      return next(new ApiError(404, 'Account not found'));
    }
    const transaction = transactionsRepo.create({
      userId: req.userId,
      accountId,
      amount,
      type,
      category,
      note,
      occurredAt,
    });
    res.status(201).json({ transaction });
  },
);

// Totals and a per-category breakdown over an optional date range.
transactionsRouter.get('/summary', (req, res) => {
  const { from, to } = req.query;
  const transactions = transactionsRepo.listByUser(req.userId, { from, to });

  const byCategory = {};
  let income = 0;
  let expense = 0;

  for (const tx of transactions) {
    if (tx.type === 'income') income += tx.amount;
    else expense += tx.amount;

    byCategory[tx.category] ??= { income: 0, expense: 0 };
    byCategory[tx.category][tx.type] += tx.amount;
  }

  const round = (n) => Number(n.toFixed(2));
  res.json({
    range: { from: from ?? null, to: to ?? null },
    totals: { income: round(income), expense: round(expense), net: round(income - expense) },
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [k, { income: round(v.income), expense: round(v.expense) }]),
    ),
  });
});

transactionsRouter.get('/:id', (req, res, next) => {
  const transaction = transactionsRepo.findById(req.params.id, req.userId);
  if (!transaction) return next(new ApiError(404, 'Transaction not found'));
  res.json({ transaction });
});

transactionsRouter.delete('/:id', (req, res, next) => {
  if (!transactionsRepo.remove(req.params.id, req.userId)) {
    return next(new ApiError(404, 'Transaction not found'));
  }
  res.status(204).end();
});
