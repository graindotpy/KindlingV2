import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireApiSession } from "@/lib/auth";
import { DELETE as DELETE_USER, PATCH } from "@/app/api/users/[id]/route";
import { POST } from "@/app/api/users/route";
import {
  createLocalUser,
  deleteLocalUser,
  DuplicateLocalUserNameError,
  LocalUserHasRequestsError,
  updateLocalUser,
} from "@/lib/users/service";

vi.mock("@/lib/auth", () => ({
  requireApiSession: vi.fn(() => null),
}));

vi.mock("@/lib/bootstrap", () => ({
  ensureBackgroundServices: vi.fn(),
}));

vi.mock("@/lib/users/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/users/service")>(
    "@/lib/users/service",
  );

  return {
    ...actual,
    createLocalUser: vi.fn(),
    deleteLocalUser: vi.fn(),
    updateLocalUser: vi.fn(),
  };
});

describe("PATCH /api/users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireApiSession).mockReturnValue(null);
  });

  it("returns a friendly conflict when the requested profile name already exists", async () => {
    vi.mocked(updateLocalUser).mockImplementation(() => {
      throw new DuplicateLocalUserNameError("Mum");
    });

    const response = await PATCH(
      new Request("http://localhost/api/users/2", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Mum",
          kindleEmail: "",
        }),
      }),
      {
        params: Promise.resolve({ id: "2" }),
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      message: 'A household profile named "Mum" already exists.',
    });
  });
});

describe("POST /api/users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireApiSession).mockReturnValue(null);
  });

  it("returns a friendly conflict when the requested profile name already exists", async () => {
    vi.mocked(createLocalUser).mockImplementation(() => {
      throw new DuplicateLocalUserNameError("Mum");
    });

    const response = await POST(
      new Request("http://localhost/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Mum",
          kindleEmail: "",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      message: 'A household profile named "Mum" already exists.',
    });
  });
});

describe("DELETE /api/users/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireApiSession).mockReturnValue(null);
  });

  it("returns a friendly conflict when the profile still has saved requests", async () => {
    vi.mocked(deleteLocalUser).mockImplementation(() => {
      throw new LocalUserHasRequestsError("Mum", 2);
    });

    const response = await DELETE_USER(new Request("http://localhost/api/users/1"), {
      params: Promise.resolve({ id: "1" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      message: "You cannot delete Mum's profile because it still has 2 saved requests.",
    });
  });
});
