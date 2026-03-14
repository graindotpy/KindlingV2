import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUsersRepository } from "@/lib/db/repositories/users";
import {
  createLocalUser,
  DuplicateLocalUserNameError,
  deleteLocalUser,
  LastLocalUserDeletionError,
  LocalUserHasRequestsError,
  updateLocalUser,
} from "@/lib/users/service";

vi.mock("@/lib/db/repositories/users", () => ({
  createUsersRepository: vi.fn(),
}));

const FIXED_TIME = "2026-03-14T12:00:00.000Z";

describe("createLocalUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes a new profile before writing it", () => {
    const createdUser = {
      id: 4,
      name: "Nina",
      kindleEmail: "nina@kindle.com",
      createdAt: FIXED_TIME,
      requestCount: 0,
    };
    const repository = {
      ensureMany: vi.fn(),
      findByName: vi.fn(() => null),
      create: vi.fn(() => createdUser),
    };

    vi.mocked(createUsersRepository).mockReturnValue(repository as never);

    expect(
      createLocalUser({
        name: "  Nina  ",
        kindleEmail: "NINA@KINDLE.COM",
      }),
    ).toEqual(createdUser);
    expect(repository.create).toHaveBeenCalledWith({
      name: "Nina",
      kindleEmail: "nina@kindle.com",
    });
  });

  it("rejects duplicate names before creating the profile", () => {
    const repository = {
      ensureMany: vi.fn(),
      findByName: vi.fn(() => ({
        id: 1,
        name: "Mum",
        kindleEmail: null,
        createdAt: FIXED_TIME,
        requestCount: 0,
      })),
      create: vi.fn(),
    };

    vi.mocked(createUsersRepository).mockReturnValue(repository as never);

    expect(() =>
      createLocalUser({
        name: " Mum ",
        kindleEmail: null,
      }),
    ).toThrowError(new DuplicateLocalUserNameError("Mum"));
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe("updateLocalUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects duplicate household names before writing to the database", () => {
    const repository = {
      ensureMany: vi.fn(),
      findByName: vi.fn(() => ({
        id: 1,
        name: "Mum",
        kindleEmail: null,
        createdAt: FIXED_TIME,
        requestCount: 0,
      })),
      update: vi.fn(),
    };

    vi.mocked(createUsersRepository).mockReturnValue(repository as never);

    expect(() =>
      updateLocalUser(2, {
        name: "  Mum  ",
        kindleEmail: null,
      }),
    ).toThrowError(new DuplicateLocalUserNameError("Mum"));
    expect(repository.ensureMany).toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("allows updating the existing profile and normalizes the Kindle email", () => {
    const updatedUser = {
      id: 1,
      name: "mum",
      kindleEmail: "mum@kindle.com",
      createdAt: FIXED_TIME,
      requestCount: 0,
    };
    const repository = {
      ensureMany: vi.fn(),
      findByName: vi.fn(() => ({
        id: 1,
        name: "Mum",
        kindleEmail: null,
        createdAt: FIXED_TIME,
        requestCount: 0,
      })),
      update: vi.fn(() => updatedUser),
    };

    vi.mocked(createUsersRepository).mockReturnValue(repository as never);

    expect(
      updateLocalUser(1, {
        name: " mum ",
        kindleEmail: "MUM@KINDLE.COM",
      }),
    ).toEqual(updatedUser);
    expect(repository.update).toHaveBeenCalledWith(1, {
      name: "mum",
      kindleEmail: "mum@kindle.com",
    });
  });
});

describe("deleteLocalUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prevents deleting a profile that still has requests", () => {
    const repository = {
      ensureMany: vi.fn(),
      getById: vi.fn(() => ({
        id: 1,
        name: "Mum",
        kindleEmail: null,
        createdAt: FIXED_TIME,
        requestCount: 2,
      })),
      count: vi.fn(() => 3),
      delete: vi.fn(),
    };

    vi.mocked(createUsersRepository).mockReturnValue(repository as never);

    expect(() => deleteLocalUser(1)).toThrowError(
      new LocalUserHasRequestsError("Mum", 2),
    );
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it("prevents deleting the last remaining profile", () => {
    const repository = {
      ensureMany: vi.fn(),
      getById: vi.fn(() => ({
        id: 1,
        name: "Mum",
        kindleEmail: null,
        createdAt: FIXED_TIME,
        requestCount: 0,
      })),
      count: vi.fn(() => 1),
      delete: vi.fn(),
    };

    vi.mocked(createUsersRepository).mockReturnValue(repository as never);

    expect(() => deleteLocalUser(1)).toThrowError(new LastLocalUserDeletionError());
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it("deletes a profile when it has no requests and others still exist", () => {
    const user = {
      id: 2,
      name: "Dad",
      kindleEmail: null,
      createdAt: FIXED_TIME,
      requestCount: 0,
    };
    const repository = {
      ensureMany: vi.fn(),
      getById: vi.fn(() => user),
      count: vi.fn(() => 2),
      delete: vi.fn(() => true),
    };

    vi.mocked(createUsersRepository).mockReturnValue(repository as never);

    expect(deleteLocalUser(2)).toEqual(user);
    expect(repository.delete).toHaveBeenCalledWith(2);
  });
});
