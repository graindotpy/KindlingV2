import { initializeDatabase } from "@/lib/db/client";
import { ensureDefaultUsers } from "@/lib/users/service";

const database = initializeDatabase();
ensureDefaultUsers();
database.close();
console.log("[kindling] Database migrations complete.");
