import { Prisma } from '@prisma/client';
import { transactionsService } from './service.js';

// A client's retry carries the same key. If two arrive concurrently, one loses the
// unique index race; that loser is a duplicate, not an error, so it is resolved to the
// winner's row rather than surfaced as a 409.
const handleIdempotencyRace = async (err, userId, accountId, idempotencyKey) => {
  const isDuplicate =
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && idempotencyKey;
  if (!isDuplicate) throw err;

  const existing = await transactionsService.findByKey(userId, accountId, idempotencyKey);
  if (!existing) throw err;
  return existing;
};

export const transactionsController = {
  async create(req, res) {
    const idempotencyKey = req.get('Idempotency-Key') ?? undefined;

    let result;
    try {
      result = await transactionsService.create(req.user.userId, req.body, idempotencyKey);
    } catch (err) {
      const recovered = await handleIdempotencyRace(
        err,
        req.user.userId,
        req.body.accountId,
        idempotencyKey,
      );
      result = { transaction: recovered, replayed: true };
    }

    // A replay returns 200 with the original resource: 201 would claim a second
    // transaction was created, which is precisely what idempotency prevented.
    res.status(result.replayed ? 200 : 201).json({
      transaction: result.transaction,
      ...(result.replayed ? { replayed: true } : {}),
    });
  },

  async list(req, res) {
    res.json(await transactionsService.list(req.user.userId, req.query));
  },

  async getById(req, res) {
    const transaction = await transactionsService.getById(req.params.id, req.user.userId);
    res.json({ transaction });
  },
};
