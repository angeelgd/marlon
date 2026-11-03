import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
  plugins: [
    {
      // Los documentos de la base de conocimiento se importan como texto (igual que en wrangler).
      name: "markdown-as-text",
      transform(code, id) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
