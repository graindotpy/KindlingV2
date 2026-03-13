import { createUsersRepository } from "@/lib/db/repositories/users";

const DEFAULT_USERS = ["Mum", "Dad", "Adam"];

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
