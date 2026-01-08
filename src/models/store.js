import { randomUUID } from 'node:crypto';

// In-memory data layer. Everything is keyed by id and scoped to a userId so the
// swap to a real database is a matter of reimplementing these functions.
const users = new Map();
const accounts = new Map();
const transactions = new Map();

const clone = (record) => ({ ...record });
const byUser = (map, userId) => [...map.values()].filter((r) => r.userId === userId).map(clone);

export const usersRepo = {
  create({ email, name, passwordHash }) {
    const user = { id: randomUUID(), email, name, passwordHash, createdAt: new Date().toISOString() };
    users.set(user.id, user);
    return clone(user);
  },
  findByEmail(email) {
    const found = [...users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase());
    return found ? clone(found) : null;
  },
  findById(id) {
    const found = users.get(id);
    return found ? clone(found) : null;
  },
};

export const accountsRepo = {
  create({ userId, name, type, currency, openingBalance }) {
    const account = {
      id: randomUUID(),
      userId,
      name,
      type,
      currency,
      openingBalance,
      createdAt: new Date().toISOString(),
    };
    accounts.set(account.id, account);
    return clone(account);
  },
  listByUser(userId) {
    return byUser(accounts, userId);
  },
  findById(id, userId) {
    const found = accounts.get(id);
    return found && found.userId === userId ? clone(found) : null;
  },
  remove(id, userId) {
    const found = accounts.get(id);
    if (!found || found.userId !== userId) return false;
    accounts.delete(id);
    for (const [txId, tx] of transactions) {
      if (tx.accountId === id) transactions.delete(txId);
    }
    return true;
  },
};

export const transactionsRepo = {
  create({ userId, accountId, amount, type, category, note, occurredAt }) {
    const tx = {
      id: randomUUID(),
      userId,
      accountId,
      amount,
      type,
      category,
      note: note ?? null,
      occurredAt: occurredAt ?? new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    transactions.set(tx.id, tx);
    return clone(tx);
  },
  listByUser(userId, { accountId, category, from, to } = {}) {
    return byUser(transactions, userId)
      .filter((tx) => (accountId ? tx.accountId === accountId : true))
      .filter((tx) => (category ? tx.category === category : true))
      .filter((tx) => (from ? tx.occurredAt >= from : true))
      .filter((tx) => (to ? tx.occurredAt <= to : true))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  },
  findById(id, userId) {
    const found = transactions.get(id);
    return found && found.userId === userId ? clone(found) : null;
  },
  remove(id, userId) {
    const found = transactions.get(id);
    if (!found || found.userId !== userId) return false;
    transactions.delete(id);
    return true;
  },
};
