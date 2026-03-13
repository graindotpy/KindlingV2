import { ensureDefaultUsers } from "@/lib/users/service";

const users = ensureDefaultUsers();

console.log(`Seeded ${users.length} user(s): ${users.map((user) => user.name).join(", ")}`);
