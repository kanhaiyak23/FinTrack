import { Prisma } from '@prisma/client';

// Money leaves the API as a decimal STRING, never a JSON number. JSON numbers are
// IEEE-754 doubles, so a client parsing 12345678.91 can silently receive something
// else. Strings survive the round trip exactly (CLAUDE.md invariant 1).
export const toMoneyString = (value) =>
  value === null || value === undefined ? null : new Prisma.Decimal(value).toFixed(4);

export const toQuantityString = (value) =>
  value === null || value === undefined ? null : new Prisma.Decimal(value).toFixed(8);

// Parses client input into a Decimal, rejecting anything not finite. Accepts a string
// or a number, but a string is what a correct client should send.
export const toDecimal = (value) => new Prisma.Decimal(value);
