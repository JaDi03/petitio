// copy the static landing files next to the compiled server
import { cpSync } from "node:fs";

cpSync("server/landing", "dist/server/landing", { recursive: true });
