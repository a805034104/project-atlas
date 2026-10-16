import { run } from "./main.js";

// Single-file build (Node SEA): process.argv = [executable, executable, ...user arguments].
void run(process.argv.slice(2));
