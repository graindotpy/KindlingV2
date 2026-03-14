import { createUsersRepository } from "@/lib/db/repositories/users";

const DEFAULT_USERS = [
  { name: "Mum", kindleEmail: null },
  { name: "Dad", kindleEmail: null },
  { name: "Adam", kindleEmail: null },
];

export class DuplicateLocalUserNameError extends Error {
  constructor(name: string) {
    super(`A household profile named "${name}" already exists.`);
    this.name = "DuplicateLocalUserNameError";
  }
}

export class LocalUserHasRequestsError extends Error {
  constructor(name: string, requestCount: number) {
    super(
      `You cannot delete ${name}'s profile because it still has ${requestCount} saved request${requestCount === 1 ? "" : "s"}.`,
    );
    this.name = "LocalUserHasRequestsError";
  }
}

export class LastLocalUserDeletionError extends Error {
  constructor() {
    super("Add another household profile before deleting this one.");
    this.name = "LastLocalUserDeletionError";
  }
}

function normalizeOptionalEmail(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.toLowerCase() : null;
}

function normalizeName(value: string) {
  return value.trim();
}

function normalizeLocalUserInput(input: { name: string; kindleEmail: string | null }) {
  return {
    name: normalizeName(input.name),
    kindleEmail: normalizeOptionalEmail(input.kindleEmail),
  };
}

function isDuplicateUserNameConstraintError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as { code?: unknown; message?: unknown };
  return (
    record.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof record.message === "string" &&
    record.message.includes("users.name")
  );
}

export function ensureDefaultUsers() {
  const usersRepository = createUsersRepository();
  return usersRepository.ensureMany(DEFAULT_USERS);
}

export function listLocalUsers() {
  ensureDefaultUsers();
  const usersRepository = createUsersRepository();
  return usersRepository.list();
}

export function getLocalUserById(userId: number) {
  ensureDefaultUsers();
  const usersRepository = createUsersRepository();
  return usersRepository.getById(userId);
}

export function createLocalUser(input: { name: string; kindleEmail: string | null }) {
  ensureDefaultUsers();
  const usersRepository = createUsersRepository();
  const normalized = normalizeLocalUserInput(input);
  const existing = usersRepository.findByName(normalized.name);

  if (existing) {
    throw new DuplicateLocalUserNameError(normalized.name);
  }

  try {
    return usersRepository.create(normalized);
  } catch (error) {
    if (isDuplicateUserNameConstraintError(error)) {
      throw new DuplicateLocalUserNameError(normalized.name);
    }

    throw error;
  }
}

export function updateLocalUser(
  userId: number,
  input: { name: string; kindleEmail: string | null },
) {
  ensureDefaultUsers();
  const usersRepository = createUsersRepository();
  const normalized = normalizeLocalUserInput(input);
  const existing = usersRepository.findByName(normalized.name);

  if (existing && existing.id !== userId) {
    throw new DuplicateLocalUserNameError(normalized.name);
  }

  try {
    return usersRepository.update(userId, normalized);
  } catch (error) {
    if (isDuplicateUserNameConstraintError(error)) {
      throw new DuplicateLocalUserNameError(normalized.name);
    }

    throw error;
  }
}

export function deleteLocalUser(userId: number) {
  ensureDefaultUsers();
  const usersRepository = createUsersRepository();
  const existing = usersRepository.getById(userId);

  if (!existing) {
    return null;
  }

  if (existing.requestCount > 0) {
    throw new LocalUserHasRequestsError(existing.name, existing.requestCount);
  }

  if (usersRepository.count() <= 1) {
    throw new LastLocalUserDeletionError();
  }

  return usersRepository.delete(userId) ? existing : null;
}
