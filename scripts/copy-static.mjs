// Kopiuje statyczne pliki interfejsu (HTML, CSS) do dist/public.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "public");
mkdirSync(out, { recursive: true });
for (const file of ["index.html", "styles.css"]) {
  cpSync(join(root, "src", "web", file), join(out, file));
}
