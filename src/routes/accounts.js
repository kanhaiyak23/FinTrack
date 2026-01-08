import { Router } from 'express';
import { accountsRepo, transactionsRepo } from '../models/store.js';
import { validateBody } from '../middleware/validate.js';
import { ApiError } from '../middleware/errors.js';

export const accountsRouter = Router();

const ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'cash', 'investment'];

// Opening balance plus every transaction booked against the account.
const withBalance = (account) => {
  const txs = transactionsRepo.listByUser(account.userId, { accountId: account.id });
  const balance = txs.reduce(
    (sum, tx) => (tx.type === 'income' ? sum + tx.amount : sum - tx.amount),
    account.openingBalance,
  );
  return { ...account, balance: Number(balance.toFixed(2)), transactionCount: txs.length };
};

accountsRouter.get('/', (req, res) => {
  const accounts = accountsRepo.listByUser(req.userId).map(withBalance);
  res.json({ accounts });
});

accountsRouter.post(
  '/',
  validateBody([
    { field: 'name', type: 'string', required: true },
    { field: 'type', type: 'string', required: true, enum: ACCOUNT_TYPES },
    { field: 'currency', type: 'string', required: false },
    { field: 'openingBalance', type: 'number', required: false },
  ]),
  (req, res) => {
    const { name, type, currency = 'INR', openingBalance = 0 } = req.body;
    const account = accountsRepo.create({ userId: req.userId, name, type, currency, openingBalance });
    res.status(201).json({ account: withBalance(account) });
  },
);

accountsRouter.get('/:id', (req, res, next) => {
  const account = accountsRepo.findById(req.params.id, req.userId);
  if (!account) return next(new ApiError(404, 'Account not found'));
  res.json({ account: withBalance(account) });
});

accountsRouter.delete('/:id', (req, res, next) => {
  // Deleting an account also drops its transactions - see accountsRepo.remove.
  if (!accountsRepo.remove(req.params.id, req.userId)) {
    return next(new ApiError(404, 'Account not found'));
  }
  res.status(204).end();
});
